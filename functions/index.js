/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.GCLOUD_PROJECT}.firebaseio.com`,
});

// Spotify OAuth 2 setup
const spotify = require('./spotify');




// Scopes to request.
const OAUTH_SCOPES = ['user-read-email'];

/**
 * Redirects the User to the Spotify authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
exports.redirect = functions.https.onRequest((req, res) => {
  cookieParser()(req, res, () => {
    const state = req.cookies.state || crypto.randomBytes(20).toString('hex');
    console.log('Setting verification state:', state);
    res.cookie('state', state.toString(), {maxAge: 3600000, secure: true, httpOnly: true});
    spotify.then(Spotify =>{
      console.log('This is the client id used in redirect ' + Spotify.getClientId());
      console.log('This is the client secret used in redirect ' + Spotify.getClientSecret());
      const authorizeURL = Spotify.createAuthorizeURL(OAUTH_SCOPES, state.toString());
      res.redirect(authorizeURL);
    })

  });
});

function removeWhiteSpaces(code){

    const regex = /[(\w)]+/g;
    let n;

    while ((n = regex.exec(code)) !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      if (n.index === regex.lastIndex) {
        regex.lastIndex++;
      }

      // The result can be accessed through the `n`-variable.
      n.forEach((match, groupIndex) => {

        console.log(`Found match, group ${groupIndex}: ${match}`);

      });
      console.log(`Found n,  ${n}`);
      return n;
    }



}

/**
 * Exchanges a given Spotify auth code passed in the 'code' URL query parameter for a Firebase auth token.
 * The request also needs to specify a 'state' query parameter which will be checked against the 'state' cookie.
 * The Firebase custom auth token is sent back in a JSONP callback function with function name defined by the
 * 'callback' query parameter.
 */
exports.token = functions.https.onRequest((req, res) => {
  try {

    cookieParser()(req, res, () => {
      console.log('Received verification state:', req.cookies.state);
      console.log('Received state:', req.query.state);
      if (!req.cookies.state) {
        throw new Error('State cookie not set or expired. Maybe you took too long to authorize. Please try again.');
      } else if (req.cookies.state !== req.query.state) {
        throw new Error('State validation failed');
      }
      console.log('Received auth code:', req.query.code);
      let code = removeWhiteSpaces(req.query.code);

      const spotify = require('./spotify');
      spotify.then(Spotify =>{
        console.log('This is the access token: ' + Spotify.getAccessToken());
        console.log('This is the client id: ' + Spotify.getClientId());
        console.log('This is the client secret: ' + Spotify.getClientSecret());
        console.log('This is the auth code: ' + code);
        Spotify.authorizationCodeGrant(code, (error, data) => {
          if (error) {
            console.log('foo');
            throw error;
          }
          console.log('Received Access Token:', data.body['access_token']);
          Spotify.setAccessToken(data.body['access_token']);

          Spotify.getMe(async (error, userResults) => {
            if (error) {
              console.log('bar');
              throw error;
            }
            console.log('Auth code exchange result received:', userResults);
            // We have a Spotify access token and the user identity now.
            const accessToken = data.body['access_token'];
            const spotifyUserID = userResults.body['id'];
            const profilePic = userResults.body['images'][0]['url'];
            const userName = userResults.body['display_name'];
            const email = userResults.body['email'];

            // Create a Firebase account and get the Custom Auth Token.
            const firebaseToken = await createFirebaseAccount(spotifyUserID, userName, profilePic, email, accessToken);
            // Serve an HTML page that signs the user in and updates the user profile.
            res.jsonp({token: firebaseToken});
          });
        });
      }).catch(err => {
        console.log('Spotify auth failed!', err);
      })
    });
  } catch (error) {
    return res.jsonp({error: error.toString});
  }
  return null;
});

/**
 * Creates a Firebase account with the given user profile and returns a custom auth token allowing
 * signing-in this account.
 * Also saves the accessToken to the datastore at /spotifyAccessToken/$uid
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
async function createFirebaseAccount(spotifyID, displayName, photoURL, email, accessToken) {
  // The UID we'll assign to the user.
  const uid = `spotify:${spotifyID}`;

  // Save the access token to the Firebase Realtime Database.
  const databaseTask = admin.database().ref(`/spotifyAccessToken/${uid}`).set(accessToken);

  // Create or update the user account.
  const userCreationTask = admin.auth().updateUser(uid, {
    displayName: displayName,
    photoURL: photoURL,
    email: email,
    emailVerified: true,
  }).catch((error) => {
    // If user does not exists we create it.
    if (error.code === 'auth/user-not-found') {
      return admin.auth().createUser({
        uid: uid,
        displayName: displayName,
        photoURL: photoURL,
        email: email,
        emailVerified: true,
      });
    }
    throw error;
  });

  // Wait for all async tasks to complete, then generate and return a custom auth token.
  await Promise.all([userCreationTask, databaseTask]);
  // Create a Firebase custom auth token.
  const token = await admin.auth().createCustomToken(uid);
  console.log('Created Custom token for UID "', uid, '" Token:', token);
  return token;
}

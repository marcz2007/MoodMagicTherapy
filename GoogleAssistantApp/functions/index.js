/**
 * Main class holding all the logic which matches the Google assistant application to the Firebase database
 * and the Spotify dashboard application. The application is formatted to reflect these three main parts with
 * response-requests to Spotify for authorisation and to make api function calls (within the dialogflow fulfillment
 * code towards the bottom of the class).
 * Author: Marcus Watts
 * Date Created: 01 July 2019
 */
'use strict';


/**
 * --------------------------- Google/Dialogflow/Firebase Setup ---------------------------
 * @type {{analytics; auth; crashlytics; database; firestore; https; pubsub; remoteConfig; storage; testLab; app: apps.Apps; Event: Event; EventContext: EventContext; Change: Change; ChangeJson: ChangeJson; Resource: Resource; TriggerAnnotated: TriggerAnnotated; Runnable: Runnable; HttpsFunction: HttpsFunction; CloudFunction: CloudFunction; MakeCloudFunctionArgs: MakeCloudFunctionArgs; makeCloudFunction; optionsToTrigger; config; firebaseConfig; region; runWith; FunctionBuilder: FunctionBuilder; SUPPORTED_REGIONS: readonly; MIN_TIMEOUT_SECONDS: number; MAX_TIMEOUT_SECONDS: number; VALID_MEMORY_OPTIONS: readonly; ScheduleRetryConfig: ScheduleRetryConfig; Schedule: Schedule; RuntimeOptions: RuntimeOptions; DeploymentOptions: DeploymentOptions}}
 */

// 	Modules being used
const functions = require('firebase-functions');
// Sets this file as the webhook for dialogflow filfillment
const {WebhookClient} = require('dialogflow-fulfillment');
// Used for storing the sign in data of the Spotify user
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.GCLOUD_PROJECT}.firebaseio.com`
});


/**
 * ----------------------Below section of code was found at the following repository, only credentials and OAUTH Scopes needed changing: https://github.com/firebase/functions-samples/tree/master/spotify-auth---------------------------------
 */
// Spotify OAuth 2 setup
const SpotifyWebApi = require('spotify-web-api-node');
const Spotify = new SpotifyWebApi({
    clientId: '372d1ba54cee421681dc46cfc6a2bd15',
    clientSecret: 'd55000a4c4d545a185611a4a9cb287fd',
    redirectUri: `https://${process.env.GCLOUD_PROJECT}.firebaseapp.com/popup.html`
});

// Scopes to request. (Added in all the possible scopes for the auth so that it is possible to do any action that the
// Spotify api will allow i.e maximum permissions granted)
const OAUTH_SCOPES = [
    'user-read-email',
    'app-remote-control',
    'streaming',
    'user-modify-playback-state',
    'playlist-read-private',
    'user-library-modify',
    'playlist-read-collaborative',
    'playlist-modify-private',
    'user-follow-modify',
    'user-read-currently-playing',
    'user-read-email',
    'user-library-read',
    'user-top-read',
    'playlist-modify-public',
    'user-follow-read',
    'user-read-playback-state',
    'user-read-recently-played'
];

/**
 * Redirects the User to the Spotify authentication consent screen. Also the 'state' cookie is set for later state
 * verification.
 */
exports.redirect = functions.https.onRequest((req, res) => {
    cookieParser()(req, res, () => {
        const state = req.cookies.state || crypto.randomBytes(20).toString('hex');
        console.log('Setting verification state:', state);
        res.cookie('state', state.toString(), {maxAge: 3600000, secure: true, httpOnly: true});
        const authorizeURL = Spotify.createAuthorizeURL(OAUTH_SCOPES, state.toString());
        res.redirect(authorizeURL);
    });
});


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
                throw new Error(
                    'State cookie not set or expired. Maybe you took too long to authorize. Please try again.'
                );
            } else if (req.cookies.state !== req.query.state) {
                throw new Error('State validation failed');
            }
            console.log('Received auth code:', req.query.code);
            Spotify.authorizationCodeGrant(req.query.code, (error, data) => {
                if (error) {
                    throw error;
                }
                /**
                 * Store the codes retained from the Authorization. (Added in the refresh token so that it can be used and set as appropriate to ensure
                 * the user is constantly connected to the Spotify api)
                 */
                console.log('Received Access Token:', data.body['access_token']);
                console.log('Received Refresh Token:', data.body['refresh_token']);
                Spotify.setAccessToken(data.body['access_token']);
                Spotify.setRefreshToken(data.body['refresh_token']);
                // setterForRefreshToken(data.body['refresh_token']);
                Spotify.getMe(async (error, userResults) => {
                    if (error) {
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
                    const firebaseToken = await createFirebaseAccount(
                        spotifyUserID,
                        userName,
                        profilePic,
                        email,
                        accessToken
                    );
                    // Serve an HTML page that signs the user in and updates the user profile.
                    res.jsonp({token: firebaseToken});
                });
            });
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
    const userCreationTask = admin
        .auth()
        .updateUser(uid, {
            displayName: displayName,
            photoURL: photoURL,
            email: email,
            emailVerified: true
        })
        .catch((error) => {
            // If user does not exists we create it.
            if (error.code === 'auth/user-not-found') {
                return admin.auth().createUser({
                    uid: uid,
                    displayName: displayName,
                    photoURL: photoURL,
                    email: email,
                    emailVerified: true
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

/**
 * ----------------- Classes for storing the refresh and access tokens which are attained at sign in:-----------------
 * used to create instance variables which can be accessible anywhere within the class
 */


// Instance variables store the refresh token
class Access {
    constructor(accessToken) {
        this.accessToken = accessToken;
    }
}


/**
 * ---------------------------Setter and Getter Functions for Spotify Auth URL--------------------------------
 */

function setterForUpdatedAccessToken(splitString) {
    Access.accessToken = splitString;
    console.log('This is the access token being set in setterForUpdatedAccessToken', Access.accessToken);
}

function getterForUpdatedAccessToken() {
    console.log('This is the access token being get in getterForUpdatedAccessToken', Access.accessToken);
    return JSON.stringify(Access.accessToken);
}

/**
 * -----------------------------Setters and SongInfo class which holds the class variables for the entire file. Useful for storing variables for later use-------------------*/

/**
 * Class for storing song information from Spotify api audio analysis retrievals:
 */
class SongInfo {
    constructor(tempo, key, mode, Spotify_uri, randomNumber, song, artist, maxEmotion, score, maxSentence, maxSentenceScore, just_uri, danceability, valence) {
        console.log('This is the tempo in the SongInfo constructor', SongInfo.tempo);
        this.tempo = tempo;
        this.key = key;
        this.mode = mode;
        this.Spotify_uri = Spotify_uri;
        this.randomNumber = randomNumber;
        this.song = song;
        this.artist = artist;
        this.maxEmotion = maxEmotion;
        this.maxSentence = maxSentence;
        this.maxSentenceScore = maxSentenceScore;
        this.just_uri = just_uri;
        this.danceability = danceability;
        this.valence = valence;

    }
}

/**
 * Setter for the song's tempo
 * @param tempo of the song
 */
function setTempo(tempo) {
    SongInfo.tempo = tempo;
    console.log('This is the tempo being set in the setTempo function', SongInfo.tempo);
}

/**
 * Setter for the song's key. This is later used to find the song's emotional meaning.
 * @param key of the song
 */
function setKey(key) {
    SongInfo.key = key;
    console.log('This is the key being set in the setTempo function', SongInfo.key);
}

/**
 * Setter for the song's mode
 * @param mode either major or minor
 */
function setMode(mode) {
    SongInfo.mode = mode;
    console.log('This is the mode being set in the setMode function', SongInfo.mode);
}

/**
 * Setter for the song's uri
 * @param uri
 */
function setSpotify_uri(uri) {
    SongInfo.Spotify_uri = uri;
    console.log('This is the Spotify uri being set in the setSpotify_uri function', SongInfo.Spotify_uri);
}

/**
 * Setter for the randomly generated number within the bounds of the emotion to be selected
 * @param randomNumber
 */
function setRandomNumber(randomNumber) {
    SongInfo.randomNumber = randomNumber;
    console.log('This is the randomNumber being set in the randomNumber function', SongInfo.randomNumber);
}

/**
 * Setter for the title of the song
 * @param song title
 */
function setSong(song) {
    SongInfo.song = song;
}

/**
 * Setter for the artist's name
 * @param artist name
 */
function setArtist(artist) {
    SongInfo.artist = artist;
}

/**
 * setter for the maximum emotion of the song
 * @param maxEmotion of the song
 */
function setMaxEmotion(maxEmotion) {
    SongInfo.maxEmotion = maxEmotion;
}

/**
 * Setter for the score of the emotion
 * @param score of song's emotion
 */
function setScore(score) {
    SongInfo.score = score;
}

/**
 * Setter for the maximum sentence
 * @param maxSentence for the maximum recorded emotion
 */
function setMaxSentence(maxSentence) {
    SongInfo.maxSentence = maxSentence;
}

/**
 * Setter for the max sentence's score
 * @param maxSentenceScore
 */
function setMaxSentenceScore(maxSentenceScore) {
    SongInfo.maxSentenceScore = maxSentenceScore;
}

/**
 * Setter for the song's uri after being extracted from the complete uri
 * @param just_uri showing song code
 */
function setJustUri(just_uri) {
    SongInfo.just_uri = just_uri;
}

/**
 * Danceability setter for the song's danceability score
 * @param danceability score - how danceable the song is
 */
function setDancability(danceability) {
    SongInfo.danceability = danceability;
}

/**
 * Setter for the song's valence - how positive/negative its melody is
 * @param valence of the song
 */
function setValence(valence) {
    SongInfo.valence = valence;
}

/**
 * ---------------------------Google Assistant Fulfillment----------------------------------------------------------------------------------------
 * Below is the dialogflow firebase fulfillment code which controls what happens when various intents happen:
 */

exports.dialogflowFirebaseFulfillment = functions.https.onRequest((request, response) => {
    const agent = new WebhookClient({request, response});


    /**
     * ------------------------Functions Used in Google Assistant Fulfillment-----------------------------------------------------/*
     */

    /**
     * Grammarify simply takes an emotion string and changes it to fit to the agent's sentence
     * @param emotion string
     * @returns {string} manipulated string
     */

    function grammarify(emotion) {
        if (emotion === 'confident') {
            return ' confident';
        } else if (emotion === 'joy') {
            return ' happy';
        } else if (emotion === 'sadness') {
            return ' sad';
        } else if (emotion === 'anger') {
            return ' angry';
        }

    }

    /**
     * Converts the sentiment score into the equivalent text
     * @param sentimentScore score of the sentiwordnet analysis
     * @returns converted score
     **/
    function POSAnalysisConverter(sentimentScore) {
        if (sentimentScore > 0) {
            return ' which I have analysed as being positive';
        } else if (sentimentScore < 0) {
            return ' which I have analysed as being negative';
        } else if (sentimentScore === 0) {
            return ' which I will now read ';
        } else {
            return ' which I will now read ';
        }
    }

    /**
     * function converts sentiment score into whether it is strongly certain or just moderately certain
     * @params sentimentScore
     * @returns extent of certainty
     * **/
    function watsonScoreAnalyser(sentimentScore) {
        if (sentimentScore < 0.75) {
            return ' a moderately ';
        } else if (sentimentScore >= 0.75) {
            return ' an extremely '
        }
    }

    /**
     * Used by all intents, this function 'speaks' the song recommendations to the user in additon to performing sentiwordanalysis on the top sentence
     * @params agent who speaks the words
     * **/

    function recommendASong(agent) {
        const sw = require('sentiword');

        let POSAnalysis = sw(SongInfo.maxSentence);
        console.log((POSAnalysis));
        console.log(POSAnalysis.sentiment);
        console.log(POSAnalysisConverter(POSAnalysis.sentiment));
        POSAnalysis = POSAnalysisConverter(POSAnalysis.sentiment);
        // Agent vocalises the retrieved song to the user
        agent.add(`I recommend ${SongInfo.song} by ${SongInfo.artist}. According to my lyrics analysis, those used in ${SongInfo.song} are mainly ${grammarify(SongInfo.maxEmotion)} with ${watsonScoreAnalyser(SongInfo.score)} high degree of certainty. The following extract, ${POSAnalysis}, was found to be the most ${grammarify(SongInfo.maxEmotion)} lyric in the entire song. I'll read it to you now, Ahem... ${SongInfo.maxSentence}... `);


        // updated access token;
        console.log('This is the updated access token used by spotify', `${Access.accessToken}`);
        Spotify.setAccessToken(`${Access.accessToken}`);


        console.log('This is the SongInfo.just_uri being used in the api call to spotify ' + SongInfo.just_uri);
        console.log('This is the SongInfo.Spotify_uri being used in the api call to spotify ' + SongInfo.Spotify_uri);

        agent.add(`Would you like to hear audio analysis of ${SongInfo.song}'s melody?`)

        // });
    }

    /**
     * Function sends post request to the Spotify api to get a new access token using the refresh token as the Oauth code.
     * Used by all the emotion intents to maintain a stable connection with spotify.
     * **/

    function getUpdatedAccessToken() {

        const request = require('request');

        let options = {
            method: 'POST',
            url: 'https://accounts.spotify.com/api/token',
            headers: {
                'cache-control': 'no-cache',
                Connection: 'keep-alive',
                'Content-Length': '173',
                'Accept-Encoding': 'true',
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie:
                    'remember=1; _ga=GA1.2.1841930364.1564302868; sp_dc=AQBRfigyfwzPDuKDr3TD7B9t8jz8ibWyPCNqlI_l69t4ag83KWgVhEad-Q_XQaJW-rJTsuWF-T01GCO5OmJYMW4F1lMHzDa4rDRzJrUWVQ; sp_key=33e53da7-1842-4597-8782-1542e79bb5b2; csrf_token=AQDLW8zfPN3hKQxA-qZ-pHXVc98Im7n7lRY5cqKmRl3TQgYFshchxZzg_iz-iV532Sos6frSI9nvjfw; sp_ac=AQCioZsuj_tT96FmVqPkVd392uDDEtqzGG01J2sB_sxXJzU8abs9RD8ImjMCn7zDdBCZ26cnnAKIR98GYatUGaQ45J56b7YNBIPVgEazCURdWQ-xR4x0yiwmcM-19LRhaEVQleaaM4cc_dkm6PaqFwMDT7yBG-yYoV3uJ-iVV0PSzv-pJJT_NWnNxb9kl9KSBQ-WMw3BXbNUw92fpRqVLn_3ivbwg06kWPs',
                Host: 'accounts.spotify.com',
                'Cache-Control': 'no-cache',
                Accept: '*/*',
                'User-Agent': 'PostmanRuntime/7.15.2',
                Authorization:
                    'Basic MzcyZDFiYTU0Y2VlNDIxNjgxZGM0NmNmYzZhMmJkMTU6ZDU1MDAwYTRjNGQ1NDVhMTg1NjExYTRhOWNiMjg3ZmQ='
            },
            form: {
                grant_type: 'refresh_token',
                refresh_token: 'AQA6iAdNubGC78bdQUrMahaS6WkPDL_7EGfeszh5gBdLpByjVvbwNJwzJbYTSFEFfSvss6eGAzQDgHhS9b2Vr82OpKBGQx7A4nKilK5ocx9gTwW5d_SRcNqgtXJ3H2JbPwDvow'
                //refresh_token: `AQCkGuy2h2pV8SCNOJjYP2FpUgQcjV4gkRxf_uW7LvJ6GyNFGPThxURArnsorh75QHqxa3CMUcREIV1pvb_jh2IFXi2APj6gRKcPC0jifUumrd4fA2ZgOZ8RMzUWZ9U0Pt6F_Q`
            }
        };

        /**
         * Treating the response of the request: Store the returned body of the response and then use a redex to extract only
         * the new access token.
         */
        request(options, function (error, response, body) {
            if (error) throw new Error(error);
            let returnedString = body;

            console.log('Whole response of new access token', returnedString);
            const regex = /(?<="access_token":")[^"]+/gim;

            let temporary;
            // While temporary, after asssuming the regex-returned string, does not equal null
            while ((temporary = regex.exec(returnedString)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (temporary.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `temporary`-variable.
                temporary.forEach((match, groupIndex) => {
                    returnedString = match;
                    console.log(`Found match, group ${groupIndex}: ${match}`);
                });
            }
            console.log('Regex of new access token', returnedString);
            setterForUpdatedAccessToken(returnedString);
        });


    }

    /**
     * Function calls out to the spotify api to get audio analysis and audio feature analysis of the song. This is then spoken to the user bia the agent.
     * @param agent relays the information to the user
     * @returns {Promise<void>}
     */

    // Give user more audio analysis
    async function giveAudioAnalysis(agent) {
        /**
         * Callout to the Spotify api using the spotify-web-api node package. LINK PACKAGE.
         * Agent vocalises the analysis extracted on the track.
         */
        await Spotify.getAudioAnalysisForTrack(`${SongInfo.just_uri}`).then(
            function (data) {
                let analysis = console.log('Analyser Version', data.body.meta.analyzer_version);
                let temp = Math.round(data.body.track.tempo);
                let key = data.body.track.key;
                let mode = data.body.track.mode;
                console.log('Track tempo', temp);
                console.log('Key', key);
                console.log('Mode', mode);
                setTempo(temp);
                setKey(key);
                setMode(mode);
                console.log('this is the key retrieved from SongInfo.key ' + SongInfo.key);

            },
            function (err) {
                console.error(err);
            }
        );

        await Spotify.getAudioFeaturesForTrack(`${SongInfo.just_uri}`)
            .then(function (data) {
                console.log(data.body);
                let danceability = data.body.danceability;
                let valence = data.body.valence;
                console.log('Danceability ' + danceability);
                console.log('Valence ' + valence);
                setDancability(danceability);
                setValence(valence);
            }, function (err) {
                console.log(err);
            });

        console.log('This is the key' + SongInfo.key);
        let str = convertNumberToKey(SongInfo.key);
        let keyPlusMode = str.concat(convertNumberToMode(SongInfo.mode));
        console.log(keyPlusMode);
        console.log(`${suitabilityForDancing(SongInfo.danceability)}`);

        agent.add(`The song has a ${lowMediumHigh(SongInfo.tempo)} tempo with ${SongInfo.tempo} beats per minute and is ${suitabilityForDancing(SongInfo.danceability)}. It is in the key of ${keyPlusMode}... Songs that are written in the key of ${keyPlusMode} often evoke ${convertKeyToEmotionalMeaning(keyPlusMode)} emotions... ${despiteOrFurthermore(SongInfo.mode, SongInfo.valence)} Would you still like to listen to this song?`);
    }

    /**
     * Another grammar method which converts the valence to the particular negative/positive emotion conveyed by the melody
     * @param mode major or minor
     * @param valence postivie or negative
     * @returns {string} result
     */
    function despiteOrFurthermore(mode, valence) {
        if (mode === 0 && valence < 0.30) {
            return "Along with the minor key, the song's low valence suggests that it has a negative melody.";
        } else if (mode === 1 && valence < 0.30) {
            return "Despite the major key, the song's low valence suggests that it has a negative melody.";
        } else if (mode === 0 && valence > 0.70) {
            return "Despite the minor key, the song's high valence suggests that it has a positive melody.";
        } else if (mode === 1 && valence > 0.70) {
            return "Along with the major key, the song's high valence suggests that it has a positive melody.";
        } else {
            return ' ';
        }

    }

    /**
     * Converts danceability score to how suitable that is
     * @param danceabilityScore over 70% means highly suitable, under 50% means unsuitable.
     * @returns {string} suitability of dancing
     */

    function suitabilityForDancing(danceabilityScore) {
        if (danceabilityScore < 0.4) {
            return "relatively unsuitable for dancing to";
        } else if (danceabilityScore < 0.7) {
            return "moderately suitable for dancing to";
        } else {
            return "suitable for dancing to"
        }
    }

    /**
     * Converts tempo to words low medium or high
     * @param tempo
     * @returns {string}
     */
    function lowMediumHigh(tempo) {
        if (tempo < 80) {
            return "low";
        }
        if (tempo < 120) {
            return "medium";
        }
        if (tempo >= 120) {
            return "high";
        }
    }

    /**
     * Uses the PUT request to play music via the spotify application
     * @param agent
     */
    function playMusic(agent) {
        agent.add('Enjoy!');
        const request = require("request");

        let options = {
            method: 'PUT',
            url: 'https://api.spotify.com/v1/me/player/play',
            headers:
                {
                    'cache-control': 'no-cache,no-cache',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${Access.accessToken}`,
                    Accept: 'application/json'
                },
            body: {uris: [`${SongInfo.Spotify_uri}`]},
            json: true
        };

        request(options, function (error, response, body) {
            if (error) throw new Error(error);

            console.log('This is the body of the play music request ' + body);
        });
    }

    /**
     * Converts the key number 0-11 to its key.
     * @param keyNumber number from audio analysis
     * @returns {any} key
     */
    function convertNumberToKey(keyNumber) {
        let keyNumbers = new Map();
        keyNumbers.set(0, 'C');
        keyNumbers.set(1, 'C-sharp or D-flat');
        keyNumbers.set(2, 'D');
        keyNumbers.set(3, 'D-sharp or E-flat');
        keyNumbers.set(4, 'E');
        keyNumbers.set(5, 'F');
        keyNumbers.set(6, 'F-sharp or G-flat');
        keyNumbers.set(7, 'G');
        keyNumbers.set(8, 'G-sharp or A-flat');
        keyNumbers.set(9, 'A');
        keyNumbers.set(10, 'A-sharp or B-flat');
        keyNumbers.set(11, 'B');
        console.log('Convert number to key function' + keyNumbers.get(keyNumber));
        return keyNumbers.get(keyNumber);

    }

    /**
     * Converts mode number to its mode
     * @param modeNumber minor, major or neither.
     * @returns {any}
     */

    function convertNumberToMode(modeNumber) {
        let modeNumbers = new Map();

        modeNumbers.set(0, ' minor');
        modeNumbers.set(1, ' major');
        modeNumbers.set(-1, '');
        console.log('Convert number to mode function' + modeNumbers.get(modeNumber));
        return modeNumbers.get(modeNumber);

    }


    /**
     * Converts key to its emmotional meaning
     * @param key
     * @returns {any}
     */
    function convertKeyToEmotionalMeaning(key) {
        let keyEmotions = new Map();
        keyEmotions.set('C major', 'happy and uplifting');
        keyEmotions.set('C minor', 'sad and love sick');
        keyEmotions.set('C-sharp or D-flat minor', 'despairing and sorrowful');
        keyEmotions.set('C-sharp or D-flat major', 'grieving and depressive');
        keyEmotions.set('D major', 'triumphant and victorious');
        keyEmotions.set('D minor', 'negative and melancholic');
        keyEmotions.set('D-sharp or E-flat minor', 'distressing and angsty');
        keyEmotions.set('D-sharp or E-flat major', 'cruel and hardened yet intimate');
        keyEmotions.set('F major', 'angry and regretful');
        keyEmotions.set('F minor', 'depressive and harrowing');
        keyEmotions.set('E major', 'boisterous, quarrelsome but also joyous');
        keyEmotions.set('E minor', 'relamorous, restless and grief-carrying');
        keyEmotions.set('F-sharp or G-flat minor', 'gloomy and resentful');
        keyEmotions.set('F-sharp or G-flat major', 'relief and clarity-giving');
        keyEmotions.set('G major', 'calm, idyllic and fanciful');
        keyEmotions.set('G minor', 'discontentful and uneasy');
        keyEmotions.set('G-sharp or A-flat major', 'haunting and lingering');
        keyEmotions.set('G-sharp or A-flat minor', 'resentful, life-loathing and negative');
        keyEmotions.set('A major', 'loving and joyful');
        keyEmotions.set('A minor', 'tender, plaintive and pious');
        keyEmotions.set('A-sharp or B-flat major', 'optimistic and hope-filled');
        keyEmotions.set('A-sharp or B-flat minor', 'pessimistic and dark');
        keyEmotions.set('B major', 'angry, jealous, desparing and burdened');
        keyEmotions.set('B minor', 'solitary, melancholic and patient');
        console.log('Convert key to emotional meaning function' + keyEmotions.get(key));
        return keyEmotions.get(key);

    }

    /**
     * Function controls when the user replies 'yes' to 'Would you like to hear a sad song?'.
     * Uses the random number within the bounds of the sad songs to select and recommend a song
     * for the user.
     * @param agent The dialogflow agent
     * @returns {Promise<admin.database.DataSnapshot | never>} The song of the desired emotion.
     */
    //92 to 123
    function playSadSong(agent) {
        /**
         * POST request to the Spotify token api for using the refresh token (which stays the same since sign in) to generate
         * a new access token.
         * @type {request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl> | request}
         */

        getUpdatedAccessToken();


        /**
         * Random number used to call for a song in the Firebase database within the bounds neccessary for
         * the desired emotion.
         * @type {number}
         */
        let r = (Math.floor(Math.random() * (123 - 92 + 1)) + 92);
        console.log('r before the while loop = ' + r);
        // Get the database collection 'dialogflow' and document 'agent'
        while (SongInfo.randomNumber === r) {
            // code block to be executed
            r = (Math.floor(Math.random() * (123 - 92 + 1)) + 92);
            console.log('Inside the while loop, r = ' + r);


        }
        if (SongInfo.randomNumber !== r) {
            setRandomNumber(r);
        }
        console.log('Outside while loop, r = ' + r);
        setRandomNumber(r);

        return admin.database().ref(`${SongInfo.randomNumber}`).once('value').then(async (snapshot) => {
            // Get the song, artist and spotify uri (with and without the preceding characters) from the Firebase Realtime Database
            let song = snapshot.child('song').val();
            let artist = snapshot.child('artist').val();
            let spotify_uri = snapshot.child('spotifyCode').val();
            let maxEmotion = snapshot.child('maxEmotion').val();
            let score = snapshot.child('score').val();
            let maxSentence = snapshot.child('maxSentence').val();
            let maxSentenceScore = snapshot.child('maxSentenceScore').val();
            setSong(song);
            setArtist(artist);
            setMaxEmotion(maxEmotion);
            setScore(score);
            setMaxSentence(maxSentence);
            setMaxSentenceScore(maxSentenceScore);

            setSpotify_uri(spotify_uri);
            let regex = /(?<=spotify:track:)[^"]+/gm;

            let m;
            let just_uri = '';

            while ((m = regex.exec(spotify_uri)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `m`-variable.
                m.forEach((match, groupIndex) => {
                    just_uri = match;
                    setJustUri(just_uri);
                    console.log(`Found match, group ${groupIndex}: ${match}`);

                });
            }


            recommendASong(agent);


        });
    }


    /**
     * * - * * - * * - * * - * * - * * - * * - * *HAPPY SONG WANTED- * * - * * - * * - * * - * * - * * - * * - * * - * * - * * - * * -
     */

    /**
     * Function controls when the user replies 'yes' to 'Would you like to hear a happy song?'.
     * Uses the random number within the bounds of the happy songs to select and recommend a song
     * for the user.
     * @param agent The dialogflow agent
     * @returns {Promise<admin.database.DataSnapshot | never>} The song of the desired emotion.
     */
    //22 to 53
    function playHappySong(agent) {

        /**
         * POST request to the Spotify token api for using the refresh token (which stays the same since sign in) to generate
         * a new access token.
         * @type {request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl> | request}
         */

        getUpdatedAccessToken();


        /**
         * Random number used to call for a song in the Firebase database within the bounds neccessary for
         * the desired emotion.
         * @type {number}
         */
        let r = (Math.floor(Math.random() * (91 - 37 + 1)) + 37);
        console.log('r before the while loop = ' + r);
        // Get the database collection 'dialogflow' and document 'agent'
        while (SongInfo.randomNumber === r) {
            // code block to be executed
            r = (Math.floor(Math.random() * (91 - 37 + 1)) + 37);
            console.log('Inside the while loop, r = ' + r);


        }
        if (SongInfo.randomNumber !== r) {
            setRandomNumber(r);
        }
        console.log('Outside while loop, r = ' + r);
        setRandomNumber(r);

        /**
         * Retrieves song from database using random number within the bounds of the particular emotion
         */

        return admin.database().ref(`${SongInfo.randomNumber}`).once('value').then(async (snapshot) => {
            // Get the song, artist and spotify uri (with and without the preceding characters) from the Firebase Realtime Database
            const song = snapshot.child('song').val();
            const artist = snapshot.child('artist').val();
            const spotify_uri = snapshot.child('spotifyCode').val();
            const maxEmotion = snapshot.child('maxEmotion').val();
            const score = snapshot.child('score').val();
            const maxSentence = snapshot.child('maxSentence').val();
            const maxSentenceScore = snapshot.child('maxSentenceScore').val();
            setSong(song);
            setArtist(artist);
            setMaxEmotion(maxEmotion);
            setScore(score);
            setMaxSentence(maxSentence);
            setMaxSentenceScore(maxSentenceScore);

            setSpotify_uri(spotify_uri);
            const regex = /(?<=spotify:track:)[^"]+/gm;

            let m;
            let just_uri = '';

            while ((m = regex.exec(spotify_uri)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `m`-variable.
                m.forEach((match, groupIndex) => {
                    just_uri = match;
                    console.log(`Found match, group ${groupIndex}: ${match}`);

                });
            }
            setJustUri(just_uri);

            recommendASong(agent);


        });
    }

    /**
     * * - * * - * * - * * - * * - * * - * * - * *ANGRY SONG WANTED- * * - * * - * * - * * - * * - * * - * * - * * - * * - * * - * * -
     */


    /**
     * Function controls when the user replies 'yes' to 'Would you like to hear an angry song?'.
     * Uses the random number within the bounds of the angry songs to select and recommend a song
     * for the user.
     * @param agent The dialogflow agent
     * @returns {Promise<admin.database.DataSnapshot | never>} The song of the desired emotion.
     */
    //7-11
    async function playAngrySong(agent) {


        /**
         * POST request to the Spotify token api for using the refresh token (which stays the same since sign in) to generate
         * a new access token.
         * @type {request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl> | request}
         */

        getUpdatedAccessToken();


        /**
         * Random number used to call for a song in the Firebase database within the bounds neccessary for
         * the desired emotion.
         * @type {number}
         */
        let r = (Math.floor(Math.random() * (3 - 0 + 1)) + 0);
        console.log('r before the while loop = ' + r);
        // Get the database collection 'dialogflow' and document 'agent'
        while (SongInfo.randomNumber === r) {
            // code block to be executed
            r = (Math.floor(Math.random() * (3 - 0 + 1)) + 0);
            console.log('Inside the while loop, r = ' + r);


        }
        if (SongInfo.randomNumber !== r) {
            setRandomNumber(r);
        }
        console.log('Outside while loop, r = ' + r);
        setRandomNumber(r);

        /**
         * Retrieves song from database using random number within the bounds of the particular emotion
         */
        return admin.database().ref(`${SongInfo.randomNumber}`).once('value').then(async (snapshot) => {
            // Get the song, artist and spotify uri (with and without the preceding characters) from the Firebase Realtime Database
            const song = snapshot.child('song').val();
            const artist = snapshot.child('artist').val();
            const spotify_uri = snapshot.child('spotifyCode').val();
            const maxEmotion = snapshot.child('maxEmotion').val();
            const score = snapshot.child('score').val();
            const maxSentence = snapshot.child('maxSentence').val();
            const maxSentenceScore = snapshot.child('maxSentenceScore').val();
            setSong(song);
            setArtist(artist);
            setMaxEmotion(maxEmotion);
            setScore(score);
            setMaxSentence(maxSentence);
            setMaxSentenceScore(maxSentenceScore);

            setSpotify_uri(spotify_uri);
            const regex = /(?<=spotify:track:)[^"]+/gm;

            let m;
            let just_uri = '';

            while ((m = regex.exec(spotify_uri)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `m`-variable.
                m.forEach((match, groupIndex) => {
                    just_uri = match;
                    console.log(`Found match, group ${groupIndex}: ${match}`);

                });
            }
            setJustUri(just_uri);

            recommendASong(agent);


        });


    }


    //5 to 15
    function playConfidentSong(agent) {

        /**
         * POST request to the Spotify token api for using the refresh token (which stays the same since sign in) to generate
         * a new access token.
         * @type {request.RequestAPI<request.Request, request.CoreOptions, request.RequiredUriUrl> | request}
         */

        getUpdatedAccessToken();


        /**
         * Random number used to call for a song in the Firebase database within the bounds neccessary for
         * the desired emotion.
         * @type {number}
         */
        let r = (Math.floor(Math.random() * (36 - 4 + 1)) + 4);
        console.log('r before the while loop = ' + r);
        // Get the database collection 'dialogflow' and document 'agent'
        while (SongInfo.randomNumber === r) {
            // code block to be executed
            r = (Math.floor(Math.random() * (36 - 4 + 1)) + 4);
            console.log('Inside the while loop, r = ' + r);


        }
        if (SongInfo.randomNumber !== r) {
            setRandomNumber(r);
        }
        console.log('Outside while loop, r = ' + r);
        setRandomNumber(r);

        /**
         * Retrieves song from database using random number within the bounds of the particular emotion
         */
        return admin.database().ref(`${SongInfo.randomNumber}`).once('value').then(async (snapshot) => {
            // Get the song, artist and spotify uri (with and without the preceding characters) from the Firebase Realtime Database
            const song = snapshot.child('song').val();
            const artist = snapshot.child('artist').val();
            const spotify_uri = snapshot.child('spotifyCode').val();
            const maxEmotion = snapshot.child('maxEmotion').val();
            const score = snapshot.child('score').val();
            const maxSentence = snapshot.child('maxSentence').val();
            const maxSentenceScore = snapshot.child('maxSentenceScore').val();
            setSong(song);
            setArtist(artist);
            setMaxEmotion(maxEmotion);
            setScore(score);
            setMaxSentence(maxSentence);
            setMaxSentenceScore(maxSentenceScore);

            setSpotify_uri(spotify_uri);
            const regex = /(?<=spotify:track:)[^"]+/gm;

            let m;
            let just_uri = '';

            while ((m = regex.exec(spotify_uri)) !== null) {
                // This is necessary to avoid infinite loops with zero-width matches
                if (m.index === regex.lastIndex) {
                    regex.lastIndex++;
                }

                // The result can be accessed through the `m`-variable.
                m.forEach((match, groupIndex) => {
                    just_uri = match;
                    console.log(`Found match, group ${groupIndex}: ${match}`);

                });
            }
            setJustUri(just_uri);

            recommendASong(agent);


        });
    }


    /**
     * intentMap maps the google actions to the various functions required for fulfilment.
     * @type {Map<any, any>}
     */
    let intentMap = new Map();
    intentMap.set('-Sad - yes', playSadSong);
    intentMap.set('-Sad - yes - no - no-chooseAgain', playSadSong);
    intentMap.set('-Sad - yes - no - yes', playMusic);
    intentMap.set('-Sad - yes - yes', giveAudioAnalysis);
    intentMap.set('-Sad - yes - yes - yes', playMusic);
    intentMap.set('-Sad - yes - yes - no - yes', playSadSong);

    intentMap.set('-Happy - yes', playHappySong);
    intentMap.set('-Happy - yes - no - no-chooseAgain', playHappySong);
    intentMap.set('-Happy - yes - no - yes', playMusic);
    intentMap.set('-Happy - yes - yes', giveAudioAnalysis);
    intentMap.set('-Happy - yes - yes - yes', playMusic);
    intentMap.set('-Happy - yes - yes - no - yes', playHappySong);


    intentMap.set('-Angry - yes', playAngrySong);
    intentMap.set('-Angry - yes - no - no-chooseAgain', playAngrySong);
    intentMap.set('-Angry - yes - no - yes', playMusic);
    intentMap.set('-Angry - yes - yes', giveAudioAnalysis);
    intentMap.set('-Angry - yes - yes - yes', playMusic);
    intentMap.set('-Angry - yes - yes - no - yes', playAngrySong);

    intentMap.set('-Confident - yes', playConfidentSong);
    intentMap.set('-Confident - yes - no - no-chooseAgain', playConfidentSong);
    intentMap.set('-Confident - yes - no - yes', playMusic);
    intentMap.set('-Confident - yes - yes', giveAudioAnalysis);
    intentMap.set('-Confident - yes - yes - yes', playMusic);
    intentMap.set('-Confident - yes - yes - no - yes', playConfidentSong);

    agent.handleRequest(intentMap);
});

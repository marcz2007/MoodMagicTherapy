const SpotifyWebApi = require('spotify-web-api-node');
// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');


function regexIdAndSecret(clientIdOrSecret) {
    const regex = /[(\w)]+/g;
    let n;
    let match;
    while ((n = regex.exec(clientIdOrSecret)) !== null) {
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
class Credentials {

    constructor(client_id, client_secret) {
        this.client_id = client_id;
        console.log('Id in class ' + this.client_id);
        this.client_secret = client_secret;
        console.log('Secret in class ' + this.client_secret);

    }

// 1a313450afc74bd4a4ed6c83b1561781
    // 25f9d28005f84d88a593f9c586b2ef89
    // 1a313450afc74bd4a4ed6c83b1561781:25f9d28005f84d88a593f9c586b2ef89
    // MWEzMTM0NTBhZmM3NGJkNGE0ZWQ2YzgzYjE1NjE3ODE6MjVmOWQyODAwNWY4NGQ4OGE1OTNmOWM1ODZiMmVmODk=

}

module.exports = admin.firestore().collection('credentials').doc('marc.jwatts@gmail.com').get().then((snapshot) => {
    let client_id = (snapshot.data().client_id);
    let client_secret = (snapshot.data().client_secret);
    // console.log(JSON.stringify(doc.data().client_id));
    // Credentials.client_id = JSON.stringify(doc.data().client_id);
    // console.log(JSON.stringify(doc.data().client_secret));
    // Credentials.client_secret = JSON.stringify(doc.data().client_secret);


    const credentials = new Credentials(client_id,client_secret);


    const Spotify = new SpotifyWebApi({
        clientId: credentials.client_id,
        clientSecret: credentials.client_secret,
        redirectUri: `https://moodmagictherapy2-rhjhig.firebaseapp.com/popup.html`
    });
    Spotify.setClientId(credentials.client_id);
    Spotify.setClientSecret(credentials.client_secret);
    console.log('This is the client id after it has been set ' + credentials.client_id);
    console.log('This is the client secret after it has been set ' + credentials.client_secret);
    return Spotify;

});


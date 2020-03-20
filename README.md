# MoodMagicFinalProject

Mood Magic Therapy is a Google Assistant application which uses Sentiment Tone Analysis to match the user’s mood with the emotions conveyed by musical lyrics. The application acts as a Music Therapy provider, recommending suitable pre-tone-analysed songs to the user based upon their mood. As a multimodal song analyser, the application also provides melodic analysis in addition to lyrics analysis. The objective of the application is to provide a music recommendation system which places lyrics in the forefront on analysis whilst also providing more information and freedom to the user to choose what they would like to listen to whilst speaking to a Google Assistant device such as a mobile phone or a smart speaker.

# Setup

![Google Assistant Application Page](https://github.com/marcz2007/MoodMagicTherapy/blob/master/MMT.png)

This section outlines how to access Mood Magic Therapy. Despite the music playing functions requiring the developer’s Spotify account (since Spotify did not allow for the Spotify app to be submitted to their website), the application can still be used via the Google Assistant. The application will let users converse with the system as normal and will recommend music based off the emotions that they are feeling. The application will provide audio analysis since this will be spoken by the Google agent, however, it will not be able to play the recommended song on a new Spotify account.

To launch the application, simply speak or type ‘Talk to Mood Magic Therapy’ into a Google Assistant device. Or, to find the application page, users need only search for ‘Mood Magic Therapy’ on the Google Assistant https://assistant.google.com/explore, as shown in Appendix G. Once found (https://assistant.google.com/services/a/uid/00000096e92c62db), users can click ‘send to device’. The app will launch and the user will be guided through the conversation.

# Code Structure

To create the database of pre-tone-analysed songs, ‘SQL’, IBM’s ‘Watson
Tone Analyser’ and Google’s, ‘NoSQL’ database, ‘Firebase’, was used. To create the user-to-app conversational experience, ‘Google Assistant’ entwined with ‘Dialogflow’ (formerly,
‘API.ai’), was utilised. Finally, to allow for audio analysis and the playing of music via the
application, ‘Spotify’s’ API service was used. These were all connected together via a single
‘Webhook’ – code that acts as an API endpoint, which in this project, communicates first
with the Dialogflow web API service – written in ‘JavaScript’ with the use of ‘Node.js
libraries’. These libraries were helpful throughout the project as they provided a simplistic
way of making API requests to external APIs, for example, in allowing for the
‘SentiwordNet’ analysis of the sentence that scored the highest for the highest-scoring
emotion used in the song and by providing the ability to make API requests using the
‘request’ library when certain library methods failed to execute.

- The folder ‘Google Assistant App’ contains the full application code. Navigate through to functions and then to index.js to see the entirety of the Webhook; This is the code which brings together the Google Assistant application with the other . A .zip file containing all the Dialogflow intents is also held within the
‘Google Assistant App’ folder. 
- The folder ‘DBTestApp/DatabaseAPiApp/npm-global’ contains the code used to create and manipulate the SQL databases and request Watson tone analysis on song lyrics.

For more information, please feel free to browse the project report I wrote which covers the project in much greater detail (MScProjectReport.pdf).

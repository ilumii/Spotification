var express = require('express');
var router = express.Router();

//Node Wrapper for Spotify Web API Setup
var SpotifyWebApi = require('spotify-web-api-node');
var scopes = ['user-read-private', 'user-read-email', 'user-read-birthdate', 'user-top-read', 'user-library-read',
'playlist-modify-private', 'playlist-read-private', 'playlist-modify-public','user-read-recently-played'],
  state = 'spotification-state';
var configSpotify = require('../configs/config-spotify');
//TO-DO: NOT USE WebApi --> Use Axios instead
var spotifyApi = new SpotifyWebApi(configSpotify);
var spotifyData = require('../utils/spotifyData');
var verify = require('../utils/verify');
var mongo = require('../utils/mongo');

//JWT Setup
const jwt = require('jsonwebtoken');
var jwtSecret = require('../configs/config-jwt');
var middlewares = require('../utils/middlewares');

// Create a new MongoClient
let db;
mongo.connect((err,result) => {
  if (err) {
    console.log(err);
  } else {
    db = result;
  }
})

//Moment Setup
const moment = require('moment');

//Axios for Spotify Web API calls
const axios = require('axios');

/* POST user/ - Creates new User
EXPECTS:
  HEADERS:
    - N/A
  BODY:
    - username: username of new user (must be unique/not exist already in database)
    - password: password of new user (will be hashed upon reciept)
    - fullName: fullname of new user
*/
//TODO:
// - Add rest of user data into user documents
router.post('/', function(req, res, next) {
  var username = req.body.username;
  var password = req.body.password;
  const users = db.collection('users')
  users.find({'username': username}, {}).toArray( (err, results) => {
    console.log("Found the following records");
    console.log(results);
    if ( !(results) || results.length == 0 ) {
      let {salt, passHash} = verify.saltHashPassword(password);
      let userDoc = {
        'username': username,
        'password': passHash,
        'salt': salt,
        'fullName': req.body.fullName,
        'spotifyAuthUrl': spotifyApi.createAuthorizeURL(scopes, state),
        'spotifyAuth': false
      }
      // Get the documents collection
      const users = db.collection('users');
      // Find some documents
      users.insertOne(userDoc, {}, (err, results) => {
        if(err) {
          console.log(err);
          res.json(err);
          return;
        } else {
          console.log("Inserted the following document");
          console.log(results);
          jwt.sign({'username': username}, jwtSecret , { expiresIn: '1d' }, (err, token) => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
            user = results['ops'][0];
            delete user.password;
            delete user.salt;
            res.json({
              'token': token,
              'user': user
            });
          });
        }
      });
    }
    else {
      res.status(403);
      res.send("User already exists");
    }
  });
});

/* GET user/ - Gets Logged-In User
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
*/
router.get('/', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      console.log('ERROR: Could not connect to the protected route');
      res.status(401);
      res.send('Error with given token');
    } else {
      //If token is successfully verified, we can send the autorized data
      const users = db.collection('users');
      users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0 }}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.status(500);
          res.json(err);
          return;
        }
        if ( results.length == 0  || !(results) ) {
          console.log('ERROR: User could not be found');
          res.status(404);
          res.send("Given user does not exist");
        }
        let user = results[0];
        if (user.spotifyAuth){
          if (!(user.images)){
            spotifyData.checkRefresh(user, db, spotifyApi, (err, checkedUser) => {
              if(err){
                console.log(err.data);
                res.status(500);
                res.json(err.data);
                return;
              }
              spotifyAccessToken = checkedUser['spotifyAuthTokens']['access'];
              axios.get(`https://api.spotify.com/v1/me`,
              {headers: { Authorization: `Bearer ${spotifyAccessToken}`}})
              .then(results => {
                console.log(results)
                let images = results.data.images;
                users.updateOne({'username': checkedUser['username']},
                {$set : {'images': images} },
                {}, (err, results) => {
                  if(err) {
                    console.log(err);
                    res.status(500);
                    res.json(err);
                    return;
                  }
                  users.find({'username': checkedUser['username']}, {'projection': {'password': 0, 'salt': 0, 'spotifyAuthTokens': 0}}).toArray( (err, results) => {
                    if(err) {
                      console.log(err);
                      res.status(500);
                      res.json(err);
                      return;
                    }
                    console.log(results)
                    res.json(results);
                  })
                });
              })
              .catch(err => {
                console.log(err['response'].data);
                res.status(500);
                res.json(err['response'].data);
                return;
              })
            })
          }
          else{
            res.json(results);
          }
        }
        else{
          res.json(results);
        }
      });
    }
  });
});

/* GET user/username/<username> - Gets Info of given user
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
*/
router.get('/username/:username', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    var username = req.params.username;
    if(err){
      console.log('ERROR: Could not connect to the protected route');
      res.status(401);
      res.send('Error with given token');
    } else {
      //If token is successfully verified, we can send the autorized data
      const users = db.collection('users');
      users.find({'username': username}, {'projection': {'password': 0, 'salt': 0, 'spotifyAuthTokens': 0, 'spotifyAuthUrl': 0}}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.status(500);
          res.json(err);
          return;
        }
        if ( results.length == 0  || !(results) ) {
          console.log('ERROR: User could not be found');
          res.status(404);
          res.send("Given user does not exist");
          return;
        }
        var givenUser = results[0]
        if (givenUser.spotifyAuth && givenUser.listeningData){
          users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
            if ( results.length == 0  || !(results) ) {
              console.log('ERROR: User could not be found');
              res.status(404);
              res.send("Given user does not exist");
            }
            var loggedInUser = results[0];
            let givenUserFeatures = (givenUser.listeningData ? givenUser.listeningData.avgFeatures : null )
            let loggedInUserFeatures = (loggedInUser.listeningData ? loggedInUser.listeningData.avgFeatures : null )
            //console.log(givenUserFeatures);
            //console.log(loggedInUserFeatures);
            spotifyData.getSimilairity(givenUserFeatures, loggedInUserFeatures, (data) => {
              var similarity = null;
              //console.log(data);
              if (data !== -1) similarity = data;
              givenUser.similarity = data;
              res.json(givenUser);
              return;
            })
            //console.log(results)
            //res.json(results);
          });
        }
        else{
          res.json(givenUser);
        }
      });
    }
  });
});

/* POST user/login/ - Log-In to Existing User
EXPECTS:
  HEADERS:
    - N/A
  BODY:
    - username: username of new user (must be exist already in database)
    - password: password of new user (will be hashed upon reciept/match with given user)
*/
router.post('/login', function(req, res, next) {
  var username = req.body.username;
  console.log(username);
  var password = req.body.password;
  //console.log(password);
  const users = db.collection('users');
  users.find({'username': username}).toArray( (err, results) => {
    if ( results.length == 0  || !(results) ) {
      console.log('ERROR: User could not be found');
      res.status(404);
      res.send('User could not be found');
    }
    else {
      jwt.sign({'username': username}, jwtSecret, { expiresIn: '1d' }, (err, token) => {
        if(err) {
          console.log(err);
          res.status(500);
          res.json(err);
          return;
        }
        console.log('what up bitch');
        var hashedPass = results[0]['password'];
        var salt = results[0]['salt'];
        if (!verify.verifyPass(password, salt, hashedPass)){
          res.status(403);
          res.send("Password incorrect");
          return;
        }
        user = results[0];
        delete user.password;
        delete user.salt;
        res.json({
          'token': token,
          'user': results[0]
        });
      });
    }
  });
});

/* POST user/spotifyauth/ - get access tokens from spotify web api after auth
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
  BODY:
    - 'code': code returned from spotify auth process
*/
router.post('/spotifyauth', middlewares.checkToken, (req, res) => {
  var code = req.query.code;
  if (req.body.code) code = req.body.code;
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      console.log('ERROR: Could not connect to the protected route');
      res.status(401);
      res.send('Error with given token');
    } else {
      spotifyApi.authorizationCodeGrant(code).then((data) => {
        var timeTokenExpires = moment().add(data.body['expires_in'],'s').format();
        console.log(timeTokenExpires);
        spotifyAuthTokens = {
          'access': data.body['access_token'],
          'refresh': data.body['refresh_token'],
          'expires': timeTokenExpires
        }
        axios.get(`https://api.spotify.com/v1/me`,
        {headers: { Authorization: `Bearer ${data.body['access_token']}`}})
        .then(results => {
          console.log(results)
          let images = results.data.images;
          const users = db.collection('users');
          users.updateOne({'username': authorizedData['username']},
          {$set : {'spotifyAuthTokens': spotifyAuthTokens, 'spotifyAuth': true, 'images': images} },
          {}, (err, results) => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
            spotifyApi.setAccessToken(data.body['access_token']);
            spotifyApi.setRefreshToken(data.body['refresh_token']);
            users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0, 'spotifyAuthTokens': 0}}).toArray( (err, results) => {
              if(err) {
                console.log(err);
                res.status(500);
                res.json(err);
                return;
              }
              console.log(results)
              res.json(results);
            })
          })
        })
        .catch(err => {
          console.log(err['response'].data);
          const users = db.collection('users');
          users.updateOne({'username': authorizedData['username']},
          {$set : {'spotifyAuthTokens': spotifyAuthTokens, 'spotifyAuth': true} },
          {}, (err, results) => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
            spotifyApi.setAccessToken(data.body['access_token']);
            spotifyApi.setRefreshToken(data.body['refresh_token']);
            users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0, 'spotifyAuthTokens': 0}}).toArray( (err, results) => {
              if(err) {
                console.log(err);
                res.status(500);
                res.json(err);
                return;
              }
              console.log(results)
              res.json(results);
            })
          })
        })
      })
      .catch( (err) => {
        console.log(err);
        res.status(500);
        res.json(err);
        return;
      })
    }
  })
});

/* GET user/listening-data - Updates Listening Data of Logged-In User from Spotify
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
*/
router.get('/listening-data', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      //If error send Forbidden (403)
      console.log('ERROR: Could not connect to the protected route');
      res.sendStatus(403);
    } else {
      const users = db.collection('users');
      users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.json(err);
          return;
        }
        user = results[0];
        spotifyData.checkRefresh(user, db, spotifyApi, (err, checkedUser) => {
          if(err){
            console.log(err);
            res.status(500);
            res.json(err);
            return;
          }
          spotifyAccessToken = checkedUser['spotifyAuthTokens']['access'];
          axios.get('https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term',
          {headers: { Authorization: `Bearer ${spotifyAccessToken}`}})
          .then(results => {
            console.log(results['data']);
            if (results['data'].items && results['data'].items.length > 0){
              spotifyData.getAvgFeats(checkedUser, db, results['data']['items'], (err, data) => {
                if(err){
                  console.log(err);
                  res.status(500);
                  res.json(err);
                  return;
                }
                else {
                  const users = db.collection('users');
                  users.updateOne({'username': user['username']},
                  {$set : {'listeningData': data} },
                  {}, (err, results) => {
                    if(err) {
                      console.log(err);
                      res.status(500);
                      res.json(err);
                      return;
                    }
                    users.find({'username': user['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
                      if(err) {
                        console.log(err);
                        res.status(500);
                        res.json(err);
                        return;
                      }
                      user = results[0]
                      res.json(results);
                    });
                  });
                }
              });
            }
            else {
              console.log("here")
              const users = db.collection('users');
              users.updateOne({'username': user['username']},
              {$set : {'listeningData': {}} },
              {}, (err, results) => {
                if(err) {
                  console.log(err);
                  res.status(500);
                  res.json(err);
                  return;
                }
                users.find({'username': user['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
                  if(err) {
                    console.log(err);
                    res.status(500);
                    res.json(err);
                    return;
                  }
                  user = results[0]
                  res.json(results);
                });
              });
            }
          })
          .catch(err => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
          })
        })
      });
    }
  });
});


/* POST user/create-playlist - To be used in conjunction with recommendations if wants to save recommendations as a playlist
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
    BODY:
    - 'playlistName': Desired name of newly created playlist
    - 'playlistTrackUris': Array of Spotify Track URI's for tracks to be added to playlist
*/
router.post('/create-playlist', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      //If error send Forbidden (403)
      console.log('ERROR: Could not connect to the protected route');
      res.sendStatus(403);
    } else {
      const users = db.collection('users');
      users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.json(err);
          return;
        }
        user = results[0];
        spotifyData.checkRefresh(user, db, spotifyApi, (err, checkedUser) => {
          if(err){
            console.log(err);
            res.status(500);
            res.json(err);
            return;
          }
          spotifyAccessToken = checkedUser['spotifyAuthTokens']['access'];
          axios.get('https://api.spotify.com/v1/me/',
          {headers: { Authorization: `Bearer ${spotifyAccessToken}`}})
          .then(results => {
            console.log(results['data']);
            const userId = results['data']['id'];
            axios.post(`https://api.spotify.com/v1/users/${userId}/playlists`,
            {name: req.body.playlistName, description: "Made using Spotification!"},
            {headers: { Authorization: `Bearer ${spotifyAccessToken}`, 'Content-Type': 'application/json'}})
            .then(results => {
              let playlistId = results['data']['id'];
              axios.post(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
              {uris: req.body.playlistTrackUris},
              {headers: { Authorization: `Bearer ${spotifyAccessToken}`, 'Content-Type': 'application/json'}})
              .then(results => {
                res.json({playlistMade: true});
              })
              .catch(err => {
                if(err) {
                  console.log(err);
                  res.status(500);
                  res.json(err);
                  return;
                }
              })
            })
            .catch(err => {
              if(err) {
                console.log(err);
                res.status(500);
                res.json(err);
                return;
              }
            })
          })
          .catch(err => {
            if(err) {
              console.log(err);
              res.status(500);
              res.json(err);
              return;
            }
          })
        })
      });
    }
  });
});

/* GET user/playlists - Gets Playlists of Logged-In User
EXPECTS:
  HEADERS:
    - 'Authorization': 'Bearer <token>'
*/
router.get('/playlists', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      console.log('ERROR: Could not connect to the protected route');
      res.status(401);
      res.send('Error with given token');
    } else {
      //If token is successfully verified, we can send the autorized data
      const users = db.collection('users');
      users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.status(500);
          res.json(err);
          return;
        }
        if ( results.length == 0  || !(results) ) {
          console.log('ERROR: User could not be found');
          res.status(404);
          res.send("Given user does not exist");
        }
        user = results[0];
        spotifyData.checkRefresh(user, db, spotifyApi, (err, checkedUser) => {
          if(err){
            console.log(err);
            res.status(500);
            res.json(err);
            return;
          }
          spotifyAccessToken = checkedUser['spotifyAuthTokens']['access'];
          axios.get('https://api.spotify.com/v1/me/playlists?limit=50',
          {headers: { Authorization: `Bearer ${spotifyAccessToken}`}})
          .then(results => {
            console.log(results.data)
            res.json(results.data)
          })
          .catch(err => {
            console.log(err);
            res.status(500);
            res.json(err);
            return;
          })

        })
      });
      //res.json({ authorizedData });
    }
  });
});

router.get('/refresh-tokens', middlewares.checkToken, (req, res) => {
  jwt.verify(req.token, jwtSecret, (err, authorizedData) => {
    if(err){
      console.log('ERROR: Could not connect to the protected route');
      res.status(401);
      res.send('Error with given token');
    } else {
      //If token is successfully verified, we can send the autorized data
      const users = db.collection('users');
      users.find({'username': authorizedData['username']}, {'projection': {'password': 0, 'salt': 0}}).toArray( (err, results) => {
        if(err) {
          console.log(err);
          res.status(500);
          res.json(err);
          return;
        }
        if ( results.length == 0  || !(results) ) {
          console.log('ERROR: User could not be found');
          res.status(404);
          res.send("Given user does not exist");
        }
        user = results[0];
        spotifyData.forceRefresh(user, db, spotifyApi, (err, checkedUser) => {
          if(err){
            console.log(err);
            res.status(500);
            res.json(err);
            return;
          }
          res.json(checkedUser);
        })
      });
    }
  });
});

module.exports = router;

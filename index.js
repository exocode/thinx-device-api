/*
 * This THiNX-RTM API module is responsible for responding to devices and build requests.
 */

var ThinxApp = function() {

  var _private = {

  };

  var _public = {

  };

  var Rollbar = require('rollbar');
  var rollbar = new Rollbar({
    accessToken: '5505bac5dc6c4542ba3bd947a150cb55',
    handleUncaughtExceptions: true,
    handleUnhandledRejections: true
  });

  // record a generic message and send to rollbar
  rollbar.reportMessage("API BOOTSTRAP");

  //
  // Shared Configuration
  //

  require('console-stamp')(console, 'yyyy-mm-dd HH:MM:ss.l');

  var session_config = require("./conf/node-session.json");
  var app_config = require("./conf/config.json");

  var client_user_agent = app_config.client_user_agent;
  var db = app_config.database_uri;
  var serverPort = app_config.port;
  var socketPort = app_config.socket;

  var uuidV1 = require("uuid/v1");
  var url = require("url");
  var http = require("http");
  var https = require("https");
  var parser = require("body-parser");
  var nano = require("nano")(db);
  var sha256 = require("sha256");
  var fingerprint = require('ssh-fingerprint');
  var Emailer = require('email').Email;
  var fs = require("fs");
  var gutil = require('gulp-util');
  var request = require("request");
  var mkdirp = require('mkdirp');
  var path = require('path');

  var deploy = require("./lib/thinx/deployment");
  var v = require("./lib/thinx/version");
  var alog = require("./lib/thinx/audit");
  var blog = require("./lib/thinx/build");
  var watcher = require("./lib/thinx/repository");
  var apikey = require("./lib/thinx/apikey");
  var stats = require("./lib/thinx/statistics");

  var exec = require('child_process')

  var WebSocket = require("ws");

  var rdict = {};
  var watched_repos = [];

  /*
   * Databases
   */

  function initDatabases() {

    nano.db.create("managed_devices", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_devices");
      } else {
        console.log("» Device database creation completed. Response: " +
          JSON.stringify(
            body) + "\n");
      }
    });

    nano.db.create("managed_builds", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_builds");
      } else {
        console.log("» Build database creation completed. Response: " +
          JSON
          .stringify(
            body) + "\n");
      }
    });

    nano.db.create("managed_users", function(err, body, header) {
      if (err) {
        handleDatabaseErrors(err, "managed_users");
      } else {
        console.log("» User database creation completed. Response: " +
          JSON
          .stringify(
            body) + "\n");
      }
    });
  }

  function handleDatabaseErrors(err, name) {

    if (err.toString().indexOf("the file already exists") != -1) {
      // silently fail, this is ok

    } else if (err.toString().indexOf("error happened in your connection") !=
      -
      1) {
      console.log("🚫 Database connectivity issue. " + err);
      process.exit(1);

    } else {
      console.log("🚫 Database " + name + " creation failed. " + err);
      process.exit(2);
    }
  }

  /*
  // Database access
  // ./vault write secret/password value=13fd9bae19f4daffa17b34f05dbd9eb8281dce90 owner=test revoked=false
  // Vault init & unseal:

  var options = {
  	apiVersion: 'v1', // default
  	endpoint: 'http://127.0.0.1:8200', // default
  	token: 'b7fbc90b-6ae2-bbb8-ff0b-1a7e353b8641' // optional client token; can be fetched after valid initialization of the server
  };


  // get new instance of the client
  var vault = require("node-vault")(options);

  // init vault server
  vault.init({
  		secret_shares: 1,
  		secret_threshold: 1
  	})
  	.then((result) => {
  		var keys = result.keys;
  		// set token for all following requests
  		vault.token = result.root_token;
  		// unseal vault server
  		return vault.unseal({
  			secret_shares: 1,
  			key: keys[0]
  		})
  	})
  	.catch(console.error);

  */

  initDatabases();

  var devicelib = require("nano")(db).use("managed_devices");
  var buildlib = require("nano")(db).use("managed_builds");
  var userlib = require("nano")(db).use("managed_users");

  // Express App

  var express = require("express");
  var session = require("express-session");
  var app = express();

  var redis = require("redis");
  var redisStore = require('connect-redis')(session);
  var client = redis.createClient();

  //app.set('trust proxy', 1) // trust first proxy

  app.use(session({
    secret: session_config.secret,
    store: new redisStore({
      host: 'localhost',
      port: 6379,
      client: client
    }),
    name: "x-thx-session",
    resave: true,
    rolling: true,
    saveUninitialized: true,
  }));

  app.use(parser.json({
    limit: '10mb'
  }));

  app.use(parser.urlencoded({
    extended: true,
    parameterLimit: 10000,
    limit: '10mb'
  }));

  //var helmet = require('helmet');
  //app.use(helmet());
  app.disable('x-powered-by');

  app.all("/*", function(req, res, next) {


    var origin = req.get("origin");

    if (typeof(req.session) === "undefined") {
      console.log("---session-less-request---");
    }

    // FIXME: This is a hack. It should not work like this. We just need to find out,
    // why the login page rejects CORS on browser-side (redirect from successful
    // Password-change operation).

    if (typeof(origin) === "undefined") {
      origin = "rtm.thinx.cloud";
    }

    if (origin === null) {
      origin = "rtm.thinx.cloud";
    }

    var allowedOrigin = origin;

    // Custom user agent is required for devices
    var client = req.get("User-Agent");
    if (client == client_user_agent) {

      if (origin == "device") {
        next();
        return;
      }
    }

    res.header("Access-Control-Allow-Origin", allowedOrigin); // rtm.thinx.cloud
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers",
      "Content-type,Accept,X-Access-Token,X-Key");

    if (req.method == "OPTIONS") {
      res.status(200).end();
    } else {
      next();
    }

    if ((typeof(req.session) !== "undefined") && (typeof(req.session
        .owner) !== "undefined")) {
      console.log("[OID:" + req.session.owner + "] ", req.method +
        " : " + req.url);
    } else {
      console.log("[OID:0] [" + req.method + "]:" + req.url);
    }
  });

  /*
   * User Profile
   */

  /* Updates user profile allowing following types of bulked changes:
   * { avatar: "base64hexdata..." }
   * { info: { "arbitrary" : "user info data "} } }
   */
  app.post("/api/user/profile", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    var update_key = null;
    var update_value = null;

    if (typeof(req.body.avatar) !== "undefined") {

      update_key = "avatar";
      update_value = req.body.avatar;

    } else if (typeof(req.body.info) !== "undefined") {

      update_key = "info";
      update_value = req.body.info;

    } else {
      res.end(JSON.stringify({
        success: false,
        status: "invalid_protocol"
      }));
    }

    alog.log(owner, "Attempt to update owner: " + owner +
      " with: " + update_key);

    // Fetch complete user
    userlib.get(owner, function(err, doc) {

      if (err) {
        console.log(err);
        alog.log(owner, "Profile update failed.");
        res.end(JSON.stringify({
          success: false,
          status: "owner_not_found"
        }));
        return;
      }

      if (!doc) {
        console.log("Document for " + owner + " not found.");
        alog.log(owner, "Profile update failed.");
        res.end(JSON.stringify({
          success: false,
          status: "document_not_found"
        }));
        return;
      }

      doc[update_key] = update_value;

      userlib.destroy(doc._id, doc._rev, function(err) {

        if (err) {
          console.log(err);
          res.end(JSON.stringify({
            success: false,
            status: "destroy_error"
          }));
          return;
        }

        delete doc._rev;

        userlib.insert(doc, doc._id, function(err, body, header) {

          if (err) {
            console.log(err);
            alog.log(owner, "Profile updated.");
            res.end(JSON.stringify({
              success: false,
              status: "profile_update_failed"
            }));
            return;
          } else {
            alog.log(owner, "Profile update failed.");
            res.end(JSON.stringify({
              "success": true,
              update_key: doc
            }));
          }
        });
      });
    });
  });

  /*
   * Devices
   */

  /* List all devices for user. */
  app.get("/api/user/devices", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    devicelib.view("devicelib", "devices_by_owner", {
        "key": owner,
        "include_docs": false
      },
      function(err, body) {

        if (err) {
          if (err.toString() == "Error: missing") {
            res.end(JSON.stringify({
              result: "none"
            }));
          }
          console.log("/api/user/devices: Error: " + err.toString());
          return;
        }

        var rows = body.rows; // devices returned
        var devices = []; // an array by design (needs push), to be encapsulated later

        // Show all devices for admin (if not limited by query)
        if (req.session.admin === true && typeof(req.body.query) ==
          "undefined") {
          var response = JSON.stringify({
            devices: devices
          });
          res.end(response);
          return;
        }

        for (var row in rows) {
          var rowData = rows[row];
          var dvc = rowData.value;
          // Compare owner to device owner
          if (owner.indexOf(rowData.key) != -1) {
            if (typeof(dvc.source) === "undefined") {
              dvc.source = null;
            }

            var deviceDescriptor = {
              udid: dvc.udid,
              mac: dvc.mac,
              firmware: dvc.firmware,
              alias: dvc.alias,
              owner: dvc.owner,
              version: dvc.version,
              lastupdate: dvc.lastupdate,
              source: dvc.source
            };

            devices.push(deviceDescriptor);
          }
        }
        var reply = JSON.stringify({
          devices: devices
        });
        res.end(reply);
      });
  });

  /* Attach code source to a device. Expects unique device identifier and source alias. */
  app.post("/api/device/attach", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.source_id) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_source_id"
      }));
      return;
    }

    if (typeof(req.body.udid) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_udid"
      }));
      return;
    }

    var source_id = req.body.source_id;
    var owner = req.session.owner;
    var username = req.session.username;
    var udid = req.body.udid;

    alog.log(owner, "Attempt to attach repository: " + source_id +
      " to device: " + udid);

    console.log("[OID:" + owner + "] [DEVICE_ATTACH] " + udid);

    devicelib.view("devicelib", "devices_by_udid", {
      "key": udid,
      "include_docs": true
    }, function(err, body) {

      if (err) {
        console.log("find error: " + err);
        return;
      }

      if (body.rows.length === 0) {
        res.end(JSON.stringify({
          success: false,
          status: "udid_not_found"
        }));
        alog.log(owner,
          "Attempt to attach repository to non-existent device: " +
          udid);
        return;
      }

      var doc = body.rows[0].value;

      // make sure we don't destroy whole database
      if (typeof(doc) === "undefined" || (doc === null)) {
        res.end(JSON.stringify({
          success: false,
          status: "device_not_found",
          err_udid: udid
        }));
        return;
      }

      alog.log(doc.owner, "Attaching repository to device: " + JSON
        .stringify(
          doc));

      deploy.initWithOwner(doc.owner);
      var repo_path = deploy.pathForDevice(doc.owner, doc.udid);
      console.log("repo_path: " + repo_path);

      mkdirp(repo_path, function(err) {
        if (err) console.error(err);
        else console.log(repo_path + ' created.');
      });

      if (typeof(watched_repos) === "undefined") {
        watched_repos = [];
      }

      if (fs.existsSync(repo_path)) {
        watcher.watchRepository(repo_path, watcher_callback);
        watched_repos.push(repo_path);
      } else {
        console.log(repo_path + " is not a directory.");
      }

      doc.source = source_id;

      devicelib.destroy(doc._id, doc._rev, function(err) {
        delete doc._rev;
        devicelib.insert(doc, doc._id, function(err, body,
          header) {
          if (err) {
            console.log("/api/device/attach ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "attach_failed"
            }));
            return;
          } else {
            res.end(JSON.stringify({
              success: true,
              attached: source_id
            }));
          }
        });
      });
    });
  });

  /* Detach code source from a device. Expects unique device identifier. */
  app.post("/api/device/detach", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.udid) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_udid"
      }));
      return;
    }

    var owner = req.session.owner;
    var username = req.session.username;
    var udid = req.body.udid;

    alog.log(owner, "Attempt to detach repository from device: " + udid);

    devicelib.view("devicelib", "devices_by_udid", {
      "key": udid,
      "include_docs": true
    }, function(err, body) {

      if (err) {
        console.log(err);
        return;
      }

      var rows = body.rows[0];
      if (typeof(rows) !== "undefined") {
        console.log("DETACH rows: " + rows);
      } else {
        res.end(JSON.stringify({
          success: false,
          status: "udid_not_found"
        }));
        return;
      }

      var doc = body.rows[0].value;

      // make sure we don't destroy whole database
      if (typeof(doc) === "undefined" || (doc === null)) {
        res.end(JSON.stringify({
          success: false,
          status: "device_not_found",
          err_udid: udid
        }));
        return;
      }

      console.log("Detaching repository from device: " + JSON.stringify(
        doc.udid));

      var repo_path = deploy.pathForDevice(doc.owner, doc.udid);
      console.log("repo_path: " + repo_path);
      if (fs.existsSync(repo_path)) {
        watcher.unwatchRepository(repo_path);
        watched_repos.splice(watched_repos.indexOf(repo_path));
      }

      doc.source = null;

      devicelib.destroy(doc._id, doc._rev, function(err) {

        delete doc._rev;

        devicelib.insert(doc, doc._id, function(err, body,
          header) {
          if (err) {
            console.log("/api/device/detach ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "detach_failed"
            }));
            return;
          } else {
            res.end(JSON.stringify({
              success: true,
              attached: doc.source
            }));
          }
        });
      });
    });
  });

  /* Revokes a device. Expects unique device identifier. */
  app.post("/api/device/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.udid) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_udid"
      }));
      return;
    }

    var udid = req.body.udid;
    var owner = req.session.owner;
    var username = req.session.username;

    alog.log(owner, "Attempt to revoke device: " + udid);

    var apikey = require("./lib/thinx/apikey");

    devicelib.view("devicelib", "devices_by_owner", {
        "key": owner,
        "include_docs": true
      },
      function(err, body) {

        if (err) {
          console.log(err);
          return;
        }

        if (body.rows.count === 0) {
          alog.log(owner, "No such device: " + doc.alias +
            " (${doc.udid})");
          res.end(JSON.stringify({
            success: false,
            status: "no_such_device"
          }));
          return;
        }

        var doc = null;

        for (var dindex in body.rows) {
          var device = body.rows[dindex].value;
          var device_udid = device.udid;
          if (device_udid.indexOf(udid) != -1) {
            doc = device;
            break;
          }
        }

        // make sure we don't destroy whole database
        if (typeof(doc) === "undefined" || (doc === null)) {
          res.end(JSON.stringify({
            success: false,
            status: "device_not_found",
            err_udid: udid
          }));
          return;
        }

        var logmessage = "Revoking device: " + JSON.stringify(doc.udid);
        alog.log(owner, logmessage);

        devicelib.destroy(doc._id, doc._rev, function(err) {

          if (err) {
            console.log(err);
            res.end(JSON.stringify({
              success: false,
              status: "revocation_failed"
            }));
            return;

          } else {

            // MQTT
            var mqtt = "/devices/" + udid;
            CMD = "mosquitto_passwd -D mqtt_passwords " + udid;
            var temp = exec.execSync(CMD);
            if (temp) {
              console.log("[REVOKE_ERROR] MQTT: " + temp);
            }
            console.log("[OID:" + owner + "] [DEVICE_REVOCATION] " +
              doc.udid);
            alog.log(owner, logmessage);
            res.end(JSON.stringify({
              success: true,
              revoked: doc.udid
            }));
          }
        });
      });
  });

  /*
   * API Keys
   */

  /* Creates new api key. */
  app.post("/api/user/apikey", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.alias) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_alias"
      }));
      return;
    }

    var new_api_key_alias = req.body.alias;
    var new_api_key = sha256(new Date().toString()).substring(0, 40);

    userlib.get(owner, function(err, doc) {

      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: err
        }));
        return;
      }

      if (doc === null) {
        console.log("User " + username + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      var keys = [];
      if (typeof(doc.api_keys) === "undefined") {
        keys = [];
      } else {
        keys = doc.api_keys;
      }

      var new_hash = sha256(new_api_key);

      keys[keys.length] = {
        "key": new_api_key,
        "hash": new_hash,
        "alias": new_api_key_alias
      };

      apikey.create(owner, new_api_key_alias, function(success,
        object) {
        if (success) {
          res.end(JSON.stringify({
            success: true,
            api_key: new_api_key,
            hash: object.hash
          }));
          return;
        }
      });
    });
  });

  /* Deletes API Key by its hash value */
  app.post("/api/user/apikey/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;
    var api_key_hash = req.body.fingerprint;

    console.log("[OID:" + owner + "] [APIKEY_REVOKE] " + api_key_hash);

    apikey.revoke(owner, api_key_hash, function(success) {
      if (success) {
        res.end(JSON.stringify({
          revoked: api_key_hash,
          success: true
        }));
        return;
      } else {
        res.end(JSON.stringify({
          success: false,
          status: "revocation_failed"
        }));
      }
    });
  });

  /* Lists all API keys for user. */
  app.get("/api/user/apikey/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    apikey.list(owner, function(success, keys) {
      if (success) {

        res.end(JSON.stringify({
          api_keys: keys
        }));
        return;
      } else {

        res.end(JSON.stringify({
          success: false,
          status: "apikey_list_failed"
        }));
      }
    });
  });

  /*
   * Sources (GIT Repositories)
   */

  /* List available sources */
  app.get("/api/user/sources/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    userlib.get(owner, function(err, user) {

      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "api-user-apikey-list_error"
        }));
        return;
      }


      res.end(JSON.stringify({
        success: true,
        sources: user.repos
      }));
    });
  });

  /* Adds a GIT repository. Expects URL, alias and a optional branch (origin/master is default). */
  app.post("/api/user/source", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.alias) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_source_alias"
      }));
      return;
    }

    if (typeof(req.body.url) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_source_url"
      }));
      return;
    }

    var branch = "origin/master";
    if ((typeof(req.body.branch) !== "undefined") &&
      (req.body.branch !== null)) {
      branch = req.body.branch;
    }

    var url = req.body.url;
    var alias = req.body.alias;

    var source_id = uuidV1();

    userlib.get(owner, function(err, body) {

      if (err) {
        console.log(err);
        return;
      }

      var user = body;
      var doc = body;

      if (!doc) {
        console.log("User " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      var new_source = {
        alias: alias,
        url: url,
        branch: branch
      };

      if (typeof(doc.repos) === "undefined") {
        doc.repos = {};
      }

      doc.repos[source_id] = new_source;

      userlib.destroy(doc._id, doc._rev, function(err) {

        delete doc._rev;

        userlib.insert(doc, doc._id, function(err, body, header) {
          if (err) {
            console.log("/api/user/source ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "key-not-added"
            }));
            return;
          } else {
            res.end(JSON.stringify({
              success: true,
              source: new_source,
              source_id: source_id
            }));
          }
        });
      });
    });
  });

  /* Removes a GIT repository. Expects alias. */
  app.post("/api/user/source/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.source_id) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_source_id"
      }));
      return;
    }

    var source_id = req.body.source_id;

    userlib.get(owner, function(err, user) {

      if (err) {
        console.log(err);
        return;
      }

      var doc = user;

      if (!doc) {
        console.log("Owner " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      var sources = doc.repos;

      delete sources[source_id];

      // Update user with new repos
      userlib.destroy(doc._id, doc._rev, function(err) {
        doc.repos = sources;
        delete doc._rev;
        userlib.insert(doc, doc._id, function(err, body, header) {
          if (err) {
            console.log("/api/user/source ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "source_not_removed"
            }));
            return;
          } else {
            res.end(JSON.stringify({
              success: true,
              source: doc
            }));
          }
        });
      }); // userlib

      devicelib.view("devicelib", "devices_by_owner", {
          key: owner,
          include_docs: true
        },

        function(err, body) {

          if (err) {
            console.log(err);
            // no devices to be detached
          }

          if (body.rows.length === 0) {
            console.log("no-devices to be detached; body: " +
              JSON.stringify(body));
            // no devices to be detached
          }

          // Warning, may not restore device if called without device parameter!
          var insert_on_success = function(err, device) {
            var newdevice = device;
            delete newdevice._rev;
            delete newdevice._deleted_conflicts;
            devicelib.insert(newdevice, newdevice._id, function(
              err) {
              if (err) {
                console.log(
                  "(3) repo_revoke_pre-insert err:" + err
                );
              }
            });
          };

          var insert = function(err, device) {
            insert_on_success(err, device);
          };

          for (var dindex in body.rows) {

            var device = body.rows[0].value;

            // make sure we don't destroy whole database
            if (typeof(device) === "undefined" || (device === null)) {
              res.end(JSON.stringify({
                success: false,
                status: "device_not_found",
                err_udid: udid
              }));
              return;
            }

            if (device.source == source_id) {
              console.log(
                "repo_revoke alias equal: Will destroy/insert device."
              );
              device.source = null;
              devicelib.destroy(
                device._id,
                device._rev,
                insert(err, device));
            }
          }

        }); // devicelib

    });
  });

  /*
   * RSA Keys
   */

  app.post("/api/user/rsakey", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    // Validate those inputs from body... so far must be set
    if (typeof(req.body.alias) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_ssh_alias"
      }));
      return;
    }

    if (typeof(req.body.key) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_ssh_key"
      }));
      return;
    }

    var new_key_alias = req.body.alias;
    var new_key_body = req.body.key;
    var new_key_fingerprint = fingerprint(new_key_body).toString();

    console.log("new_key_fingerprint: " + new_key_fingerprint);

    userlib.get(owner, function(err, doc) {

      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      if (!doc) {
        console.log("User " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "userid_not_found"
        }));
        return;
      }

      var file_name = owner + "-" + Math.floor(new Date() /
        1000) + ".pub";
      var ssh_path = "../.ssh/" + file_name;

      var new_ssh_key = {
        alias: new_key_alias,
        key: ssh_path
      };

      fs.open(ssh_path, 'w+', function(err, fd) {
        if (err) {
          console.log(err);
        } else {
          fs.writeFile(ssh_path, new_ssh_key, function(err) {
            if (err) {
              console.log(err);
            } else {
              fs.close(fd, function() {
                console.log('RSA key installed...');
              });
              console.log("Updating permissions for " +
                ssh_path);
              fs.chmodSync(ssh_path, '644');
            }
          });
        }
      });

      doc.rsa_keys[new_key_fingerprint] = new_ssh_key;

      userlib.destroy(doc._id, doc._rev, function(err) {

        delete doc._rev;

        userlib.insert(doc, doc._id, function(err, body, header) {
          if (err) {
            console.log("/api/user/rsakey ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "key-not-added"
            }));
          } else {
            console.log("RSA Key successfully added.");
            res.end(JSON.stringify({
              success: true,
              fingerprint: new_key_fingerprint
            }));
          }
        });
      });
    });
  });

  /* Lists all SSH keys for user. */
  // TODO L8TR: Mangle keys as display placeholders only, but support this in revocation!
  app.get("/api/user/rsakey/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    // Get all users
    userlib.get(owner, function(err, user) {

      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      if (typeof(user) === "undefined") {
        console.log("User " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "userid_not_found"
        }));
        return;
      }



      var exportedKeys = [];
      var fingerprints = Object.keys(user.rsa_keys);
      for (var i = 0; i < fingerprints.length; i++) {
        var key = user.rsa_keys[fingerprints[i]];
        var info = {
          name: key.alias,
          fingerprint: fingerprints[i]
        };
        exportedKeys.push(info);
      }

      var reply = JSON.stringify({
        rsa_keys: exportedKeys
      });

      res.end(reply);
    });
  });

  /* Deletes RSA Key by its fingerprint */
  app.post("/api/user/rsakey/revoke", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.fingerprint) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_attribute:fingerprint"
      }));
      return;
    }

    var rsa_key_fingerprint = req.body.fingerprint;



    userlib.get(owner, function(err, doc) {

      if (err || !doc) {
        if (err) {
          console.log("ERRX:" + err);
        } else {
          console.log("User " + owner + " not found.");
        }

        res.end(JSON.stringify({
          success: false,
          status: "owner_not_found"
        }));
        return;
      }

      if (!doc) {

        return;
      }

      // Search RSA key by hash
      var keys = doc.rsa_keys;
      var delete_key = null;

      if (typeof(keys !== "undefined")) {
        //
      } else {
        res.end(JSON.stringify({
          success: false,
          status: "rsa_keys_not_found"
        }));
        return;
      }

      var fingerprints = Object.keys(doc.rsa_keys);

      if (typeof(fingerprints) === "undefined") {
        console.log("ERROR: No fingerprints in keys: " + JSON.stringify(
          keys));
        res.end(JSON.stringify({
          success: false,
          status: "fingerprint_not_found"
        }));
        return;
      }

      var new_keys = {};
      for (var i = 0; i < fingerprints.length; i++) {
        var key = doc.rsa_keys[fingerprints[i]];
        if (fingerprints[i].indexOf(rsa_key_fingerprint) !== -1) {

          if (fs.existsSync(key.key)) {
            console.log("Deleting RSA key file:" + key.key);
            fs.unlink(key.key);
          }
          console.log("Removing RSA key from database: " +
            rsa_key_fingerprint);
          delete_key = true;
        } else {
          new_keys[fingerprint] = key;
        }
      }

      if (delete_key !== null) {
        doc.last_update = new Date();
        doc.rsa_keys = new_keys;
      } else {
        res.end(JSON.stringify({
          success: false,
          status: "fingerprint_not_found"
        }));
        return;
      }


      if (err) {
        console.log("Cannot destroy user on password-reset");
        console.log(err);
        res.end(JSON.stringify({
          status: "user_not_reset",
          success: false
        }));
        return;
      } else {
        userlib.destroy(doc._id, doc._rev, function(err) {
          delete doc._rev;
          userlib.insert(doc, doc._id, function(err) {
            if (err) {
              console.log("rsa_revocation_failed:" + err);
              res.end(JSON.stringify({
                success: false,
                status: "rsa_revocation_failed"
              }));
            } else {
              res.end(JSON.stringify({
                revoked: rsa_key_fingerprint,
                success: true
              }));
            }
          });
        });
      }
    });
  });

  /*
   * Password Reset
   */

  // /user/create GET
  /* Create username based on e-mail. Owner is  be unique (email hash). */
  app.post("/api/user/create", function(req, res) {

    var first_name = req.body.first_name;
    var last_name = req.body.last_name;
    var email = req.body.email;
    var username = req.body.owner;
    // password will be set on successful e-mail activation

    var new_owner_hash = sha256(email);

    userlib.view("users", "owners_by_username", {
      "key": new_owner_hash,
      "include_docs": true // might be useless
    }, function(err, body) {

      if (err) {
        if (err != "Error: missing") {
          console.log("Error: " + err.toString());
        }
      } else {
        var user_should_not_exist = body.rows.length;
        if (user_should_not_exist > 0) {
          res.end(JSON.stringify({
            success: false,
            status: "email_already_exists"
          }));
          console.log("Already exists.");
          return;
        }
      }

      var new_api_keys = [];
      var new_rsa_keys = {};

      var new_activation_date = new Date().toString();
      var new_activation_token = sha256(new_activation_date);

      var default_repo = {
        "7038e0500 a8690a8bf70d8470f46365458798011e8f46ff012f12cbcf898b2f4": {
          alias: "THiNX Vanilla Device Firmware",
          url: "git@github.com:suculent/thinx-firmware-esp8266.git",
          branch: "origin/master",
          devices: [
            "ANY"
          ]
        }
      };

      // Create user document
      var new_user = {
        owner: new_owner_hash,
        username: username,
        email: email,
        api_keys: new_api_keys,
        rsa_keys: new_rsa_keys,
        first_name: first_name,
        last_name: last_name,
        activation: new_activation_token,
        activation_date: new_activation_date,
        repos: [default_repo]
      };

      userlib.insert(new_user, new_owner_hash, function(err,
        body, header) {

        if (err) {
          if (err.statusCode == 409) {
            res.end(JSON.stringify({
              success: false,
              status: "email_already_exists"
            }));
          } else {
            console.log(err);
          }
          return;
        }

        console.log("Sending activation email...");

        // Creates registration e-mail with activation link
        var activationEmail = new Emailer({
          bodyType: "html",
          from: "api@thinx.cloud",
          to: email,
          subject: "Account activation",
          body: "<!DOCTYPE html>Hello " + first_name +
            " " +
            last_name +
            ". Please <a href='http://rtm.thinx.cloud:7442/api/user/activate?owner=" +
            username + "&activation=" +
            new_activation_token +
            "'>activate</a> your THiNX account.</html>"
        });

        console.log("Sending activation e-mail: " + JSON.stringify(
          activationEmail));

        activationEmail.send(function(err) {
          if (err) {
            console.log(err);
            res.end(JSON.stringify({
              success: false,
              status: "activation_failed"
            }));
          } else {
            console.log("Activation email sent.");
            res.end(JSON.stringify({
              success: true,
              status: "email_sent"
            }));
          }
        });
      }); // insert
    }); // view
  }); // post


  /* Endpoint for the password reset e-mail. */
  app.get("/api/user/password/reset", function(req, res) {

    var owner = req.query.owner; // for faster search
    var reset_key = req.query.reset_key; // for faster search

    alog.log(owner, "Attempt to reset password with: " + reset_key);



    userlib.view("users", "owners_by_resetkey", {
      "key": reset_key,
      "include_docs": true
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
            res.end(err);
          } else {
            res.end(JSON.stringify({
              success: false,
              status: "invalid_protocol"
            }));
            console.log("Not a valid request.");
          }
        });
        return;
      }

      if (body.rows.length === 0) {
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }

      var user = body.rows[0].doc;

      if (typeof(req.query.reset_key) !== "undefined") {

        var reset_key = req.query.reset_key;
        var user_reset_key = user.reset_key;

        if (typeof(user_reset_key) === "undefined") {
          user_reset_key = null;
        }

        console.log("Attempt to reset password with key: " +
          reset_key);

        if (req.query.reset_key != user_reset_key) {
          console.log("reset_key does not match");
          res.end(JSON.stringify({
            success: false,
            status: "invalid_reset_key"
          }));
          return;
        } else {
          res.redirect('http://rtm.thinx.cloud:80' +
            '/password.html?reset_key=' +
            reset_key +
            '&owner=' + user.owner);
          return;
        }

      } else {

        console.log("Missing reset key.");

      }
    });
  });

  /* Endpoint for the user activation e-mail, should proceed to password set. */
  app.get("/api/user/activate", function(req, res) {

    console.log(JSON.stringify(req.query));

    var ac_key = req.query.activation;
    var ac_owner = req.query.owner;



    userlib.view("users", "owners_by_activation", {
      "key": ac_key,
      "include_docs": true
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());

        req.session.destroy(function(err) {
          console.log(err);
          res.end(JSON.stringify({
            status: "user_not_found",
            success: false
          }));
        });

        res.end(JSON.stringify({
          status: "activation",
          success: false
        }));

      } else {
        res.redirect('http://rtm.thinx.cloud:80' +
          '/password.html?activation=' +
          ac_key +
          '&owner=' + ac_owner);
        return;
      }
    });
  });

  /* Used by the password.html page to perform the change in database. Should revoke reset_key when done. */
  app.post("/api/user/password/set", function(req, res) {

    var password1 = req.body.password;
    var password2 = req.body.rpassword;

    var request_owner = null;
    if (typeof(req.body.owner) !== undefined) {
      request_owner = req.body.owner;
    } else {
      console.log("Request has no owner for fast-search.");
    }

    if (password1 !== password2) {
      res.end(JSON.stringify({
        status: "password_mismatch",
        success: false
      }));
    } else {
      console.log("Passwords match....");
    }

    if (typeof(req.body.reset_key) !== "undefined") {

      alog.log(request_owner, "Attempt to set password with: " + req.body
        .reset_key);

      console.log("Performing password reset...");

      // Validate password reset_key
      userlib.view("users", "owners_by_resetkey", {
        "key": req.body.reset_key,
        "include_docs": true
      }, function(err, body) {

        if (err) {
          console.log("Error: " + err.toString());
          req.session.destroy(function(err) {
            if (err) {
              console.log(err);
            } else {
              res.end(JSON.stringify({
                status: "reset",
                success: false
              }));
              console.log("Not a valid request.");
            }
          });
          return;
        } else {

          console.log("resetting user: " + JSON.stringify(body));

          if (body.rows.length === 0) {
            res.end(JSON.stringify({
              status: "reset_user_not_found",
              success: false
            }));
            return;
          }

          var userdoc = body.rows[0];

          userdoc.doc.password = sha256(password1);
          userdoc.doc.last_reset = new Date();
          userdoc.doc.reset_key = null;

          if (err) {
            console.log("Cannot destroy user on password-set");
            res.end(JSON.stringify({
              status: "user_not_reset",
              success: false
            }));
            return;
          }

          console.log("Creating document...");

          delete userdoc.doc._rev;

          userlib.insert(userdoc.doc, userdoc.owner, function(err) {
            if (err) {
              console.log("Cannot insert user on password-set");
              res.end(JSON.stringify({
                status: "user_not_saved",
                success: false
              }));
              return;
            } else {
              console.log(
                "Password reset completed saving new user document."
              );
              res.end(JSON.stringify({
                status: "password_reset_successful",
                success: true,
                redirect: "http://thinx.cloud/"
              }));
              return;
            }
          });
        }
      });

    } else if (typeof(req.body.activation) !== "undefined") {

      console.log("Performing new activation...");

      alog.log(request_owner, "Attempt to activate account with: " +
        req.body.activation);

      userlib.view("users", "owners_by_activation", {
        "key": req.body.activation,
        "include_docs": true
      }, function(err, body) {

        if (err) {
          console.log("Error: " + err.toString());
          res.end(JSON.stringify({
            status: "reset",
            success: false
          }));
          return;

        } else {

          console.log("activating user: " + JSON.stringify(body));

          if (body.rows.length === 0) {
            res.end(JSON.stringify({
              status: "activated_user_not_found",
              success: false
            }));
            return;
          }

          console.log("Activating user: " + JSON.stringify(body));

          var userdoc = body.rows[0].doc;

          deploy.initWithOwner(userdoc.owner);

          userdoc.password = sha256(password1);
          userdoc.activation_date = new Date();
          userdoc.activation = null;

          console.log("Updating user document: " + JSON.stringify(
            userdoc));

          userlib.destroy(userdoc._id, userdoc._rev, function(err) {

            delete userdoc._rev; // should force new revision...

            userlib.insert(userdoc, userdoc._id, function(err) {

              if (err) {
                console.log(err);
                console.log(
                  "Could not re-insert user on new activation."
                );
                res.end(JSON.stringify({
                  status: "user_not_saved",
                  success: false
                }));
                return;
              } else {
                // TODO: Password-reset success page, should redirect to login.
                console.log(
                  "Password reset success page, should redirect to login..."
                );
                //res.redirect("http://rtm.thinx.cloud:80/");
                res.end(JSON.stringify({
                  redirect: "http://rtm.thinx.cloud:80/",
                  success: true
                }));
                return;
              }
            });

          });
        }
      });
    } else {
      console.log("No reset or activation? Edge assert!");
      failureResponse(res, 403, "Password change not authorized.");
    }
  });

  // /user/password/reset POST
  /* Used to initiate password-reset session, creates reset key with expiraation and sends password-reset e-mail. */
  app.post("/api/user/password/reset", function(req, res) {

    var email = req.body.email;

    userlib.view("users", "owners_by_email", {
      "key": email,
      "include_docs": true // might be useless
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      } else {
        console.log("password reset users: " + body.rows.length);
        if (body.rows.length > 2) {
          res.end(JSON.stringify({
            success: false,
            status: "too_many_users"
          }));
          return;
        }

        if (body.rows.length === 0) {
          res.end(JSON.stringify({
            success: false,
            status: "email_not_found"
          }));
          return;
        }
      }

      var user = body.rows[0].doc;
      if (typeof(user) === "undefined" || user === null) {
        console.log("User not found.");
        res.end(JSON.stringify({
          success: false,
          status: "user_not_found"
        }));
        return;
      }


      console.log("Creating new reset-key...");
      user.reset_key = sha256(new Date().toString());

      userlib.destroy(user._id, user._rev, function(err) {

        delete user._rev;

        userlib.insert(user, user.owner, function(err, body,
          header) {

          if (err) {
            console.log(err);
            res.end(JSON.stringify({
              success: false,
              status: "insert_failed"
            }));
            return;
          }

          console.log("Resetting password for user: " +
            JSON.stringify(user));

          var resetEmail = new Emailer({
            bodyType: "html",
            from: "api@thinx.cloud",
            to: email,
            subject: "Password reset",
            body: "<!DOCTYPE html>Hello " + user.first_name +
              " " + user.last_name +
              ". Someone has requested to <a href='http://rtm.thinx.cloud:7442/api/user/password/reset?owner=" +
              user.owner + "&reset_key=" + user.reset_key +
              "'>reset</a> your THiNX password.</html>"
          });

          console.log("Sending reset e-mail: " + JSON.stringify(
            resetEmail));

          resetEmail.send(function(err) {
            if (err) {
              console.log(err);
              res.end(JSON.stringify({
                success: false,
                status: err
              }));
            } else {
              console.log("Reset e-mail sent.");
              res.end(JSON.stringify({
                success: true,
                status: "email_sent"
              }));
            }
          });
        });
        // Calling page already displays "Relax. You reset link is on its way."
      }); // insert
    }); // view
  }); // post


  // /user/profile GET
  app.get("/api/user/profile", function(req, res) {

    // reject on invalid headers
    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    userlib.get(owner, function(err, body) {

      if (err) {
        res.end(JSON.stringify({
          success: false,
          status: err
        }));
        return;
      }

      var avatar = app_config.default_avatar;
      if (typeof(body.avatar) !== "undefined") {
        avatar = body.avatar;
      }

      var fn = body.first_name;
      var ln = body.last_name;

      if (typeof(body.info) !== "undefined") {
        if (typeof(body.info.first_name !== "undefined")) {
          fn = body.info.first_name;
        }
        if (typeof(body.info.last_name !== "undefined")) {
          ln = body.info.first_name;
        }
      }

      var profile = {
        first_name: fn,
        last_name: ln,
        username: body.username,
        owner: body.owner,
        avatar: avatar,
        info: body.info
      };

      res.end(JSON.stringify({
        success: true,
        profile: profile
      }));
    });
  });

  //
  // Main Device API
  //

  // Firmware update retrieval. Serves binary [by owner (?) - should not be required] and device MAC.
  app.post("/device/firmware", function(req, res) {

    validateRequest(req, res);

    var api_key = null;

    if (typeof(req.body.mac) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_mac"
      }));
      return;
    }

    if (typeof(req.body.hash) === "undefined") {
      /* optional, we'll find latest checksum if not available
      res.end(JSON.stringify({
      	success: false,
      	status: "missing_udid"
      }));
      return;
      */
    }

    if (typeof(req.body.checksum) === "undefined") {
      /* optional, we'll find latest checksum if not available
      res.end(JSON.stringify({
      	success: false,
      	status: "missing_checksum"
      }));
      return;
      */
    }

    if (typeof(req.body.commit) === "undefined") {
      /* optional, we'll find latest commit_id if not available
      res.end(JSON.stringify({
      	success: false,
      	status: "missing_commit"
      }));
      return;
      */
    }

    var mac = req.body.mac; // will deprecate
    var udid = req.body.udid;
    var checksum = req.body.checksum;
    var commit = req.body.commit;
    var alias = req.body.alias;
    var owner = req.body.owner; // TODO: should be inferred from API Key, but that is indexed by owner...

    console.log("TODO: Validate if SHOULD update device " + mac +
      " using commit " + commit + " with checksum " + checksum +
      " and owner: " +
      owner);

    var success = false;
    var status = "ERROR";

    // Headers must contain Authentication header
    if (typeof(req.headers.authentication) !== "undefined") {
      api_key = req.headers.authentication;
    } else {
      console.log("ERROR: Update requests must contain API key!");
      res.end(JSON.stringify({
        success: false,
        status: "authentication"
      }));
      return;
    }

    userlib.view("users", "owners_by_username", {
      "include_docs": true // might be useless
    }, function(err, all_users) {

      if (err) {
        console.log("Error: " + err.toString());
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            failureResponse(res, 501, "protocol");
            console.log("Not a valid request.");
          }
        });
        return;
      } else {
        isNew = false;
      }

      // Find user and match api_key
      var api_key_valid = false;
      var user_data = null;

      // search API Key in owners, this will take a while...
      for (var oindex in all_users.rows) {
        var anowner = all_users.rows[oindex];
        for (var kindex in anowner.doc.api_keys) {
          var k = anowner.doc.api_keys[kindex].key;

          if (k.indexOf(api_key) != -1) {
            user_data = anowner.doc;
            owner = anowner.doc.owner;
            console.log("API Key valid.");
            api_key_valid = true;
            break;
          }
        }
      }

      alog.log(owner, "Attempt to register device: " + udid +
        " alias: " +
        alias);

      if (api_key_valid === false) {
        console.log("[APIKEY_INVALID] on firmware update.");
        alog.log(owner, "Attempt to use invalid API Key: " +
          api_key +
          "  on firmware update.");
        res.end(JSON.stringify({
          success: false,
          status: "api_key_invalid"
        }));
        return;
      } else {
        alog.log(owner, "Firmware request with API Key: " + api_key);
      }

      // See if we know this MAC which is a primary key in db

      if (err) {
        console.log("Querying devices failed. " + err + "\n");
      }

      var success = false;
      var status = "OK";

      devicelib.view("devicelib", "devices_by_id", {
        "key": udid,
        "include_docs": true
      }, function(err, existing) {

        if (err) {
          console.log(err);
          return;
        }

        var device = {
          mac: existing.mac,
          owner: existing.owner,
          version: existing.version
        };

        var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
          device);
        var url = firmwareUpdateDescriptor.url;
        var mac = firmwareUpdateDescriptor.mac;
        var commit = firmwareUpdateDescriptor.commit;
        var version = firmwareUpdateDescriptor.version;
        var checksum = firmwareUpdateDescriptor.checksum;

        console.log(
          "Seaching for possible firmware update... (owneer:" +
          device.owner + ")");

        deploy.initWithDevice(device);

        var update = deploy.hasUpdateAvailable(device);
        if (update === true) {
          var path = deploy.pathForDevice(owner, mac);
          fs.open(ssh_path, 'r', function(err, fd) {
            if (err) {
              res.end(JSON.stringify({
                success: false,
                status: "not_found"
              }));
              return console.log(err);
            } else {
              var buffer = fs.readFileSync(path);
              res.end(buffer);
              fs.close(fd, function() {
                console.log(
                  'Sending firmware update...');
              });

              devicelib.insert(existing, mac, function(err,
                body, header) {
                if (!err) {
                  console.log("Device updated.");
                  return;
                } else {
                  console.log(
                    "Device record update failed." +
                    err);
                }
              }); // insert

            }
          }); // fs.open

        } else {
          res.end(JSON.stringify({
            success: true,
            status: "no_update_available"
          }));
          console.log("No firmware update available for " +
            JSON.stringify(
              device));
        }
      }); // device get
    }); // user view
  }); // app.get

  // Device login/registration
  // FIXME: MAC will be allowed for initial regitration
  app.post("/device/register", function(req, res) {

    validateRequest(req, res);

    res.set("Connection", "close");

    if (typeof(req.body.registration) == "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "no_registration"
      }));
      return;
    }

    var reg = req.body.registration;
    var api_key = null;

    rdict.registration = {};

    var mac = reg.mac;
    var fw = "unknown";
    if (!reg.hasOwnProperty("firmware")) {
      fw = "undefined";
    } else {
      fw = reg.firmware;
      console.log("Setting firmware " + fw);
    }

    var push = reg.push;
    var alias = reg.alias;
    var username = reg.owner;
    var success = false;
    var status = "ERROR";

    // Headers must contain Authentication header
    if (typeof(req.headers.authentication) !== "undefined") {
      api_key = req.headers.authentication;
    } else {
      console.log("ERROR: Registration requests now require API key!");
      alog.log(owner, "Attempt to register witout API Key!");
      res.end(JSON.stringify({
        success: false,
        status: "authentication"
      }));
      return;
    }



    userlib.view("users", "owners_by_username", { // because owners_by_apikey does not work anymore... apikeys should have to be in separate table
      "include_docs": true // might be useless
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            failureResponse(res, 501, "protocol");
            console.log("Not a valid request.");
          }
        });
        return;
      }

      if (body.rows.length === 0) {
        res.end(JSON.stringify({
          success: false,
          status: "owner_not_found"
        }));
        return;
      }



      var user_data = null;
      var owner = null;

      var api_key_valid = false;

      // search API Key in owners, this will take a while...
      for (var oindex in body.rows) {
        var anowner = body.rows[oindex];
        for (var kindex in anowner.doc.api_keys) {
          var k = anowner.doc.api_keys[kindex].key;

          if (k.indexOf(api_key) != -1) {
            user_data = anowner.doc;
            owner = anowner.doc.owner;
            console.log("Valid key found.");
            api_key_valid = true;
            break;
          }
        }
      }

      alog.log(owner, "Attempt to register device: " + hash +
        " alias: " +
        alias);

      var deploy = require("./lib/thinx/deployment");
      deploy.initWithOwner(owner); // creates user path if does not exist

      if (api_key_valid === false) {
        console.log("[APIKEY_INVALID] on registration.");
        alog.log(owner, "Attempt to use invalid API Key: " +
          api_key +
          " on device registration.");
        res.end(JSON.stringify({
          registration: {
            success: false,
            status: "authentication"
          }
        }));
        return;
      } else {
        alog.log(owner, "Using API Key: " + api_key);
      }

      var success = false;
      var status = "OK";

      var device_version = "1.0.0"; // default

      if (typeof(reg.version) !== "undefined" && reg.version !==
        null) {
        console.log("Updating device version to " + reg.version);
        device_version = reg.version;
      }

      var firmware_url = "";
      var known_alias = "";
      var known_owner = "";

      var hash = null;
      if (typeof(reg.hash) !== "undefined") {
        hash = reg.hash;
      }

      var checksum = hash;
      if (typeof(reg.checksum) !== "undefined") {
        checksum = reg.checksum;
      }

      // will deprecate
      if (typeof(reg.device_id) !== "undefined") {
        udid = reg.device_id; // overridden
      }

      // will be set in stone
      var udid; // is returned to device which should immediately take over this value instead of mac for new registration
      if (typeof(reg.udid) !== "undefined") {
        udid = reg.udid; // overridden
      }

      //
      // Construct response
      //

      reg = rdict.registration;

      reg.success = success;
      reg.status = status;

      if (alias != known_alias) {
        known_alias = alias; // should force update in device library
      }

      if (known_owner === "") {
        known_owner = owner;
      }

      if (owner != known_owner) {
        // TODO: Fail from device side, notify admin.
        console.log("owner is not known_owner (" + owner + ", " +
          known_owner +
          ")");
        reg.owner = known_owner;
        owner = known_owner; // should force update in device library
      }

      console.log("Device firmware: " + fw);

      var mqtt = "/devices/" + udid;

      var device = {
        mac: mac,
        firmware: fw,
        hash: hash,
        checksum: checksum,
        push: push,
        alias: alias,
        owner: owner,
        version: device_version,
        udid: udid,
        mqtt: mqtt,
        lastupdate: new Date(),
        lastkey: sha256(api_key)
      };

      console.log("Seaching for possible firmware update...");

      console.log("Checking update for device descriptor:\n" + JSON
        .stringify(
          device));

      //var deploy = require("./lib/thinx/deployment");
      var update = deploy.hasUpdateAvailable(device);
      if (update === true) {
        console.log("Firmware update available.");
        var firmwareUpdateDescriptor = deploy.latestFirmwareEnvelope(
          device);
        reg.status = "FIRMWARE_UPDATE";
        reg.success = true;
        reg.url = firmwareUpdateDescriptor.url;
        reg.mac = firmwareUpdateDescriptor.mac;
        reg.commit = firmwareUpdateDescriptor.commit;
        reg.version = firmwareUpdateDescriptor.version;
        reg.checksum = firmwareUpdateDescriptor.checksum;
      } else if (update === false) {
        reg.success = true;
        console.log("No firmware update available.");
      } else {
        console.log("Update semver response: " + update);
      }

      // KNOWN DEVICES:
      // - see if new firmware is available and reply FIRMWARE_UPDATE with url
      // - see if alias or owner changed
      // - otherwise reply just OK



      devicelib.get(mac, function(error, existing) {

        if (!error && existing) {

          console.log("[OID:" + owner +
            "] [DEVICE_CHECKIN] Known device: " + JSON.stringify(
              reg));

          existing.lastupdate = new Date();
          if (typeof(fw) !== undefined && fw !== null) {
            existing.firmware = fw;
          }
          if (typeof(hash) !== undefined && hash !== null) {
            existing.hash = hash;
          }
          if (typeof(push) !== undefined && push !== null) {
            existing.push = push;
          }
          if (typeof(alias) !== undefined && alias !== null) {
            existing.alias = alias;
          }
          // device notifies on owner change
          if (typeof(owner) !== undefined && owner !== null) {
            existing.owner = owner;
          }

          devicelib.destroy(existing._id, existing._rev,
            function(err) {

              delete existing._rev;

              devicelib.insert(existing, mac, function(err,
                body, header) {
                if (!err) {
                  res.set("Connection", "close");
                  res.end(JSON.stringify({
                    registration: {
                      success: true,
                      owner: owner,
                      alias: alias,
                      udid: existing.udid,
                      status: "OK"
                    }
                  }));
                  return;
                } else {
                  res.set("Connection", "close");
                  res.end(JSON.stringify({
                    registration: {
                      success: false,
                      status: "insert_failed"
                    }
                  }));
                }
              });

            });

        } else {

          console.log("[OID:" + owner +
            "] [DEVICE_NEW] New device: " + JSON.stringify(
              reg));

          // MQTT
          CMD = "mosquitto_passwd -b mqtt_passwords " + udid +
            " " +
            api_key;
          var temp = exec.execSync(CMD).stdour;
          console.log("[REGISTER] Creating mqtt account...");
          if (temp) {
            console.log("[REGISTER_ERROR] MQTT: " + temp);
          }

          device.udid = uuidV1();
          device.source = null;

          device.lastupdate = new Date();
          if (typeof(fw) !== undefined && fw !== null) {
            device.firmware = fw;
          }
          if (typeof(hash) !== undefined && hash !== null) {
            device.hash = hash;
          }
          if (typeof(push) !== undefined && push !== null) {
            device.push = push;
          }
          if (typeof(alias) !== undefined && alias !== null) {
            device.alias = alias;
          }

          console.log("Inserting device..." + JSON.stringify(
            device));

          devicelib.insert(device, mac, function(err, body,
            header) {
            if (!err) {
              console.log("Device info created.");
              res.set("Connection", "close");
              res.end(JSON.stringify({
                registration: {
                  success: true,
                  owner: owner,
                  alias: device.alias,
                  udid: device.udid,
                  status: "OK"
                }
              }));
              return;
            } else {
              reg.success = false;
              reg.this.status = "Insert failed";
              console.log("Device record update failed." +
                err);
              console.log("CHECK6:");
              console.log(reg);
              console.log("CHECK6.1:");
              console.log(rdict);
              sendRegistrationOKResponse(res, rdict);
            }
          });
        }
      });
    });
  });

  // Device editing (alias only so far)
  app.post("/api/device/edit", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    if (typeof(req.body.changes) === "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_changes"
      }));
      return;
    }

    var owner = req.session.owner;
    var username = req.session.username;
    var changes = req.body.changes;

    //console.log("CHANGES: " + JSON.stringify(changes));

    var change = changes; // TODO: support bulk operations

    var udid = changes.udid;

    // TODO: Support bulk operations
    if (typeof(udid) === "undefined") {
      console.log("WARNING! Bulk operations not supported".red);
      change = changes[0];
    }



    if (udid === null) {
      res.end(JSON.stringify({
        success: false,
        status: "missing_udid"
      }));
      return;
    }

    devicelib.view("devicelib", "devices_by_owner", {
        key: owner,
        include_docs: true
      },

      function(err, body) {

        if (err) {
          console.log(err);
          res.end(JSON.stringify({
            success: false,
            status: "device_not_found"
          }));
          return;
        }

        if (body.rows.length === 0) {
          console.log(JSON.stringify(body));
          res.end(JSON.stringify({
            success: false,
            status: "no_such_device"
          }));
          return;
        }

        var doc = null;

        for (var dindex in body.rows) {
          var dev = body.rows[dindex].value;
          if (udid.indexOf(dev.udid) != -1) {
            doc = dev;
            break;
          }
        }

        if (doc === null) {
          res.end(JSON.stringify({
            success: false,
            status: "no_such_device"
          }));
          return;
        }

        // make sure we don't destroy whole database
        if (typeof(doc) === "undefined" || (doc === null)) {
          res.end(JSON.stringify({
            success: false,
            status: "device_not_found",
            err_udid: udid
          }));
          return;
        }

        // Delete device document with old alias
        devicelib.destroy(doc._id, doc._rev, function(err) {

          delete doc._rev;

          if (err) {
            console.log("/api/device/edit ERROR:" + err);
            res.end(JSON.stringify({
              success: false,
              status: "destroy_failed"
            }));
            return;
          }

          if (typeof(change.alias) !== "undefined") {
            doc.alias = change.alias;

          }

          if (typeof(change.avatar) !== "undefined") {
            doc.avatar = change.avatar;

          }

          devicelib.destroy(doc._id, doc._rev, function(err) {

            delete doc._rev;

            // Create device document with new alias
            devicelib.insert(doc, doc._id, function(err, body,
              header) {
              if (err) {
                console.log("/api/device/edit ERROR:" +
                  err);
                res.end(JSON.stringify({
                  success: false,
                  status: "device_not_changed"
                }));
                return;
              } else {
                res.end(JSON.stringify({
                  success: true,
                  change: change
                }));
              }
            });
          });
        });
      });
  });

  function sendRegistrationOKResponse(res, dict) {
    var json = JSON.stringify(dict);
    res.set("Connection", "close");
    res.end(json);
  }

  function failureResponse(res, code, reason) {
    res.writeHead(code, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      "reason": reason
    }));
  }

  function validateRequest(req, res) {
    // Check device user-agent
    var ua = req.headers["user-agent"];
    var validity = ua.indexOf(client_user_agent);

    if (validity === 0) {
      return true;
    } else {
      console.log("User-Agent: " + ua + " invalid!");
      res.writeHead(401, {
        "Content-Type": "text/plain"
      });
      res.end("validate: Client request has invalid User-Agent.");
      return false;
    }
  }

  function validateSecureGETRequest(req, res) {
    // Only log webapp user-agent
    var ua = req.headers["user-agent"];

    if (req.method != "GET") {
      console.log("validateSecure: Not a get request.");
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
        }
      });
      return false;
    }
    return true;
  }

  function validateSecureDELETERequest(req, res) {
    var ua = req.headers["user-agent"];
    if (req.method != "DELETE") {
      console.log("validateSecure: Not a delete request.");
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
        }
      });
      return false;
    }
    return true;
  }

  function validateSecurePOSTRequest(req, res) {
    var ua = req.headers["user-agent"];
    if (req.method != "POST") {
      console.log("validateSecure: Not a post request.");
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
        }
      });
      return false;
    }
    return true;
  }

  function validateSession(req, res) {
    var sessionValid = false;
    if (typeof(req.session.owner) !== "undefined") {
      if (typeof(req.session.username) !== "undefined") {
        sessionValid = true;
      } else {
        console.log("validateSession: No username!");
      }
    } else {
      console.log("validateSession: No owner!");
    }
    if (sessionValid === false) {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          console.log(
            "validateSession: Invalid session, redirecting to login!"
          );
          res.redirect("http://rtm.thinx.cloud:80/"); // redirects browser, not in XHR?
        }
      });
    }
    return sessionValid;
  }

  /*
   * Builder
   */

  // Build respective firmware and notify target device(s)
  app.post("/api/build", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var rdict = {};

    var owner = req.session.owner;
    var username = req.session.username;
    var build = req.body.build; // build descriptor wrapper	;

    var dryrun = false;
    if (typeof(build.dryrun) != "undefined") {
      dryrun = build.dryrun;
    }

    var udid = null;
    if (typeof(build.udid) !== "undefined") {
      udid = build.udid;
    } else {
      res.end(JSON.stringify({
        success: false,
        status: "missing_device_udid"
      }));
      return;
    }

    if (typeof(build.source_id) === "undefined") {
      return res.end(JSON.stringify({
        success: false,
        status: "missing_source_id"
      }));
    }

    devicelib.view("devicelib", "devices_by_owner", {
      "key": owner,
      "include_docs": true
    }, function(err, body) {



      if (err) {
        if (err.toString() == "Error: missing") {
          res.end(JSON.stringify({
            result: "no_devices"
          }));
        }
        console.log("/api/build: Error: " + err.toString());
        return;
      }

      var rows = body.rows; // devices returned
      var device = null;

      for (var row in rows) {
        device = rows[row].doc;
        var db_udid = device.udid;



        var device_owner = device.owner;

        if (device_owner.indexOf(owner) !== -1) {

          if (udid.indexOf(db_udid) != -1) {
            udid = device.udid; // target device ID
            break;
          }
        }
        // will deprecate when all devices will be re-registered using owner and not username
        if (typeof(username) !== "undefined") {
          if (username.indexOf(device.owner) !== -1) {
            if (udid.indexOf(db_udid) != -1) {
              udid = device.udid; // target device ID hash
              break;
            }
          }
        }
      }

      // Converts build.git to git url by seeking in users' repos
      userlib.get(owner, function(err, doc) {

        if (err) {
          console.log(err);
          res.end(JSON.stringify({
            success: false,
            status: "api_build-device_fetch_error"
          }));
          return;
        }

        if (typeof(doc) === "undefined") {
          res.end(JSON.stringify({
            success: false,
            status: "no_such_owner"
          }));
          return;
        }

        var git = null;

        // Finds first source with given source_id
        var sources = Object.keys(doc.repos);


        for (var index in sources) {
          var source = doc.repos[sources[index]];
          var source_id = sources[index];

          if (source_id.indexOf(build.source_id) !== -1) {
            git = source.url;
            console.log("[API-BUILD]: " + git);
            break;
          }
        }

        console.log("[API-BUILD] udid: " + udid);
        console.log("[API-BUILD] owner: " + owner);
        console.log("[API-BUILD] git: " + git);

        if ((typeof(udid) === "undefined" || build === null) ||
          (typeof(owner) === "undefined" || owner === null) ||
          (typeof(git) === "undefined" || git === null)) {
          rdict = {
            build: {
              success: false,
              status: "invalid_params"
            }
          };

          res.end(JSON.stringify(rdict));
          return;
        }

        var build_id = uuidV1();

        if (dryrun === false) {
          rdict = {
            build: {
              success: true,
              status: "Build started.",
              id: build_id
            }
          };
        } else {
          rdict = {
            build: {
              success: true,
              status: "Dry-run started. Build will not be deployed.",
              id: build_id
            }
          };
        }

        res.end(JSON.stringify(rdict));

        buildCommand(build_id, owner, git, udid, dryrun);

      });
    });
  });

  function buildCommand(build_id, owner, git, udid, dryrun) {

    console.log("[BUILD_STARTED] Executing build chain...");

    var exec = require("child_process").exec;
    CMD = "./builder --owner=" + owner + " --udid=" + udid + " --git=" +
      git +
      " --id=" + build_id;

    if (dryrun === true) {
      CMD = CMD + " --dry-run";
    }

    blog.log(build_id, owner, udid, "Running build...");

    console.log("[OID:" + owner + "] [BUILD_STARTED] Running /...");

    var temp = exec.execSync(CMD).stdout; // .replace("\n", "");

    console.log("[OID:" + owner + "] [BUILD_COMPLETED] sexec-stdout: " + temp); // TODO: Store to logfile

    var log_path = '/var/www/html/bin/' + owner + '/' + udid + '/' + build_id +
      '.log';

    fs.writeFile(log_path, temp, function(err) {
      if (err) {
        console.log(err);
      }
    });

    console.log("[OID:" + owner + "] [BUILD_STARTED] Running normal-exec...");
    exec(CMD, function(err, stdout, stderr) {
      if (err) {
        blog.log(build_id, owner, udid, "Build start failed.");
        console.log("[OID:" + owner +
          "] [BUILD_FAIL] Build start failed (err).");
        console.error("err: " + err);
        return;
      }
      if (stderr) {
        blog.log(build_id, owner, udid, stderr);
        console.log("[OID:" + owner +
          "] [BUILD_FAIL] Build start failed (stderr).");
        console.error("stderr:" + stderr);
      }

      blog.log(build_id, owner, udid, stdout);
    });

    blog.log(build_id, owner, udid, temp);
  }

  /*
   * Build and Audit Logs
   */

  /* Returns all audit logs per owner */
  app.get("/api/user/logs/audit", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    alog.fetch(owner, function(err, body) {

      if (err !== false) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "log_fetch_failed",
          error: err
        }));
        return;
      }

      if (!body) {
        console.log("Log for owner " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "log_fetch_failed",
          error: err
        }));
        return;
      }

      res.end(JSON.stringify({
        success: true,
        logs: body
      }));
    });
  });

  /* Returns list of build logs for owner */
  app.get("/api/user/logs/build/list", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    if (typeof(owner) === "undefined") {
      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "session_failed",
          error: err
        }));
        return;
      }
    }

    blog.list(owner, function(err, body) {

      if (err !== null) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "build_list_failed",
          error: err
        }));
        return;
      }

      if (!body) {
        console.log("Log for owner " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "build_list_empty",
          error: err
        }));
        return;
      }

      var builds = [];
      for (var bindex in body.rows) {
        var row = body.rows[bindex];

        for (var dindex in row.doc.log) {
          var lastIndex = row.doc.log[dindex];
          var build = {
            message: lastIndex.message,
            date: lastIndex.date,
            udid: lastIndex.udid,
            build_id: lastIndex.build
          };
          builds.push(build);
        }
      }

      res.end(JSON.stringify({
        success: true,
        builds: builds
      }).replace("\n", "<br/>"));

    });
  });

  /* Returns specific build log for owner */
  app.post("/api/user/logs/build", function(req, res) {

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.build_id) == "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_build_id"
      }));
      return;
    }

    var build_id = req.body.build_id;

    blog.fetch(req.body.build_id, function(err, body) {

      if (err) {
        console.log(err);
        res.end(JSON.stringify({
          success: false,
          status: "build_fetch_failed",
          error: err
        }));
        return;
      }

      if (!body) {
        console.log("Log for owner " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "build_fetch_empty",
          error: err
        }));
        return;
      }

      var logs = [];
      for (var lindex in body.rows) {
        var lrec = body.rows[lindex].value.log;
        logs.push(lrec);
      }

      console.log("Build-logs for build_id " + build_id + ": " + JSON
        .stringify(
          logs));

      var response = body;
      response.success = true;
      res.end(JSON.stringify(response));
    });
  });

  // WARNING! New, untested!

  /* Returns specific build log for owner */
  app.post("/api/user/logs/tail", function(req, res) {

    // TODO: Time-out after about 60 seconds of no activity...

    if (!validateSecurePOSTRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;
    var username = req.session.username;

    if (typeof(req.body.build_id) == "undefined") {
      res.end(JSON.stringify({
        success: false,
        status: "missing_build_id"
      }));
      return;
    }

    var build_id = req.body.build_id;

    console.log("Tailing build log for " + build_id);

    var error_callback = function(err) {
      console.log(err);
      // TODO: XHR Response implementation missing
      res.set("Connection", "close");
      res.end(JSON.stringify(err));
    };

    blog.logtail(req.body.build_id, owner, _ws, error_callback);

  });



  /*
   * Authentication
   */

  // Front-end authentication, returns session on valid authentication
  app.post("/api/login", function(req, res) {

    var client_type = "webapp";
    var ua = req.headers["user-agent"];
    var validity = ua.indexOf(client_user_agent);

    if (validity === 0) {
      console.log(ua);
      client_type = "device";
    }

    // Request must be post
    if (req.method != "POST") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 500, "protocol");
          console.log("Not a post request.");
          return;
        }
      });
    }
    var username = req.body.username;
    var password = sha256(req.body.password);

    if (typeof(username) == "undefined" || typeof(password) ==
      "undefined") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        } else {
          failureResponse(res, 403, "unauthorized");
          console.log("User unknown.");
          return;
        }
      });
    }



    userlib.view("users", "owners_by_username", {
      "key": username,
      "include_docs": true // might be useless
    }, function(err, body) {

      if (err) {
        console.log("Error: " + err.toString());
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            failureResponse(res, 403, "unauthorized");
            console.log("Owner not found: " + username);
            return;
          }
        });
        return;
      }

      // Find user and match password
      var all_users = body.rows;
      for (var index in all_users) {
        var user_data = all_users[index];
        if (username == user_data.key) {

          // TODO: Second option (direct compare) will deprecate soon.
          if (password.indexOf(user_data.value) !== -1) {

            if (typeof(req.session === "undefined")) {
              console.log("ERROR, no session!");
            }

            req.session.owner = user_data.doc.owner; // what if there's no session?
            console.log("[OID:" + req.session.owner +
              "] [NEW_SESSION]");
            req.session.username = user_data.doc.username;

            var minute = 5 * 60 * 1000;
            req.session.cookie.httpOnly = true;
            req.session.cookie.maxAge = 20 * minute;
            req.session.cookie.secure = false;

            alog.log(req.session.owner, "User logged in: " +
              username);

            // TODO: write last_seen timestamp to DB here __for devices__
            // console.log("client_type: " + client_type);
            if (client_type == "device") {
              res.end(JSON.stringify({
                status: "WELCOME",
                success: true
              }));
              return;
            } else if (client_type == "webapp") {
              res.end(JSON.stringify({
                "redirectURL": "http://rtm.thinx.cloud:80/app"
              }));
              return;
            } else {
              res.end(JSON.stringify({
                status: "OK",
                success: true
              }));
            }
            // TODO: If user-agent contains app/device... (what?)
            return;

          } else {
            console.log("[PASSWORD_INVALID] for " + username);
            alog.log(req.session.owner, "Password mismatch for: " +
              username);
            res.end(JSON.stringify({
              status: "password_mismatch",
              success: false
            }));
            return;
          }
        }
      }

      if (typeof(req.session.owner) == "undefined") {
        if (client_type == "device") {
          return;
        } else if (client_type == "webapp") {
          res.redirect("http://rtm.thinx.cloud:80/"); // redirects browser, not in XHR?
          return;
        }

        console.log("login: Flushing session: " + JSON.stringify(
          req.session));
        req.session.destroy(function(err) {
          if (err) {
            console.log(err);
          } else {
            res.end(JSON.stringify({
              success: false,
              status: "no session (owner)"
            }));
            console.log("Not a post request.");
            return;
          }
        });
      } else {
        failureResponse(res, 403, "unauthorized");
      }
    });
  });

  // Front-end authentication, destroys session on valid authentication
  app.get("/api/logout", function(req, res) {
    if (typeof(req.session) !== "undefined") {
      req.session.destroy(function(err) {
        if (err) {
          console.log(err);
        }
      });
    }
    res.redirect("http://rtm.thinx.cloud/"); // HOME_URL (Apache)
  });

  /*
   * Statistics
   */

  /* Returns all audit logs per owner */
  app.get("/api/user/stats", function(req, res) {

    if (!validateSecureGETRequest(req)) return;
    if (!validateSession(req, res)) return;

    var owner = req.session.owner;

    stats.today(owner, function(success, body) {
      if (!success) {
        res.end(JSON.stringify({
          success: false,
          status: "stats_fetch_failed"
        }));
        return;
      }
      if (!body) {
        console.log("Statistics for owner " + owner + " not found.");
        res.end(JSON.stringify({
          success: false,
          status: "no_results"
        }));
        return;
      }
      res.end(JSON.stringify({
        success: true,
        stats: JSON.parse(body)
      }));
    });
  });

  /** Tested with: !device_register.spec.js` */
  app.get("/", function(req, res) {
    console.log("/ called with owner: " + req.session.owner);
    if (req.session.owner) {
      res.redirect("http://rtm.thinx.cloud:80/app");
    } else {
      res.end("This is API ROOT."); // insecure
    }
  });

  /*
   * HTTP/HTTPS API Server
   */

  app.version = function() {
    return v.revision();
  };

  var options = {
    key: fs.readFileSync(app_config.ssl_key),
    cert: fs.readFileSync(app_config.ssl_cert)
  };

  // FIXME: Link to letsencrypt SSL keys using configuration for CircleCI

  /*
   * HTTP/S Server
   */

  https.createServer(options, app).listen(serverPort + 1);
  http.createServer(app).listen(serverPort);

  /*
   * WebSocket Server
   */

  var wsapp = express();
  var wserver = http.createServer(wsapp);
  var wss = new WebSocket.Server({
    port: socketPort,
    server: wserver
  });

  var _ws = null;
  this.ws = "2";

  wss.on('connection', function connection(ws, req) {

    console.log("» Websocket Connection.");

    _ws = ws;

    var location = url.parse(req.url, true);
    console.log("WSS connection on location: " + JSON.stringify(location));
    console.log("WSS cookie: " + req.headers.cookie);

    var query = location.path.split("/");

    var owner_id = query[1].replace("/", "");
    var build_id = query[2].replace("/", "");

    var logtail_callback = function(err) {
      console.log("[index.js] logtail_callback:" + err);
    };

    ws.on("message", function incoming(message) {
      console.log("» Websocket incoming message: %s", message);
      var object = JSON.parse(message);
      if (typeof(object.logtail) !== "undefined") {
        console.log("» Websocket logtail request: %s", JSON.stringify(
          object.logtail));
        var build_id = object.logtail.build_id;
        var owner_id = object.logtail.owner_id;
        console.log("[index.js] requesting logtail for ws:" + JSON.stringify(
          _ws));
        blog.logtail(build_id, owner_id, _ws, logtail_callback);
      } else {
        console.log("» Websocketparser said: unknown message");
      }
    });

    // Start tailing log
    if ((typeof(build_id) !== "undefined") && (typeof(owner_id) !==
        "undefined")) {
      blog.logtail(build_id, owner_id, ws, logtail_callback);
      return;
    }

    try {
      var welcome_message = {
        notification: {
          title: "Live Feed Connected",
          body: "Live notifications and log view available."
        }
      };
      ws.send(JSON.stringify(welcome_message));
    } catch (e) { /* handle error */ }
  });

  wserver.listen(7444, function listening() {
    console.log('» WebSocket listening on port %d', wserver.address().port);
  });


  /*
   * Bootstrap banner section
   */

  var package_info = require("./package.json");
  var product = package_info.description;
  var version = package_info.version;

  console.log("");
  console.log("-=[ ☢ " + product + " v" + version +
    " rev. " +
    app.version() +
    " ☢ ]=-");
  console.log("");
  console.log("» Started on port " +
    serverPort +
    " (HTTP) and " + (serverPort +
      1) +
    " (HTTPS)");

  /* Should load all devices with attached repositories and watch those repositories.
   * Maintains list of watched repositories for runtime handling purposes.
   * TODO: Re-build on change.
   */

  var watcher_callback = function(result) {
    if (typeof(result) !== "undefined") {
      console.log("watcher_callback result: " + JSON.stringify(result));
      //watched_repos.splice(watched_repos.indexOf(path));
      if (result === false) {
        console.log(
          "No change detected on repository so far."
        );
      } else {
        // watcher_callback result: {"local_path":"/var/www/html/bin/8beef0c4f4a758c32bcf4f52fa59d401e9400bbe97d302d22f2b837f0b88d616/e52bfe40-3726-11e7-915b-933ab4410309","version":747,"revision":"27ee5b4cd3eee787d60dd7deccc2a2a6d34f3a92","changed":true}
        console.log(
          "CHANGE DETECTED! - TODO: Commence re-build (will notify user but needs to get all required user data first (owner/device is in path)"
        );
      }
    } else {
      console.log("watcher_callback: no result");
    }
  };

  var initWatcher = function(watcher) {

    devicelib.view("devicelib", "watcher_view", {
      "include_docs": true
    }, function(err, body) {

      if (err) {
        console.log(err);
        return;
      }

      console.log("» Starting GIT watcher...");

      for (var index in body.rows) {
        var owner = body.rows[index].doc.owner;
        var udid = body.rows[index].doc.udid;
        var path = deploy.pathForDevice(owner, udid);

        if (!fs.existsSync(path)) {
          continue;
        } else {
          console.log("Trying to watch path: " + path);
          if (fs.lstatSync(path).isDirectory()) {
            watcher.watchRepository(path, watcher_callback);
            watched_repos.push(path);
          } else {
            console.log(path + " is not a directory.");
          }
        }
      }
    });
  };

  initWatcher(watcher);

  //
  // Database compactor
  //

  var database_compactor = function() {
    console.log("» Running database compact jobs...");
    nano.db.compact("builds");
    nano.db.compact("devicelib");
    nano.db.compact("logs");
    nano.db.compact("users");
    console.log("» Database compact jobs completed.");
  };

  var COMPACT_TIMEOUT = 30000;
  var database_compact_timer = setTimeout(database_compactor,
    COMPACT_TIMEOUT);

  //
  // Log aggregator
  //

  var log_aggregator = function() {
    console.log("» Running log aggregation jobs...");
    stats.aggregate();
    console.log("» Aggregation jobs completed.");
  };

  var AGGREGATOR_TIMEOUT = 3600000;
  var log_aggregator_timer = setTimeout(log_aggregator,
    AGGREGATOR_TIMEOUT);

  //
  // Safe-mode (Prevent crashes on uncaught exceptions)
  //

  if (app_config.safe_mode === true) {
    process.on("uncaughtException", function(err) {
      console.log("» Caught exception: " + err);
    });
  } else {
    console.log("» Safe mode disabled. App will exit and log on exception.");
  }
};

var thx = new ThinxApp();

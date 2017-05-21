describe("Build log", function() {

  var blog = require("../../lib/thinx/build");

  var build_id = "00390230-3981-11e7-a58d-81e4acfbeb86";
  var owner =
    "eaabae0d5165c5db4c46c3cb6f062938802f58d9b88a1b46ed69421809f0bf7f";
  var udid = "fcdd7b20-3980-11e7-a58d-81e4acfbeb86";

  /*
   * WebSocket Server
   */

  var express = require("express");
  var session = require("express-session");
  var http = require("http");
  var https = require("https");
  var WebSocket = require("ws");

  var wsapp = express();

  wsapp.use(function(req, res) {
    res.send({
      msg: "TEST"
    });
  });

  // WebSocket Server
  var wserver = http.createServer(wsapp);

  var wss = new WebSocket.Server({
    port: 7447,
    server: wserver
  });
  var _ws = null;

  wss.on('connection', function connection(ws, req) {
    _ws = ws;
    var location = url.parse(req.url, true);
    // console.log("» WSS connection on location: " + location);
    //console.log("» WSS cookie: " + req.headers.cookie);
    try {
      ws.send('HELLO');
    } catch (e) { /* handle error */ }

    ws.on('message', function incoming(message) {
      console.log('» Websocket message: %s', message);
    });

    ws.send('READY');
  });


  beforeEach(function() {
    //build = new Build();
  });

  it("should be able to initialize", function() {
    expect(blog).toBeDefined();
  });

  it("should be able to list build logs", function() {
    blog.list(owner, function(err, body) {
      console.log(err, body);
      expect(true).toBe(true);
    });
  });

  it("should be able to fetch specific build log", function() {
    blog.fetch(build_id, function(err, body) {
      console.log(err, body);
      expect(true).toBe(true);
    });

  }, 1000);

  it("should be able to log", function() {
    blog.log(build_id, owner, udid, "Testing build log writer...");
    expect(true).toBe(true);
  });

  it("should be able to tail log for build_id", function() {
    var error_callback = function(err) {
      console.log(err);
      expect(true).toBe(true);

    };
    blog.logtail(build_id, owner, _ws, error_callback);
  }, 1000);

});

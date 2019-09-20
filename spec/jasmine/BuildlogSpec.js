describe("Build log", function() {

  var BuildLog = require("../../lib/thinx/buildlog");
  var blog = new BuildLog();

  var envi = require("./_envi.json");
  var owner = envi.oid;
  var udid = envi.udid;
  var apikey = envi.ak;

  var build_id = envi.build_id; // "f168def0-597f-11e7-a932-014d5b00c004";

  /*
   * WebSocket Server
   */

  it("should be able to initialize", function() {
    expect(blog).toBeDefined();
  });

  it("should be able to list build logs", function(done) {
    blog.list(owner, function(err, body) {
      console.log(err, body);
      expect(body).toBeDefined();
      done();
    });
  }, 15000);

  it("should be able to fetch specific build log", function(done) {
    blog.fetch(build_id, function(err, body) {
      console.log(err, body);
      expect(err).toBeDefined();
      done();
    });
  }, 10000);

  it("should be able to log", function(done) {
    blog.log(build_id, owner, udid, "Testing build log create...");
    done();
  });

  it("should be able to append existing log", function(done) {
    blog.log(build_id, owner, udid, "Testing build log append...");
    done();
  });

  it("should be able to tail log for build_id", function(done) {
    const no_socket = null;
    blog.logtail(build_id, require("./_envi.json").oid, no_socket, function(err) {
        console.log(err);
        expect(err).toBe(false);
        done();
      });
  });

  it("should provide path for device", function() {
    var path = blog.pathForDevice(owner, udid);
    console.log("path: "+path);
    expect(path).toBeDefined();
  });

});

/*
 * This THiNX-RTM API module is responsible for managing deployment data.
 */

var Deployment = (function() {

	var fs = require("fs-extra");
	var util = require("util");
	var semver = require("semver");
	var mkdirp = require("mkdirp");
	var typeOf = require("typeof");
	var finder = require("fs-finder");

	var builder = require("./builder");

	var app_config = require("../../conf/config.json");
	if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
		console.log("» Configuring for Circle CI...");
		app_config = require("../../conf/config-test.json");
	}

	var _private = {

		getFiles: function(dir, files_) {
			files_ = files_ || [];
			if (!fs.existsSync(dir)) {
				return null;
			}
			return finder.from(dir).findFiles();
		},

		pathForOwner: function(owner) {
			var user_path = app_config.project_root + app_config.deploy_root + "/" +
				owner;
			return user_path;
		}

	};

	// public
	var _public = {

		initWithDevice: function(device) {
			this.device = device;
			this.owner = device.owner;
			this.udid = device.udid;
			this.version = device.version;
			_public.initWithOwner(this.owner, null, function(success, response) {
				console.log("initWithDevice -- success:" + success + " response" +
					response);
			});
		},

		initWithOwner: function(owner) {

			this.owner = owner;
			var user_path = _private.pathForOwner(owner);
			if (typeof(user_path) === "undefined" || user_path === null) return;

			fs.lstat(user_path, function(err, stats) {
				if (err) {
					if (err.errno == -2) {
						mkdirp(user_path, function(err) {
							if (err) console.log(err);
							else console.log(user_path + " created.");
						});
					} else {
						return console.log(err);
					}
				}
				if (!fs.existsSync(user_path)) {
					mkdirp(user_path, function(err) {
						if (err) console.log(err);
						else console.log(user_path + " created.");
					});
				}
			});
		},

		pathForDevice: function(owner, udid) {
			this.owner = owner;
			this.udid = udid;
			var user_path = _private.pathForOwner(owner);
			var device_path = user_path + "/" + udid;
			console.log("pathForDevice: " + device_path);
			return device_path;
		},

		latestFirmwarePath: function(owner, udid) {

			if (typeOf(owner) == "Object") {
				console.log("Suspicious owner: " + JSON.stringify(owner));
			}

			var dpath = _public.pathForDevice(owner, udid);
			var files = finder.from(dpath).findFiles(builder.supportedExtensions());

			console.log("filesForDevice: " + JSON.stringify(files));

			var latest_date = 0;
			var latest_firmware = null;
			for (var index in files) {
				var filename = files[index];
				var stats = fs.statSync(files[index]);
				var mtime = new Date(util.inspect(stats.mtime));
				if (mtime > latest_date) {
					latest_date = mtime;
					latest_firmware = filename;
				}
			}

			console.log("filesForDevice: latest: " + latest_firmware);

			return latest_firmware;
		},

		latestFirmwareVersion: function(owner, udid) {
			var envelope = _public.latestFirmwareEnvelope(owner, udid);
			if (envelope !== null) {
				return envelope.version;
			} else {
				return "0.0.0"; // no firmware
			}
		},

		latestFirmwareEnvelope: function(owner, udid) {
			var path = _public.pathForDevice(owner, udid);
			if (path !== null) {
				var envpath = path + "/build.json";
				if (fs.existsSync(envpath) && fs.statSync(envpath).size > 2) {
					var envelope = require(envpath);
					console.log("[LFP] envelope: " + JSON.stringify(envelope) +
						" at path " +
						envpath);
					return envelope;
				} else {
					console.log("[LFP] envelope not found at path " +
						envpath);
					return false;
				}
			} else {
				return false;
			}
		},

		hasUpdateAvailable: function(device) {
			this.device = device;
			this.owner = device.owner;
			this.udid = device.udid;

			var deviceVersion = device.version;
			if (typeof(deviceVersion) === "undefined" || deviceVersion === null) {
				deviceVersion = "0.0.1";
			}
			var pattern = /[0-9.]/;
			console.log(new RegExp(pattern).test(deviceVersion));
			console.log("[hasUpdateAvailable] Device version: " + deviceVersion);

			if (!semver.valid(deviceVersion)) {
				var device_version = [0, 0, 0];
				var dev_version_array = deviceVersion.split(".");
				for (var index1 in dev_version_array) {
					device_version[index1] = dev_version_array[index1];
				}
				deviceVersion = device_version.join(".");
				console.log(
					"[hasUpdateAvailable] Device version had invalid semantic versioning: " +
					deviceVersion);
			}

			var deployedVersion = _public.latestFirmwareVersion(this.owner, this.udid);

			if (typeof(deployedVersion) === "undefined") {
				deployedVersion = "0.0.0";
				return false;
			}

			console.log("[hasUpdateAvailable] Deployed version: " + deployedVersion);

			if (!semver.valid(deployedVersion)) {
				console.log(
					"[hasUpdateAvailable] Deployed version has invalid semantic versioning: " +
					deployedVersion);
				var deployment_version = [0, 0, 0];
				var dep_version_array = deployedVersion.split(".");
				for (var index2 in dep_version_array) {
					deployment_version[index2] = dep_version_array[index2];
				}
				deployedVersion = deployment_version.join(".");
				console.log(
					"[hasUpdateAvailable] Deployed version fixed to: " +
					deployedVersion);
			}

			if (semver.lt(deviceVersion, deployedVersion)) {
				console.log("Deployed version is newer than device version.");
				return true;
			} else {
				console.log("Device version is newer than deployed version.");
				return false;
			}
		}
	};

	return _public;

})();

exports.init = Deployment.init;
exports.initWithDevice = Deployment.initWithDevice;
exports.initWithOwner = Deployment.initWithOwner;
exports.pathForDevice = Deployment.pathForDevice;
exports.latestFirmwarePath = Deployment.latestFirmwarePath;
exports.hasUpdateAvailable = Deployment.hasUpdateAvailable;
exports.latestFirmwareVersion = Deployment.latestFirmwareVersion;
exports.latestFirmwareEnvelope = Deployment.latestFirmwareEnvelope;

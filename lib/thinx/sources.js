/** This THiNX-RTM API module is responsible for managing Sources. */

var Sources = (function() {

	var app_config = require("../../conf/config.json");
	if (typeof(process.env.CIRCLE_USERNAME) !== "undefined") {
		console.log("» Configuring for Circle CI...");
		app_config = require("../../conf/config-test.json");
	}
	var db = app_config.database_uri;

	var prefix = "";
	try {
		var pfx_path = app_config.project_root + '/conf/.thx_prefix';
		if (fs.existsSync(pfx_path)) {
			prefix = fs.readFileSync(pfx_path) + "_";
		}
	} catch (e) {
		//console.log(e);
	}

	var userlib = require("nano")(db).use(prefix + "managed_users");
	var devicelib = require("nano")(db).use(prefix + "managed_devices");
	var watcher = require("./repository");

	var mkdirp = require("mkdirp");
	var sha256 = require("sha256");
	var exec = require("child_process");
	var fs = require("fs");
	var path = require("path");

	// public
	var _public = {

		/**
		 * List:
		 */

		list: function(owner, callback) {
			userlib.get(owner, function(err, doc) {

				if (err) {
					console.log(err);
					callback(false, err);
					return;
				}

				if (!doc) {
					console.log("Owner " + owner + " not found.");
					callback(false, "user_not_found");
					return;
				}

				callback(true, doc.repos);
			});
		},

		/**
		 * Add
		 */

		add: function(owner, alias, url, branch, callback) {

			var source = {
				alias: alias,
				url: url,
				branch: branch
			};

			if (typeof(owner) === "undefined") {
				callback(false, "owner_undefined");
			}

			// Prefetch and infer platform... (may take a while)

			var OWNER_PATH = app_config.project_root + app_config.build_root + "/" +
				owner;

			console.log("[add] owner path: " + OWNER_PATH);

			var REPO_PATH = OWNER_PATH + "/" + alias;

			console.log("[add] repo path: " + REPO_PATH);

			mkdirp(REPO_PATH, function(err) {
				if (err) {
					console.log(err);
					callback(false, err);
					return;
				}

				try {
					var CLEANUP = "cd " + REPO_PATH + "; rm -rf *";
					exec.execSync(CLEANUP);
				} catch (e) {
					//
				}

				var origin_branch = branch.replace("origin/", "");
				var CMD = "cd " + REPO_PATH + "; git clone -b " + origin_branch +
					" " + url +
					"; cd *; echo { \"basename\":\"$(basename $(pwd))\", \"branch\":\"" +
					origin_branch + "\" } > basename.json; cat basename.json";

				if (branch === null) {
					CMD = "cd " + REPO_PATH + "; git clone " + url +
						"; cd *; echo { \"basename\":\"$(basename $(pwd))\", \"branch\":\"" +
						branch + "\" } > basename.json; cat basename.json";
				}

				var result = null;

				try {

					result = exec.execSync(CMD).toString().replace("\n", "");

					console.log("git clone result: " + result);

				} catch (e) {
					console.log(
						"GIT Fetch Failed: " +
						e);
					callback(false, "Git fetch failed.");
					return;
				}

				var directories = fs.readdirSync(REPO_PATH).filter(
					file => fs.lstatSync(path.join(REPO_PATH, file)).isDirectory()
				);

				console.log("Directories in: " + REPO_PATH + " = "+ JSON.stringify(directories));

				var REPO_INNER_PATH = REPO_PATH + "/";

				if (typeof(directories[0]) !== "undefined") {
					REPO_INNER_PATH = REPO_PATH + "/" + directories[0];
				} else {
					console.log("No subdirectories found in " + REPO_INNER_PATH);
				}

				console.log("REPO_INNER_PATH: " + REPO_INNER_PATH);

				/*
								watcher.checkRepositoryChange(REPO_INNER_PATH, false, function(err,
									result) {

									if (err) {
										console.log(err);
										callback(false, err);
										return;
									}*/

				source.platform = watcher.getPlatform(REPO_INNER_PATH);
				source.initial_platform = source.platform; // should happen only on add

				userlib.get(owner, function(err, doc) {

					if (err) {
						console.log(err);
						callback(false, err);
						return;
					}

					if (!doc) {
						console.log("Owner " + owner + " not found.");
						callback(false, "user_not_found");
						return;
					}

					// Update user with new repos
					userlib.destroy(doc._id, doc._rev, function(err) {
						delete doc._rev;
						var sid = sha256(JSON.stringify(source) + new Date().toString());
						doc.repos[sid] = source;
						userlib.insert(doc, doc._id, function(err, body, header) {
							if (err) {
								console.log("/api/user/source ERROR:" + err);
								callback(false, "source_not_added");
								return;
							} else {
								callback(true, {
									success: true,
									source_id: sid
								});
							}
						});
					}); // userlib
				});
			});
			//});
		},

		/**
		 * Revoke Source for owner
		 * @param {string} owner - owner._id
		 * @param {string} sources - array of source_ids to be revoked
		 * @param {function} callback(success, message) - operation result callback
		 */

		remove: function(owner, removed_sources, callback) {

			userlib.get(owner, function(err, doc) {

				if (err) {
					console.log(err);
					callback(false, err);
					return;
				}

				if (!doc) {
					console.log("Owner " + owner + " not found.");
					callback(false, "user_not_found");
					return;
				}

				var sources = doc.repos;
				var source_ids = Object.keys(sources);
				var really_removed_repos = [];
				for (var source_id in removed_sources) {
					var removed_source_id = removed_sources[source_id];
					var sources_source_id = sources[removed_source_id];
					if ((typeof(sources_source_id) !== "undefined") && (sources_source_id !== null)) {
						really_removed_repos.push(source_ids[source_id]);
						delete sources[removed_source_id];
					}
				}

				// Update user with new repos
				userlib.destroy(doc._id, doc._rev, function(err) {
					doc.repos = sources;
					delete doc._rev;
					userlib.insert(doc, doc._id, function(err, body, header) {
						if (err) {
							console.log("/api/user/source ERROR:" + err);
							callback(false, "source_not_removed");
							return;
						} else {
							callback(true, {
								success: true,
								source_ids: really_removed_repos
							});
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

						function upsert(device) {
							devicelib.destroy(device._id, device._rev, function(err) {
								delete device._rev;
								devicelib.insert(device,
									device._rev,
									function(err) {
										console.log(err);
									}
								);
							});
						}

						for (var rindex in body.rows) {

							var device;
							if (typeof(body.rows[rindex]) === "undefined") continue;
							if (body.rows[rindex].value !== null) {
								device = body.rows[rindex].value;
							}

							if ((typeof(device) === "undefined")) continue;
							if (device === null) continue;
							if (device.source === null) continue;

							for (var sindex in removed_sources) {
								var removed_source_id = removed_sources[sindex];
								if (device.source == removed_source_id) {
									console.log(
										"repo_revoke alias equal: Will destroy/insert device: " +
										device.source + " to " + source_id
									);
									device.source = null;
									upsert(device);
								}
							}

						}
					});
			});
		}

	};

	return _public;

})();

exports.list = Sources.list;
exports.add = Sources.add;
exports.remove = Sources.remove;

/**
 * Installs and caches modules from npm.
 *
 * @copyright
 * Copyright (c) 2015 by Appcelerator, Inc. All Rights Reserved.
 *
 * @license
 * Licensed under the terms of the Apache Public License.
 * Please see the LICENSE included with this distribution for details.
 */

'use strict';

module.exports.install = install;

var async = require('async');
var fs = require('fs-extra');
var npm = require('npm');
var path = require('path');
var pluralize = require('pluralize');
var Promise = Promise || require('q').Promise;
var semver = require('semver');
var tmp = require('tmp');
var rsync = require('rsync');
//var sleep = require('sleep');

/**
 * Installs a module from npm and caches it.
 *
 * @param {object} [opts] - Various options.
 * @param {boolean} [opts.allowShrinkwrap] - When true, tells npm to honor shrinkwrap settings.
 * @param {string} [opts.cacheDir=~/.npm-fast-install] - The directory to cache modules.
 * @param {string} [opts.dir=`cwd`] - The directory containing the package.json.
 * @param {stream} [opts.logger] - A logger to use such as `console`.
 * @param {number} [opts.maxTasks=5] - The maximum number of npm install jobs to run simultaneously.
 * @param {boolean} [opts.production] - When true, installs only dependencies, not dev dependencies.
 *
 * @returns {Promise} A promise object
 */
function install(opts) {
	return (new Promise(function (fulfill, reject) {
		if (!opts || typeof opts !== 'object') {
			opts = {};
		}

		// check directory
		var dir = resolvePath(opts.dir || process.cwd());
		if (!fs.existsSync(dir)) {
			return reject(new Error('Invalid directory: ' + dir));
		}

		// init logger
		var logger = opts.logger && typeof opts.logger === 'object' ? opts.logger : {};
		['log', 'debug', 'info', 'warn', 'error'].forEach(function (lvl) { typeof logger[lvl] === 'function' || (logger[lvl] = function () {}); });

		var modulesAPI = String(+process.versions.modules || (function (m) {
			return !m || m[1] === '0.8' ? 1 : m[1] === '0.10' ? 11 : m[1] === '0.11' && m[2] < 8 ? 12 : 13;
		}(process.version.match(/^v(\d+\.\d+)\.(\d+)$/))));

		logger.info('Node.js version: %s', process.version);
		logger.info('Architecture:    %s', process.arch);
		logger.info('Module version:  %s', modulesAPI);
		logger.info('npm version:     %s', npm.version + '\n');

		var deps = [];
		var cleanUpDirs = [];
		var sourceModules = [];

		if (opts.dependencies) {
			deps = Object.keys(opts.dependencies).map(function (dep) {
				return { name: dep, ver: opts.dependencies[dep] };
			});
		}
		else {
			// load the package.json
			var pkgJsonFile = path.join(dir, 'package.json');
			if (!opts.dependencies) {
				if (!fs.existsSync(pkgJsonFile)) {
					return reject(new Error('No package.json found'));
				}
				logger.info('Loading package.json: %s', pkgJsonFile);
			}
			var pkgJson = require(pkgJsonFile);
			if (pkgJson.dependencies && typeof pkgJson.dependencies === 'object') {
				deps = Object.keys(pkgJson.dependencies).map(function (dep) {
					return { name: dep, ver: pkgJson.dependencies[dep] };
				});
			}

			if (!opts.production) {
				if (pkgJson.devDependencies && typeof pkgJson.devDependencies === 'object') {
					deps = deps.concat(Object.keys(pkgJson.devDependencies).map(function (dep) {
						return { name: dep, ver: pkgJson.devDependencies[dep] };
					}));
				}
				if (pkgJson.peerDependencies && typeof pkgJson.peerDependencies === 'object') {
					deps = deps.concat(Object.keys(pkgJson.peerDependencies).map(function (dep) {
						return { name: dep, ver: pkgJson.peerDependencies[dep] };
					}));
				}
			}
		}

		var results = {
			node: process.version,
			arch: process.arch,
			modulesAPI: modulesAPI,
			modules: {}
		};

		if (!deps.length) {
			// if there are no deps, return now
			return fulfill(results);
		}

		logger.info('Found %s %s\n', deps.length, pluralize('dependency', deps.length));

		// init the cache dir
		var cacheDir = resolvePath(opts.cacheDir || '~/.npm-fast-install');
		if (!fs.existsSync(cacheDir)) {
			logger.info('Initializing cache dir: %s', cacheDir);
			fs.mkdirsSync(cacheDir);
		}

		// node_modules
		var destNodeModulesDir = path.join(dir, 'node_modules');

		// remove directory for clean install
		if (!opts.keep) {
			var destNodeModulesDirBackup = destNodeModulesDir + '.' + (new Date().getTime()) + '.bak';
			fs.existsSync(destNodeModulesDir) && fs.renameSync(destNodeModulesDir, destNodeModulesDirBackup);
		}

		// create node_modules if not present
		fs.existsSync(destNodeModulesDir) || fs.mkdirsSync(destNodeModulesDir);

		// init npm
		npm.load({
			global: false,
			production: false,
			shrinkwrap: !!opts.allowShrinkwrap,
			color: false,
			// it's impossible to completely silence npm and node-gyp
			loglevel: 'silent',
			progress: false,
			registry: 'https://npme.walmart.com/',  // TODO: read from .npmrc
			'strict-ssl': false                     // ...
			                                        // , 'dry-run': true
		}, function (err, conf) {
			if (err) { return; }

			var counts = 0;

			// top callback = cb
			async.eachLimit(deps, opts.maxTasks || 5, function (dep, cb) {

				var cb__ = function(err, message) {
					counts++;
					console.log("cb__", counts, message);
					return cb(err);
				};

				// already there -> skip
				if (semver.valid(dep.ver)) {
					var cacheModuleDir = path.join(cacheDir, dep.name, dep.ver, process.arch, modulesAPI);
					if (fs.existsSync(cacheModuleDir)) {
						sourceModules.push(cacheModuleDir);
						return cb__(null, 'cacheModuleDir already there (1) -> ' + cacheModuleDir);
					}
				}

				npm.commands.view([dep.name], true, function (err, infos) {
					if (err) { return cb(err); }

					var info = infos[Object.keys(infos).shift()];
					var ver = dep.ver === '*' || dep.ver === 'latest' ? info.version : semver.maxSatisfying(info.versions, dep.ver + ' <=' + info.version);
					if (ver === null) ver = info.version;
					var cacheModuleDir = path.join(cacheDir, dep.name, ver, process.arch, modulesAPI);
					var dest = path.join(destNodeModulesDir, dep.name);

					results.modules[dep.name] = {
						version: ver,
						path: dest,
						info: info
					};

					// do we have it cached arleady?
					if (fs.existsSync(cacheModuleDir)) {
						sourceModules.push(cacheModuleDir);
						return cb__(null, 'cacheModuleDir already there (2) -> ' + cacheModuleDir);
					}

					// need to install it
					logger.info('Fetching %s@%s', dep.name, ver);

					var tmpDir = tmp.dirSync({ prefix: 'npm-fast-install-' }).name;
					cleanUpDirs.push(tmpDir);

					// next -> next
					npm.commands.install(tmpDir, [dep.name + '@' + ver], function (err) {
						if (err) { return cb(err); }

						// JIC it shows up here some how with async
						if (fs.existsSync(cacheModuleDir)) {
							// sourceModules.push(cacheModuleDir); ?? Check in sourceModules
							return cb__(null, 'cacheModuleDir already there (3) ?? -> ' + cacheModuleDir);
						}

						logger.info('Installing %s@%s %s -> %s', dep.name, ver, tmpDir, cacheModuleDir);
						//sleep.sleep(1);

						fs.mkdirs(cacheModuleDir, function(err) {
							if (err) { return cb__(err); }

							// try to rename first - fast
							var src = path.join(tmpDir, 'node_modules');
							fs.rename(src, cacheModuleDir, function(err) {
								if (err) {
									// try to copy - different partitions
									copyDir(src, cacheModuleDir, function(err, cmd) {
										if (!err) {
											sourceModules.push(cacheModuleDir);
										}
										return cb__(err, err ? '' : cmd);
									});
								}
								else {
									sourceModules.push(cacheModuleDir);
									return cb__(null, 'moved node_modules to ->' + cacheModuleDir);
								}
							});
						});
					})
				});

			}, function (err) {
				console.log("npm install complete", counts);

				if (err) {
					reject(err);
				}
				else {
					var sourceModulesCounts = 0;

					// top level
					async.eachLimit(sourceModules, opts.maxTasks || 5, function (src, _cb) {

						var _cb_ = function(err, message) {
							sourceModulesCounts++;
							console.log("_cb_", sourceModulesCounts, message);
							return _cb(err);
						};

						logger.info('Installing from cache: %s', src);
						copyDir(src, destNodeModulesDir, _cb_);

					}, function (err) {

						console.log("copy to node_modules complete", sourceModulesCounts);

						if (err) {
							reject(err)
						}
						else if (cleanUpDirs.length) {
							var cleanUpDirsCounts = 0;
							// top level
							async.eachLimit(cleanUpDirs, opts.maxTasks || 5, function (dir, __cb) {

								var __cb__ = function(err, message) {
									cleanUpDirsCounts++;
									console.log("__cb__", cleanUpDirsCounts, message);
									return __cb(err);
								};

								if (fs.existsSync(dir)) {
									logger.info('Cleaning up: %s', dir);
									fs.remove(dir, function(err) {
										return __cb__(err, err ? '' : 'Removed dir -> ' + dir);
									});
								}
								else {
									return __cb__(null, 'dir not found -> ' + dir);
								}

							}, function (err) {

								console.log("clean up complete", cleanUpDirsCounts);

								return err ? reject(err) : fulfill(results);
							});
						}
						else {
							return err ? reject(err) : fulfill(results);
						}
					});
				}
			});
		});
	}));
}

/**
 * Recursively copies a directory.
 *
 * @param {string} src - The source directory to copy.
 * @param {string} dest - The destination directory to copy to.
 * @param {function} cb - A callback to fire when copying is complete.
 */
function copyDir(src, dest, cb) {
	if (fs.existsSync(src)) {
		var r = new rsync()
			.flags('aq')
			.source(src + '/')
			.destination(dest + '/.')
			.execute(function(err, code, cmd) {
					return cb(err, cmd);
				});
	}
	else if (!fs.existsSync(dest)) {
		return cb('Source file not found: "' + src + '"');
	}
}

/**
 * Resolves a path including home directories.
 *
 * @param {string} dir - One or more path segments.
 *
 * @returns {string} The resovled path.
 */
function resolvePath(dir) {
	var win = process.platform === 'win32';
	var p = path.join.apply(null, arguments).replace(/^(~)([\\\/].*)?$/, function (s, m, n) {
		return process.env[win ? 'USERPROFILE' : 'HOME'] + (n || '/');
	});
	return path.resolve(win ? p.replace(/(%([^%]*)%)/g, function (s, m, n) {
		return process.env[n] || m;
	}) : p).replace(/[\/\\]/g, path.sep);
}

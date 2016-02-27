# npm-fast-install

Installs and caches npm modules so that subsequent installs are super fast,
especially if native C++ addons are being compiled.

[![NPM version](https://badge.fury.io/js/npm-fast-install.svg)](http://badge.fury.io/js/npm-fast-install)

[![NPM](https://nodei.co/npm-dl/npm-fast-install.png)](https://nodei.co/npm/npm-fast-install/)

`npm-fast-install` will read in the specified project directory's `package.json`,
then for each dependency, installs that dependency into a temp directory. During
the install process, C++ addons will be compiled. Next the installed files will be
moved to the `npm-fast-install` cache directory (defaults to `~/.npm-fast-install`).
Finally the cached package will be copied into the project directory's `node_modules`
directory.

It's important to note that every package is cached by its version +
Node.js architecture + Node.js module API version. Since packages can have
dependencies that are native C++ addon packages, every package is cached by these
criteria. This means that if you install `lodash@3.10.0` using Node.js 0.12 and 4.1,
there will be 2 copies of `lodash@3.10.0` in the cache.

Similarly if your project has a dependency on packages `foo` and `bar` and each
of those have a dependency on `lodash@3.10.0`, lodash will be installed twice:
one in `foo/node_modules/lodash` and one on `bar/node_modules/lodash`.

Basically, `npm-fast-install` is more about speed of subsequent npm installs
than saving hard drive space.

How fast? On a MacBook Pro, the initial install of `ejs`, `titanium`, `jade`,
`npm`, `mongo`, `node-ios-device`, `ws`, and `zombie` took around 25 seconds.
Subsequent installs took around 3 seconds. Boom!

## Installation

From npm:

	npm install -g npm-fast-install

From GitHub:

	npm install git://github.com/appcelerator/npm-fast-install.git

## CLI Usage

```bash
npm-fast-install [project-dir] [options]
```

The `project-dir` is optional. It defaults to the current directory.

### options

	-h, --help             output usage information
	-v, --version          output the version number
	-a, --all              Installs all module deps; by default only installs production deps
	-c, --cache-dir [dir]  Cache directory; defaults to "~/.npm-fast-install"
	--allow-shrinkwrap     Force disable shrinkwrap; defaults to false
	-j, --json             Outputs results as JSON

## API

### install(options)

Installs and caches all packages defined in the project directory's `package.json`.

### Arguments

 * `options` - An object with various settings. All options are _optional_.

   * `dependencies` (object) - override the dependencies from package.json.
   * `allowShrinkwrap` (boolean) - When true, tells npm to honor shrinkwrap settings. Defaults to `false`.
   * `cacheDir` (string) - The directory to cache modules. Defaults to `~/.npm-fast-install`.
   * `dir` (string) - The directory containing the package.json. Defaults to `process.cwd()`.
   * `logger` (object) - A logger to use. Defaults to `console`.
   * `maxTasks` (number) - The maximum number of npm install jobs to run simultaneously. Defaults to `5`.
   * `production` (boolean) - When true, installs only dependencies, not dev dependencies. Defaults to `true`.

### Returns

 * `Promise` - A promise object

#### Example

```javascript
var nfi = require('npm-fast-install');

nfi.install({
		cacheDir: '/tmp/npm-fast-install-cache',
		dir: '/path/to/project',
		allowShrinkwrap: false,
		logger: console,
		production: true
	})
	.then(function (results) {
		console.info('It worked!');
		Object.keys(results.modules).forEach(function (name) {
			console.info('%s@%s %s', name, results.modules[name].version, results.modules[name].path);
		});
	})
	.catch(function (err) {
		console.error('Oh no!');
		console.error(err);
		process.exit(1);
	});
```

## License

Copyright (c) 2015 by [Appcelerator, Inc](http://www.appcelerator.com). All Rights Reserved.
This project is licensed under the Apache Public License, version 2. Please see details in the LICENSE file.

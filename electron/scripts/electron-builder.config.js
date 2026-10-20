'use strict';

const path = require('node:path');
const project = require('../package.json');
const { localElectronDist } = require('./local-electron');

const electronPackage = path.dirname(require.resolve('electron/package.json'));
const version = project.build.electronVersion || require(path.join(electronPackage, 'package.json')).version;
const dist = localElectronDist(electronPackage, version);

if (dist) {
  console.log(`pack: reusing installed Electron ${version} (Windows x64) from ${dist}`);
} else {
  console.log('pack: no matching local Windows x64 runtime; electron-builder will use its download cache/network.');
}

// Keep all targets, signing options, resources and installer settings in package.json.
module.exports = {
  ...project.build,
  ...(dist ? { electronDist: dist, electronVersion: version } : {})
};

/**
 * The desktop half of `npm run build`.
 *
 * Building the site and building the installer are one act, not two: the
 * installer packs the site that was just built, and the site ships the
 * installer that was just packed. Doing only the first leaves the download
 * button pointing at yesterday's application.
 *
 * So this runs after `ng build`, and the order is the only one that works —
 * site, then installer, then the installer copied back into both the sources
 * and the finished output. The AI plugins are the small ones packed with the
 * site (scripts/pack-plugins.js); none of them carries the editor inside.
 *
 * It is deliberately not fatal. Someone working on the site alone should not
 * have to install a hundred megabytes of Electron to run a build, so a missing
 * toolchain is reported and skipped. `npm run build:site` skips it outright.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON = path.resolve(__dirname, '..', '..', 'electron');

function skip(reason) {
  console.warn(`\nbuild-desktop: skipped — ${reason}`);
  console.warn('build-desktop: the site will ship whatever installer is already in src/assets/download.\n');
}

if (!fs.existsSync(path.join(ELECTRON, 'package.json'))) {
  skip('there is no electron project beside this one');
  process.exit(0);
}

if (!fs.existsSync(path.join(ELECTRON, 'node_modules', 'electron-builder'))) {
  skip('electron-builder is not installed (run "npm install" in ../electron)');
  process.exit(0);
}

console.log('\nbuild-desktop: packing the Windows installer…\n');

const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : 'npm';
const args = npmCli ? [npmCli, 'run', 'pack'] : ['run', 'pack'];
const result = spawnSync(command, args, {
  cwd: ELECTRON,
  stdio: 'inherit',
  shell: false
});

if (result.error) {
  console.error(`\nbuild-desktop: could not start npm — ${result.error.message}`);
}

if (result.status !== 0) {
  console.error('\nbuild-desktop: the installer failed to build. The site build itself is fine.');
  process.exit(result.status ?? 1);
}

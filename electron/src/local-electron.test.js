'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { localElectronDist } = require('../scripts/local-electron');

test('reuses only a complete matching Windows x64 runtime, including paths with spaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sve Electron João '));
  const dist = path.join(root, 'dist');
  try {
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '44.3.0' }));
    fs.writeFileSync(path.join(dist, 'version'), '44.3.0\n');
    for (const name of ['resources.pak', 'icudtl.dat']) fs.writeFileSync(path.join(dist, name), 'fixture');
    fs.mkdirSync(path.join(dist, 'locales'));
    const exe = Buffer.alloc(134);
    exe.write('MZ'); exe.writeUInt32LE(128, 60);
    exe.writeUInt32LE(0x00004550, 128); exe.writeUInt16LE(0x8664, 132);
    fs.writeFileSync(path.join(dist, 'electron.exe'), exe);
    assert.equal(localElectronDist(root, '44.3.0'), dist);
    assert.equal(localElectronDist(root, '44.2.0'), null);
    fs.writeFileSync(path.join(dist, 'version'), '44.2.0');
    assert.equal(localElectronDist(root, '44.3.0'), null);
    fs.writeFileSync(path.join(dist, 'version'), '44.3.0');
    exe.writeUInt16LE(0xaa64, 132); // ARM64 cannot supply an x64 package.
    fs.writeFileSync(path.join(dist, 'electron.exe'), exe);
    assert.equal(localElectronDist(root, '44.3.0'), null);
    fs.writeFileSync(path.join(dist, 'electron.exe'), 'truncated');
    assert.equal(localElectronDist(root, '44.3.0'), null);
    exe.writeUInt16LE(0x8664, 132);
    fs.writeFileSync(path.join(dist, 'electron.exe'), exe);
    fs.unlinkSync(path.join(dist, 'resources.pak'));
    assert.equal(localElectronDist(root, '44.3.0'), null);
    assert.equal(localElectronDist(path.join(root, 'missing'), '44.3.0'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

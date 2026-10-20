'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Reuse only the installed version and the architecture of our Windows target. */
function localElectronDist(packageDirectory, expectedVersion) {
  const dist = path.join(packageDirectory, 'dist');
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    const binaryVersion = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '');
    if (installed.version !== expectedVersion || binaryVersion !== expectedVersion) return null;
    for (const name of ['resources.pak', 'icudtl.dat', 'locales']) {
      if (!fs.existsSync(path.join(dist, name))) return null;
    }
    // Check the executable itself, not the Node process architecture: an ARM
    // machine can host an x64 runtime, and a copied dist can be the wrong one.
    const fd = fs.openSync(path.join(dist, 'electron.exe'), 'r');
    try {
      const dos = Buffer.alloc(64);
      if (fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') return null;
      const pe = Buffer.alloc(6);
      if (fs.readSync(fd, pe, 0, pe.length, dos.readUInt32LE(60)) !== pe.length) return null;
      if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664) return null;
    } finally {
      fs.closeSync(fd);
    }
    return dist;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  }
}

module.exports = { localElectronDist };

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MIN_PORT = 41000;
const PORT_SPAN = 7000;

function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

/** A deterministic first port keeps browser storage on one Electron origin. */
function derivedPort(identity) {
  const digest = createHash('sha256').update(String(identity)).digest();
  return MIN_PORT + (digest.readUInt32BE(0) % PORT_SPAN);
}

async function preferredPort(stateFile, identity) {
  try {
    const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (validPort(stored.port)) return stored.port;
  } catch {}
  return derivedPort(identity);
}

/** Remember the actual bound port atomically, including a collision fallback. */
async function rememberPort(stateFile, port) {
  if (!validPort(port)) throw new TypeError(`Invalid loopback port: ${port}`);
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, port }, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, stateFile);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

module.exports = { derivedPort, preferredPort, rememberPort, validPort };

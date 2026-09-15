'use strict';

/**
 * Where the folders the user allowed are remembered.
 *
 * Kept beside editor-location.json, written the same way: to a uniquely named
 * temporary file that is then renamed over the target, so a crash or a second
 * window mid-write leaves either the old file or the new one and never half of
 * either. A consent record that cannot be read is treated as absent rather than
 * as a reason to fail — the worst case is that the user allows the folder
 * again, which is a prompt, not a loss.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;

function rootsFile(localAppData, userData) {
  return localAppData
    ? path.join(localAppData, 'SimpleVlogEditor', 'roots.json')
    : path.join(userData, 'roots.json');
}

/**
 * @returns {Promise<{version: number, roots: Array<{path: string, grantedAt: string, bookmark?: string}>}>}
 */
async function readRoots(stateFile) {
  try {
    const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    const roots = Array.isArray(parsed?.roots) ? parsed.roots : [];
    return {
      version: VERSION,
      roots: roots
        .filter((entry) => entry && typeof entry.path === 'string' && path.isAbsolute(entry.path))
        .map((entry) => ({
          path: path.resolve(entry.path),
          grantedAt: typeof entry.grantedAt === 'string' ? entry.grantedAt : new Date(0).toISOString(),
          // macOS only, and only meaningful in a sandboxed build: without it the
          // grant dies at the next launch even though the path is remembered.
          ...(typeof entry.bookmark === 'string' && entry.bookmark ? { bookmark: entry.bookmark } : {})
        }))
    };
  } catch {
    return { version: VERSION, roots: [] };
  }
}

async function writeRoots(stateFile, roots) {
  const record = {
    version: VERSION,
    updatedAt: new Date().toISOString(),
    roots: roots.map((entry) => ({
      path: path.resolve(entry.path),
      grantedAt: entry.grantedAt || new Date().toISOString(),
      ...(entry.bookmark ? { bookmark: entry.bookmark } : {})
    }))
  };
  await fsp.mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temporary, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    await fsp.rename(temporary, stateFile);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  return record;
}

module.exports = { rootsFile, readRoots, writeRoots, VERSION };

'use strict';

/*
 * "Clear all" has to leave nothing behind.
 *
 * While an AI edits, the editor keeps a recovery checkpoint
 * (simplevlogeditor-recovery.sve.json) in the folder the client declared as
 * its project root — a folder of the user's, not the app's — and switching
 * projects moves that checkpoint to another folder. Removing only the
 * checkpoint at the current path left every earlier one where it was, and the
 * next session in that folder could bring a cleared edit back. So every folder
 * a checkpoint was ever written to is remembered here, and a purge sweeps them
 * all: the checkpoints, their half-written temporaries, and stale export
 * temporaries. Only those exact names are touched, and only at the top of each
 * folder — never the user's media, never a recursive walk.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const CHECKPOINT = 'simplevlogeditor-recovery.sve.json';
const LOCATIONS_FILE = 'recovery-locations.json';
const STALE_WRITING_MS = 60 * 60 * 1000;
const MAX_LOCATIONS = 200;

function isRecoveryName(name) {
  return name === CHECKPOINT || (name.startsWith(`${CHECKPOINT}.`) && name.endsWith('.tmp'));
}

function isWritingName(name) {
  return name.startsWith('.') && name.endsWith('.sve-writing');
}

class RecoveryLocations {
  constructor(userData, options = {}) {
    this.file = path.join(userData, LOCATIONS_FILE);
    this.fs = options.fs || fs;
    this.queue = Promise.resolve();
  }

  #run(task) {
    const result = this.queue.then(task, task);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #read() {
    try {
      const saved = JSON.parse(await this.fs.readFile(this.file, 'utf8'));
      return Array.isArray(saved.folders) ? saved.folders.filter((item) => typeof item === 'string' && path.isAbsolute(item)) : [];
    } catch { return []; }
  }

  async #write(folders) {
    await this.fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await this.fs.writeFile(temporary, JSON.stringify({ version: 1, folders }, null, 2) + '\n', 'utf8');
    await this.fs.rename(temporary, this.file);
  }

  list() { return this.#run(() => this.#read()); }

  remember(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) return Promise.resolve();
    return this.#run(async () => {
      const folders = await this.#read();
      const key = (item) => process.platform === 'win32' ? path.resolve(item).toLowerCase() : path.resolve(item);
      if (folders.some((item) => key(item) === key(folder))) return;
      folders.push(path.resolve(folder));
      await this.#write(folders.slice(-MAX_LOCATIONS)).catch(() => {});
    });
  }

  forget() {
    return this.#run(async () => {
      await this.fs.unlink(this.file).catch(() => {});
    });
  }
}

/**
 * Removes every recovery file the editor could have left in `folders`.
 * Returns what was removed and what could not be, never throws for one file.
 */
async function purgeRecoveryFiles(folders, options = {}) {
  const fsp = options.fs || fs;
  const now = options.now ? options.now() : Date.now();
  const removed = [];
  const failed = [];
  const seen = new Set();
  for (const folder of folders) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) continue;
    const key = process.platform === 'win32' ? path.resolve(folder).toLowerCase() : path.resolve(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    let names;
    try { names = await fsp.readdir(folder); } catch { continue; }
    for (const name of names) {
      const target = path.join(folder, name);
      let wanted = isRecoveryName(name);
      if (!wanted && isWritingName(name)) {
        try { wanted = now - (await fsp.stat(target)).mtimeMs > STALE_WRITING_MS; } catch { wanted = false; }
      }
      if (!wanted) continue;
      try {
        await fsp.unlink(target);
        removed.push(target);
      } catch (error) {
        if (error.code !== 'ENOENT') failed.push({ path: target, code: error.code, message: error.message });
      }
    }
  }
  return { removed, failed };
}

module.exports = { RecoveryLocations, purgeRecoveryFiles, isRecoveryName, CHECKPOINT };

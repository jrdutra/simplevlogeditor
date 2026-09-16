'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;

class RecoveryCheckpointStore {
  constructor(pathFor, options = {}) {
    this.pathFor = pathFor;
    this.fs = options.fs || fs;
    this.maxBytes = options.maxBytes || MAX_CHECKPOINT_BYTES;
    this.queue = Promise.resolve();
    this.revisions = new Map();
  }

  run(work) {
    const result = this.queue.catch(() => undefined).then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  note(target, revision) {
    const value = Number(revision);
    if (Number.isFinite(value)) this.revisions.set(target, Math.max(this.revisions.get(target) ?? -1, value));
  }

  write(document, revision, reason = 'Editor autosave') {
    return this.run(async () => {
      const target = this.pathFor();
      const numericRevision = Number(revision);
      const previous = this.revisions.get(target);
      if (Number.isFinite(numericRevision) && previous !== undefined && numericRevision <= previous) {
        return { saved: true, skipped: true, path: target, reason, projectRevision: numericRevision };
      }
      if (!document || typeof document !== 'object' || !Array.isArray(document.clips) || !document.settings) {
        throw Object.assign(new Error('The renderer supplied an invalid recovery project.'), { code: 'invalid_checkpoint' });
      }
      const contents = JSON.stringify(document, null, 2) + '\n';
      if (Buffer.byteLength(contents) > this.maxBytes) {
        throw Object.assign(new Error('The recovery project is too large to save safely.'), { code: 'checkpoint_too_large' });
      }

      await this.fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await this.fs.writeFile(temporary, contents, { flag: 'wx' });
        await this.fs.rename(temporary, target);
      } catch (error) {
        await this.fs.unlink(temporary).catch(() => {});
        throw error;
      }
      this.note(target, numericRevision);
      return { saved: true, skipped: false, path: target, reason, projectRevision: numericRevision };
    });
  }

  remove(revision, reason = 'Project cleared') {
    return this.run(async () => {
      const target = this.pathFor();
      await this.fs.unlink(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.note(target, revision);
      return { removed: true, path: target, reason, projectRevision: Number(revision) || 0 };
    });
  }
}

module.exports = { RecoveryCheckpointStore, MAX_CHECKPOINT_BYTES };

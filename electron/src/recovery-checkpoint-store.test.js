'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RecoveryCheckpointStore } = require('./recovery-checkpoint-store');

test('a delayed clear cannot delete a newer recovery checkpoint', async () => {
  const files = new Map();
  const store = new RecoveryCheckpointStore(() => 'recovery.json', { fs: {
    mkdir: async () => {}, writeFile: async (file, data) => files.set(file, data),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlink: async file => files.delete(file)
  } });
  await store.write({ clips: [{ id: 'new-edit' }], settings: {} }, 8);
  assert.equal((await store.remove(7)).skipped, true);
  assert.equal(JSON.parse(files.get('recovery.json')).clips[0].id, 'new-edit');
  await store.remove(9);
  assert.equal(files.size, 0);
  assert.equal((await store.write({ clips: [], settings: {} }, 8)).skipped, true);
});

test('queued recovery operations retain their original destination and project snapshot', async () => {
  const files = new Map();
  let target = 'first.json';
  const store = new RecoveryCheckpointStore(() => target, { fs: {
    mkdir: async () => {}, writeFile: async (file, data) => files.set(file, data),
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlink: async file => files.delete(file)
  } });
  const project = { clips: [{ id: 'first' }], settings: {} };
  const save = store.write(project, 1);
  project.clips[0].id = 'changed';
  target = 'second.json';
  await save;
  assert.equal(JSON.parse(files.get('first.json')).clips[0].id, 'first');
  assert.equal(files.has('second.json'), false);
  const remove = store.remove(2);
  target = 'first.json';
  await remove;
  assert.equal(files.has('first.json'), true);
});

test('atomically saves manual edits, rejects stale writes and clears recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-checkpoint-'));
  const target = path.join(root, 'nested', 'recovery.sve.json');
  const store = new RecoveryCheckpointStore(() => target);
  const project = (revision) => ({ version: 1, projectRevision: revision, clips: [{ id: `clip-${revision}` }], settings: {} });
  try {
    const first = await store.write(project(2), 2, 'Manual edit');
    assert.equal(first.skipped, false);
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).projectRevision, 2);
    const newer = await store.write(project(3), 3, 'Next manual edit');
    assert.equal(newer.skipped, false);
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).projectRevision, 3);
    const stale = await store.write(project(1), 1, 'Late save');
    assert.equal(stale.skipped, true);
    assert.equal(JSON.parse(await fs.readFile(target, 'utf8')).projectRevision, 3);
    await store.remove(4);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

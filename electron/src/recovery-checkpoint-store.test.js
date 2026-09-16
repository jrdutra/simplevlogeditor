'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { RecoveryCheckpointStore } = require('./recovery-checkpoint-store');

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

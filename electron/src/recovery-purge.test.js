'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RecoveryLocations, purgeRecoveryFiles, CHECKPOINT } = require('./recovery-purge');
const { MediaImportService } = require('./media-import-service');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sve-purge-')); }

test('purge removes checkpoints, their temporaries and stale export temporaries in every folder, and nothing else', async () => {
  const a = tempDir(); const b = tempDir();
  const files = {
    checkpointA: path.join(a, CHECKPOINT),
    tmpA: path.join(a, `${CHECKPOINT}.1234.tmp`),
    checkpointB: path.join(b, CHECKPOINT),
    staleWriting: path.join(b, '.vlog.mp4.x.sve-writing'),
    freshWriting: path.join(b, '.other.mp4.y.sve-writing'),
    media: path.join(a, 'clip.mp4'),
    userProject: path.join(a, 'my-edit.sve.json')
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, 'x');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(files.staleWriting, old, old);
  const result = await purgeRecoveryFiles([a, b, a, path.join(a, 'missing'), 'relative']);
  assert.deepEqual(result.failed, []);
  for (const key of ['checkpointA', 'tmpA', 'checkpointB', 'staleWriting']) assert.equal(fs.existsSync(files[key]), false, key);
  for (const key of ['freshWriting', 'media', 'userProject']) assert.equal(fs.existsSync(files[key]), true, key);
  assert.equal(result.removed.length, 4);
});

test('recovery locations remember each folder once and forget them all', async () => {
  const data = tempDir(); const project = tempDir();
  const locations = new RecoveryLocations(data);
  await locations.remember(project);
  await locations.remember(project);
  await locations.remember('not-absolute');
  assert.deepEqual(await locations.list(), [path.resolve(project)]);
  await locations.forget();
  assert.deepEqual(await locations.list(), []);
});

test('import jobs are forgotten, on disk too', async () => {
  const data = tempDir();
  const stateFile = path.join(data, 'mcp-import-jobs.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, jobs: [{ jobId: 'j1', state: 'completed', files: [] }] }));
  fs.writeFileSync(`${stateFile}.99.tmp`, '{}');
  const service = new MediaImportService({ callEditor: async () => ({}), registerMedia: () => ({}), stateFile, logger: { warn() {}, info() {}, error() {} } });
  await service.restore();
  assert.equal(service.jobs.size, 1);
  const result = await service.purge();
  assert.equal(service.jobs.size, 0);
  assert.equal(result.removed.length, 2);
  assert.equal(fs.existsSync(stateFile), false);
});

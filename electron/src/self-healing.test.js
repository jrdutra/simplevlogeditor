'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callWithRecovery } = require('./self-healing');
const { commandTimeout } = require('./command-timeout');

function fakeManager(failures) {
  const calls = [];
  const manager = {
    editorPid: 100,
    recovered: 0,
    async callEditor(request) {
      calls.push(request.name);
      const failure = failures.shift();
      if (failure) throw Object.assign(new Error(failure), { code: failure });
      return { apiVersion: 2, projectRevision: 1, result: { ok: true } };
    },
    async recover() { this.recovered++; this.editorPid++; }
  };
  return { manager, calls };
}
const wait = async () => {};

test('transport deadlines allow the requested transcription budget and precise renderer errors', () => {
  assert.equal(commandTimeout({ name: 'transcribe', arguments: { timeoutMs: 3_600_000 } }), 3_610_000);
  assert.equal(commandTimeout({ name: 'transcribe', arguments: { timeoutMs: 1000 } }, 20_000), 21_000);
  assert.equal(commandTimeout({ name: 'transcribe', arguments: {} }), 1_810_000);
  assert.equal(commandTimeout({ name: 'get_frames' }), 1_800_000);
});

test('a stalled read is retried after reopening the editor, without surfacing an error', async () => {
  const { manager, calls } = fakeManager(['media_timeout']);
  const response = await callWithRecovery(manager, { name: 'get_frames' }, { wait });
  assert.equal(response.result.ok, true);
  assert.equal(manager.recovered, 1);
  assert.deepEqual(calls, ['get_frames', 'get_frames']);
});

test('a dropped connection is waited out and retried for a lightweight read', async () => {
  const { manager } = fakeManager(['editor_reconnecting']);
  const response = await callWithRecovery(manager, { name: 'get_timeline' }, { wait });
  assert.equal(response.result.ok, true);
  assert.equal(manager.recovered, 0);
});

test('transcription interrupted by a restart or dropped connection is never replayed silently', async () => {
  for (const code of ['editor_reconnecting', 'editor_timeout', 'renderer_unresponsive', 'media_timeout']) {
    const { manager, calls } = fakeManager([code]);
    await assert.rejects(callWithRecovery(manager, { name: 'transcribe', arguments: { requestId: 'old-job' } }, { wait }),
      error => error.code === 'transcription_interrupted' && error.details.recoverable === false && error.details.cause === code);
    assert.deepEqual(calls, ['transcribe']);
    assert.equal(manager.recovered, 0);
  }
});

test('a failed recognition or cancelled transcription reaches the client exactly once', async () => {
  for (const code of ['transcription_stalled', 'transcription_stage_timeout', 'recognition_failed', 'cancelled']) {
    const { manager, calls } = fakeManager([code]);
    await assert.rejects(callWithRecovery(manager, { name: 'transcribe' }, { wait }), error => error.code === code);
    assert.deepEqual(calls, ['transcribe']);
  }
});

test('an older renderer marking recognition recoverable cannot silently replay it', async () => {
  let calls = 0;
  const manager = { editorPid: 100, async callEditor() {
    calls++;
    throw Object.assign(new Error('Model unavailable'), { code: 'recognition_failed', details: { recoverable: true } });
  } };
  await assert.rejects(callWithRecovery(manager, { name: 'transcribe' }, { wait }), error => error.code === 'recognition_failed');
  assert.equal(calls, 1);
});

test('a change interrupted by a restart is never replayed blindly', async () => {
  const { manager, calls } = fakeManager(['editor_timeout']);
  await assert.rejects(
    callWithRecovery(manager, { name: 'apply_edit_batch', arguments: { requestId: 'r1' } }, { wait }),
    (error) => error.code === 'editor_restored' && error.details.recoverable === true
  );
  assert.equal(manager.recovered, 1);
  assert.deepEqual(calls, ['apply_edit_batch']);
});

test('a change on the same editor after a reconnect is replayed with the same requestId', async () => {
  const { manager, calls } = fakeManager(['editor_reconnecting']);
  const response = await callWithRecovery(manager, { name: 'apply_edit_batch', arguments: { requestId: 'r1' } }, { wait });
  assert.equal(response.result.ok, true);
  assert.equal(calls.length, 2);
});

test('real errors pass straight through', async () => {
  const { manager, calls } = fakeManager(['invalid_arguments']);
  await assert.rejects(callWithRecovery(manager, { name: 'get_frames' }, { wait }), (error) => error.code === 'invalid_arguments');
  assert.equal(calls.length, 1);
});

test('a failure that survives three attempts reaches the client', async () => {
  const { manager, calls } = fakeManager(['media_timeout', 'media_timeout', 'media_timeout']);
  await assert.rejects(callWithRecovery(manager, { name: 'get_frames' }, { wait }), (error) => error.code === 'media_timeout');
  assert.equal(calls.length, 3);
});

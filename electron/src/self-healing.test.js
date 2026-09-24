'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callWithRecovery } = require('./self-healing');

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

test('a stalled read is retried after reopening the editor, without surfacing an error', async () => {
  const { manager, calls } = fakeManager(['media_timeout']);
  const response = await callWithRecovery(manager, { name: 'get_frames' }, { wait });
  assert.equal(response.result.ok, true);
  assert.equal(manager.recovered, 1);
  assert.deepEqual(calls, ['get_frames', 'get_frames']);
});

test('a dropped connection is waited out and retried', async () => {
  const { manager } = fakeManager(['editor_reconnecting']);
  const response = await callWithRecovery(manager, { name: 'transcribe' }, { wait });
  assert.equal(response.result.ok, true);
  assert.equal(manager.recovered, 0);
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

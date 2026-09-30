'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyLedger } = require('./idempotency-ledger');

test('replays one completed mutation without executing it twice', async () => {
  const ledger = new IdempotencyLedger();
  let calls = 0;
  const run = () => ledger.run('session:project', 'edit-1', { name: 'apply_edit_batch', arguments: { value: 1 } }, async () => ({ revision: ++calls }));
  assert.deepEqual(await run(), { revision: 1 });
  assert.deepEqual(await run(), { revision: 1 });
  assert.equal(calls, 1);
});

test('concurrent duplicate mutations share the same in-flight result', async () => {
  const ledger = new IdempotencyLedger();
  let calls = 0;
  const operation = () => ledger.run('scope', 'same', { value: true }, async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 'done';
  });
  assert.deepEqual(await Promise.all([operation(), operation()]), ['done', 'done']);
  assert.equal(calls, 1);
});

test('rejects request id reuse with a different mutation and permits failed retries', async () => {
  const ledger = new IdempotencyLedger();
  await ledger.run('scope', 'used', { value: 1 }, async () => 'first');
  await assert.rejects(
    ledger.run('scope', 'used', { value: 2 }, async () => 'second'),
    (error) => error.code === 'idempotency_conflict'
  );
  await assert.rejects(ledger.run('scope', 'retry', { value: 3 }, async () => { throw new Error('temporary'); }));
  assert.equal(await ledger.run('scope', 'retry', { value: 3 }, async () => 'recovered'), 'recovered');
});

test('capacity pressure never evicts an operation that is still running', async () => {
  const ledger = new IdempotencyLedger({ limit: 1 });
  let release;
  let calls = 0;
  const pending = ledger.run('scope', 'pending', {}, async () => { calls++; return new Promise(resolve => { release = resolve; }); });
  await Promise.resolve();
  await ledger.run('scope', 'other', {}, async () => 'other');
  const replay = ledger.run('scope', 'pending', {}, async () => { calls++; return 'duplicate'; });
  release('original');
  assert.deepEqual(await Promise.all([pending, replay]), ['original', 'original']);
  assert.equal(calls, 1);
  assert.equal(ledger.size, 1);
});

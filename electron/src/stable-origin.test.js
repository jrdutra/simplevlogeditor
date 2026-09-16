'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { derivedPort, preferredPort, rememberPort } = require('./stable-origin');

test('derives a stable valid port and remembers the actual bound port', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-origin-'));
  const state = path.join(root, 'loopback-origin.json');
  try {
    const first = await preferredPort(state, 'the same installation');
    assert.equal(first, derivedPort('the same installation'));
    assert.ok(first >= 1024 && first <= 65535);
    await rememberPort(state, 43210);
    assert.equal(await preferredPort(state, 'a different fallback identity'), 43210);
    await rememberPort(state, 43211);
    assert.equal(await preferredPort(state, 'the same installation'), 43211);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

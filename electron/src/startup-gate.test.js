'use strict';

/**
 * The editor must not answer for a project it has not finished assembling.
 *
 * A client connects and its first tool call can land twenty milliseconds later,
 * while the checkpoint is still being restored. Two real failures came from
 * exactly that window: `transcribe clip-0` answered "not found" on a project
 * that was about to contain clip-0, and a `get_project` that raced the restore
 * returned revision 4 for a project that settled at 8, so the batch guarded on
 * 4 and was refused. Neither was an editor fault and both read as one.
 *
 * main.js needs Electron to load, so what is pinned here is the gate's own
 * logic, written the same way, plus source-level assertions that main.js still
 * uses it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** The shape main.js implements. */
function makeGate({ timeoutMs = 30_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let settled = null;
  let release = null;
  let timer = null;
  return {
    open() {
      if (!settled) {
        settled = new Promise((resolve) => { release = resolve; });
        timer = setTimer(() => this.finish('timeout'), timeoutMs);
        settled.finally(() => clearTimer(timer));
      }
      return settled;
    },
    finish(reason) {
      if (!release) return null;
      const go = release;
      release = null;
      go(reason);
      return reason;
    },
    get pending() { return Boolean(release); }
  };
}

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

test('a call that reads the project waits, and is released when the restore ends', async () => {
  const gate = makeGate();
  gate.open();

  const order = [];
  const call = gate.open().then(() => order.push('transcribe'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [], 'the call must not have been answered yet');

  order.push('restore');
  gate.finish('restore_complete');
  await call;
  assert.deepEqual(order, ['restore', 'transcribe'], 'the restore has to land first');
});

test('opening twice is the same gate, so a second client does not reopen it', async () => {
  const gate = makeGate();
  assert.equal(gate.open(), gate.open());
  gate.finish('restore_complete');
  await gate.open();
  assert.equal(gate.finish('again'), null, 'finishing a settled gate does nothing');
});

test('a startup that never finishes degrades instead of hanging every command', async () => {
  let fire = null;
  const gate = makeGate({ timeoutMs: 5, setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => {} });
  const call = gate.open();
  assert.equal(gate.pending, true);
  fire();
  assert.equal(await call, 'timeout');
});

test('status and control are answerable precisely while the editor is busy', () => {
  const exempt = /const STARTUP_EXEMPT = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  assert.ok(exempt, 'main.js must still declare the exempt set');
  const names = [...exempt[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

  for (const name of ['health_check', 'get_diagnostics', 'cancel_operation', 'close_editor', 'restart_editor']) {
    assert.ok(names.includes(name), `${name} must answer during startup`);
  }
  // The ones the failures came from must NOT be exempt.
  for (const name of ['transcribe', 'get_project', 'get_timeline', 'apply_edit_batch', 'add_media', 'export']) {
    assert.ok(!names.includes(name), `${name} must wait for startup`);
  }
});

test('the bridge actually consults the gate, and the restore always releases it', () => {
  assert.match(source, /if \(!STARTUP_EXEMPT\.has\(request\?\.name\)\) await startupGate\(\);/,
    'routeAgentRequest must await the gate');
  const restore = /async function restoreCheckpointIfEmpty\(\)[\s\S]*?\n}/.exec(source);
  assert.ok(restore, 'restoreCheckpointIfEmpty must still exist');
  assert.match(restore[0], /finally \{[\s\S]*finishStartup\('restore_complete'\)/,
    'the gate must open whether the restore succeeded, was skipped, or threw');
});

test('every exempt command is one the server already treats as priority', () => {
  const exempt = [...(/const STARTUP_EXEMPT = new Set\(\[([\s\S]*?)\]\)/.exec(source)[1])
    .matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  const priority = [...(/priorityCommands: \[([\s\S]*?)\]/.exec(source)[1])
    .matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  // get_editor_capabilities is the one addition: it describes the editor
  // rather than the project, so it is safe before the project exists.
  for (const name of exempt) {
    if (name === 'get_editor_capabilities') continue;
    assert.ok(priority.includes(name), `${name} is exempt from startup but is not a priority command`);
  }
});

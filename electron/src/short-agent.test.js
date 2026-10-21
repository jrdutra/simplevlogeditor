'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('../../web/node_modules/typescript');
const { ShortEditor } = require('./short-editor');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness(t, kind) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'short-agent-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const editor = new ShortEditor({ admit: value => value, statePath: path.join(folder, 'state.json') });
  await editor.ready;
  editor.readSource = async file => ({ path: file, name: file, duration: 30, hasAudio: true });
  await editor.execute('short_import_video', { path: 'a.mp4' });
  await editor.execute('short_set_selection', { ranges: [{ start: 1, end: 3 }, { start: 4, end: 6 }] });
  const started = deferred(), finish = deferred();
  let handler, cancel, signal, cancelled, calls = 0;
  const speech = {
    readSpeechAudio: async (_file, _progress, value) => { signal = value; return new Float32Array(1); },
    transcribe: async () => { calls++; started.resolve(); await finish.promise; return []; }
  };
  const tracker = {
    DEFAULT_FOLLOW: { delays: false, startDelayMs: 100, holdDelayMs: 100, smoothness: 'smooth' },
    analysePeople: async (_file, _start, _end, _progress, stop) => {
      calls++; cancelled = stop; started.resolve(); await finish.promise;
      return { samples: [{ faces: [1], people: [] }] };
    },
    followPath: () => [{ t: 1, x: .7 }]
  };
  const desktop = {
    readAgentFiles: async () => [{}],
    registerAgentHandler: value => { handler = value; },
    registerAgentCancelHandler: value => { cancel = value; }
  };
  const desktopToken = {}, activityToken = {};
  const activity = { begin() {}, end() {}, append() {} };
  const source = await fs.readFile(path.join(__dirname, '../../web/src/app/ferramentas/shorts-generator/short-agent.service.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const sandbox = { exports: {}, AbortController, window: { desktop: { shortCommand: editor.execute.bind(editor) } }, require(name) {
    if (name === '@angular/core') return { Injectable: () => target => target, inject: token => token === desktopToken ? desktop : activity };
    if (name.endsWith('desktop.service')) return { DesktopService: desktopToken, AGENT_REQUEST_NOT_HANDLED: Symbol() };
    if (name.endsWith('agent-activity.service')) return { AgentActivityService: activityToken };
    if (name.endsWith('editor-agent-api')) return { EDITOR_AGENT_API_VERSION: 2 };
    if (name.endsWith('speech-recognizer')) return speech;
    if (name === './person-tracker') return tracker;
    if (name === './short-captions') return { alignedCaptionWords: () => [{ start: 1, end: 2, text: 'Hello' }] };
    throw new Error(name);
  } };
  vm.runInNewContext(compiled, sandbox);
  new sandbox.exports.ShortAgentService().register();
  return { editor, started, finish, run: args => handler({ id: 'op-1', name: kind, arguments: args || {} }),
    cancel: () => cancel('op-1'), stopped: () => signal?.aborted || cancelled?.(), calls: () => calls };
}

for (const kind of ['short_generate_captions', 'short_track_person']) {
  test(`${kind}: cancellation reaches the engine and prevents late results`, async t => {
    const h = await harness(t, kind), before = h.editor.snapshot();
    const result = h.run();
    const rejected = assert.rejects(result, { code: 'cancelled' });
    await h.started.promise;
    h.cancel();
    assert.equal(h.stopped(), true);
    h.finish.resolve(); // Even a non-cooperative engine must not commit.
    await rejected;
    assert.equal(h.calls(), 1); // No next cut after cancellation.
    assert.deepEqual(h.editor.snapshot(), before);
  });

  test(`${kind}: an edit during analysis is retained`, async t => {
    const h = await harness(t, kind);
    const result = h.run();
    const rejected = assert.rejects(result, { code: 'stale_analysis' });
    await h.started.promise;
    await h.editor.execute('short_set_selection', { ranges: [{ start: 10, end: 12 }] });
    const before = h.editor.snapshot();
    h.finish.resolve();
    await rejected;
    assert.deepEqual(h.editor.snapshot(), before);
  });
}

test('captions from an earlier import cannot reach the replacement session', async t => {
  const h = await harness(t, 'short_generate_captions');
  const result = h.run(), rejected = assert.rejects(result, { code: 'stale_analysis' });
  await h.started.promise;
  await h.editor.execute('short_import_video', { path: 'b.mp4' });
  const before = h.editor.snapshot();
  h.finish.resolve();
  await rejected;
  assert.deepEqual(h.editor.snapshot(), before);
});

test('an unchanged session accepts captions and tracking for a short card', async t => {
  const captions = await harness(t, 'short_generate_captions');
  const generating = captions.run();
  await captions.started.promise;
  captions.finish.resolve();
  assert.equal((await generating).result.wordCount, 1);
  assert.equal(captions.editor.snapshot().draftSettings.captions.enabled, true);

  const tracking = await harness(t, 'short_track_person');
  const created = await tracking.editor.execute('short_create', { ranges: [{ start: 1, end: 3 }] });
  const id = created.shorts[0].id;
  const following = tracking.run({ id });
  await tracking.started.promise;
  tracking.finish.resolve();
  await following;
  assert.equal(tracking.editor.snapshot().shorts[0].ranges[0].cropTrack[0].x, .7);
});

test('preload cancellation subscriptions coexist and unsubscribe independently', async () => {
  const listeners = new Map();
  let bridge;
  vm.runInNewContext(await fs.readFile(path.join(__dirname, 'preload.js'), 'utf8'), {
    process: { platform: process.platform },
    require: () => ({ contextBridge: { exposeInMainWorld: (_key, api) => { bridge = api; } },
      ipcRenderer: { on: (name, callback) => listeners.set(name, callback) } })
  });
  const received = [];
  const stop = bridge.registerAgentCancelHandler(id => received.push(`video:${id}`));
  bridge.registerAgentCancelHandler(id => received.push(`short:${id}`));
  listeners.get('agent:cancel')(null, { operationId: 'one' });
  stop();
  listeners.get('agent:cancel')(null, { operationId: 'two' });
  assert.deepEqual(received, ['video:one', 'short:one', 'short:two']);
});

test('host rejects queued or validating results after cancellation or timeout', async t => {
  const h = await harness(t, 'short_generate_captions');
  const source = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('short:command'");
  const end = source.indexOf("ipcMain.handle('short:choose-output'", start);
  let dispatch;
  const operation = { name: 'short_generate_captions', state: 'processing' };
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { dispatch = callback; } },
    fromOurApp: () => true, getShortEditor: () => h.editor,
    agentOperations: new Map([['op-1', operation]])
  });
  const before = h.editor.snapshot();
  const args = { ranges: [], _operationId: 'op-1', _analysisToken: before.analysisToken };
  for (const state of ['canceling', 'failed']) {
    const gate = deferred();
    h.editor.lane = gate.promise;
    operation.state = 'processing';
    const pending = dispatch({ sender: {} }, 'short_set_selection', args);
    const rejected = assert.rejects(pending, { code: 'cancelled' });
    operation.state = state;
    gate.resolve();
    await rejected;
    assert.deepEqual(h.editor.snapshot(), before);
  }
  operation.state = 'processing';
  const validate = h.editor.validateSettings.bind(h.editor);
  h.editor.validateSettings = async value => {
    const result = await validate(value);
    operation.state = 'failed'; // Host deadline expires during audio/settings validation.
    return result;
  };
  await assert.rejects(dispatch({ sender: {} }, 'short_set_selection', { ...args, settings: { cropX: .2 } }), { code: 'cancelled' });
  assert.deepEqual(h.editor.snapshot(), before);
});

test('tracking does not restore card cuts edited during analysis', async t => {
  const h = await harness(t, 'short_track_person');
  const created = await h.editor.execute('short_create', { ranges: [{ start: 1, end: 3 }] });
  const id = created.shorts[0].id;
  const result = h.run({ id }), rejected = assert.rejects(result, { code: 'stale_analysis' });
  await h.started.promise;
  await h.editor.execute('short_update', { id, ranges: [{ start: 10, end: 12 }] });
  const before = h.editor.snapshot();
  h.finish.resolve();
  await rejected;
  assert.deepEqual(h.editor.snapshot(), before);
});

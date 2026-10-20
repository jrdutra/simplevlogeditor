import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/mobile-bridge.js', import.meta.url), 'utf8');

function harness({ cancel = false, failChunk = false, throwPost = false } = {}) {
  const calls = [];
  const alerts = [];
  const chunks = [];
  const listeners = new Map();
  let fetches = 0;
  let originalClicks = 0;
  let nextUrl = 0;
  const timers = new Set();
  const bridge = {
    postMessage(serialized) {
      const message = JSON.parse(serialized);
      calls.push(message);
      if (throwPost) { throwPost = false; throw new Error('Bridge disconnected'); }
      if (message.action === 'chunk') chunks.push(Buffer.from(message.data, 'base64'));
      queueMicrotask(() => bridge.onmessage({ data: JSON.stringify({
        id: message.id,
        ...(cancel && message.action === 'begin' ? { canceled: true } : {}),
        ...(failChunk && message.action === 'chunk' ? { error: 'Disk full' } : {})
      }) }));
    }
  };
  class Element { closest() { return this; } }
  class Anchor extends Element {
    constructor(href, name = '') { super(); this.href = href; this.download = name; }
    hasAttribute(name) { return name === 'download' && !!this.download; }
    click() { originalClicks++; }
  }
  const window = { SimpleVlogAndroid: bridge, alert: text => alerts.push(text) };
  window.top = window;
  const context = vm.createContext({
    window, Element, HTMLAnchorElement: Anchor, Blob, Uint8Array,
    URL: { createObjectURL: () => `blob:local/${++nextUrl}`, revokeObjectURL() {} },
    document: { addEventListener: (type, listener) => listeners.set(type, listener) },
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
    btoa: text => Buffer.from(text, 'binary').toString('base64'),
    fetch: async () => { fetches++; throw new Error('URL revoked'); }
  });
  vm.runInContext(source, context);
  return { calls, alerts, chunks, listeners, context, Anchor, window, bridge, timers,
    get fetches() { return fetches; }, get originalClicks() { return originalClicks; } };
}

async function settled() {
  // Blob.arrayBuffer and the bridge acknowledgements both cross async boundaries.
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
}

test('exports a large Blob in bounded chunks even when the web app immediately revokes its URL', async () => {
  const app = harness();
  const bytes = Buffer.alloc(450000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const url = app.context.URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
  new app.Anchor(url, 'edit.mp4').click();
  app.context.URL.revokeObjectURL(url);
  await settled();
  assert.deepEqual(app.calls.map(call => call.action), ['begin', 'chunk', 'chunk', 'chunk', 'finish']);
  assert.equal(app.calls[0].name, 'edit.mp4');
  assert.equal(app.calls[0].mime, 'video/mp4');
  assert.ok(app.chunks.every(chunk => chunk.length <= 192 * 1024));
  assert.deepEqual(Buffer.concat(app.chunks), bytes);
  assert.equal(app.fetches, 0);
  assert.deepEqual(app.alerts, []);
});

test('canceling the destination picker sends no chunks and allows another export', async () => {
  const app = harness({ cancel: true });
  const url = app.context.URL.createObjectURL(new Blob(['captions']));
  await app.window.simpleVlogSaveDownload(url, 'captions.srt');
  await app.window.simpleVlogSaveDownload(url, 'captions.srt');
  assert.deepEqual(app.calls.map(call => call.action), ['begin', 'begin']);
  assert.deepEqual(app.alerts, []);
});

test('native write errors abort the destination and report the failure', async () => {
  const app = harness({ failChunk: true });
  const url = app.context.URL.createObjectURL(new Blob(['captions']));
  await app.window.simpleVlogSaveDownload(url, 'captions.srt');
  assert.deepEqual(app.calls.map(call => call.action), ['begin', 'chunk', 'abort']);
  assert.deepEqual(app.alerts, ['Disk full']);
});

test('trusted download clicks save through Android while ordinary links retain their behavior', async () => {
  const app = harness();
  const url = app.context.URL.createObjectURL(new Blob(['hello']));
  let prevented = false;
  let stopped = false;
  app.listeners.get('click')({ target: new app.Anchor(url, 'hello.txt'),
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  await settled();
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(app.calls.at(-1).action, 'finish');
  new app.Anchor('https://example.com').click();
  assert.equal(app.originalClicks, 1);
});

test('a second simultaneous export does not interrupt the first', async () => {
  const app = harness();
  const url = app.context.URL.createObjectURL(new Blob(['hello']));
  const first = app.window.simpleVlogSaveDownload(url, 'first.txt');
  await app.window.simpleVlogSaveDownload(url, 'second.txt');
  await first;
  assert.equal(app.calls.filter(call => call.action === 'begin').length, 1);
  assert.deepEqual(app.alerts, ['Aguarde o salvamento atual terminar.']);
});

test('a failed fetch is reported and the save lock is released', async () => {
  const app = harness();
  await app.window.simpleVlogSaveDownload('blob:missing', 'missing.mp4');
  assert.deepEqual(app.alerts, ['URL revoked']);
  assert.equal(app.calls.length, 0);
  const url = app.context.URL.createObjectURL(new Blob(['hello']));
  await app.window.simpleVlogSaveDownload(url, 'next.txt');
  assert.equal(app.calls.at(-1).action, 'finish');
});

test('malformed and unknown replies do not break the next Android save', async () => {
  const app = harness();
  for (const data of ['invalid', 'null', '42', '{"id":999}']) {
    assert.doesNotThrow(() => app.bridge.onmessage({ data }));
  }
  const url = app.context.URL.createObjectURL(new Blob(['hello']));
  await app.window.simpleVlogSaveDownload(url, 'next.txt');
  assert.equal(app.calls.at(-1).action, 'finish');
  assert.equal(app.timers.size, 0);
});

test('a disconnected bridge releases the save lock without attempting an unopened destination', async () => {
  const app = harness({ throwPost: true });
  const url = app.context.URL.createObjectURL(new Blob(['hello']));
  await app.window.simpleVlogSaveDownload(url, 'first.txt');
  assert.deepEqual(app.calls.map(call => call.action), ['begin']);
  assert.deepEqual(app.alerts, ['Bridge disconnected']);
  assert.equal(app.timers.size, 0);
  await app.window.simpleVlogSaveDownload(url, 'next.txt');
  assert.equal(app.calls.at(-1).action, 'finish');
});

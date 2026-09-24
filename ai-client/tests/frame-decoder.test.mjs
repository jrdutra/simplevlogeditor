import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

let source = fs.readFileSync(new URL('../../web/src/app/ferramentas/editor-de-video/agent-frame-decoder.ts', import.meta.url), 'utf8');
source = source.replace(/^import .*;\r?\n/gm, '');
source = `const loadMediabunny = async () => globalThis.__frameTestLibrary;
class EditorAgentError extends Error { constructor(message, code, details) { super(message); this.code = code; this.details = details; } }
${source}`;
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { openAgentFrameDecoder, AGENT_MEDIA_TIMEOUT_MS } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
function library(getSample) {
  const state = { disposed: 0 };
  globalThis.__frameTestLibrary = {
    BlobSource: class {}, ALL_FORMATS: [],
    Input: class { getPrimaryVideoTrack() { return Promise.resolve({}); } dispose() { state.disposed++; } },
    VideoSampleSink: class { getSample(time) { return getSample(time); } }
  };
  return state;
}
test.afterEach(() => { delete globalThis.__frameTestLibrary; });

test('decoder closes the previous sample and disposes once', async () => {
  let closed = 0;
  const state = library(async () => ({ displayWidth: 320, displayHeight: 180, close() { closed++; }, draw() {} }));
  const decoder = await openAgentFrameDecoder(new File([], 'clip.mp4'));
  assert.equal((await decoder.frame(0)).width, 320);
  await decoder.frame(1);
  assert.equal(closed, 1);
  decoder.dispose(); decoder.dispose();
  assert.equal(closed, 2);
  assert.equal(state.disposed, 1);
});

test('cancelled decoder releases a late frame instead of leaking it', async () => {
  let resolve;
  let closed = 0;
  const state = library(() => new Promise(done => { resolve = done; }));
  const abort = new AbortController();
  const decoder = await openAgentFrameDecoder(new File([], 'clip.mp4'), abort.signal);
  const frame = decoder.frame(0);
  abort.abort();
  await assert.rejects(frame, { code: 'cancelled' });
  resolve({ close() { closed++; } });
  await Promise.resolve();
  assert.equal(closed, 1);
  assert.equal(state.disposed, 1);
});

test('decoder allows five minutes, then releases stalled input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = library(() => new Promise(() => {}));
  const decoder = await openAgentFrameDecoder(new File([], 'clip.mp4'));
  const frame = decoder.frame(0);
  const rejected = assert.rejects(frame, { code: 'media_timeout' });
  t.mock.timers.tick(60_000);
  assert.equal(state.disposed, 0);
  assert.equal(AGENT_MEDIA_TIMEOUT_MS, 300_000);
  t.mock.timers.tick(240_000);
  await rejected;
  assert.equal(state.disposed, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import * as library from 'mediabunny';

const base = new URL('../src/app/ferramentas/editor-de-video/', import.meta.url);
const compile = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText).toString('base64');
const models = compile(fs.readFileSync(new URL('video-editor.models.ts', base), 'utf8'));
const source = fs.readFileSync(new URL('render-media.ts', base), 'utf8').replace("'./video-editor.models'", JSON.stringify(models));
const { createRenderInput, readRenderAudio, AUDIO_READ_TIMEOUT_MS } = await import(compile(source));

test('real media reads seek forwards and back without opening persistent Blob streams', async () => {
  // 90 seconds of stereo PCM, larger than the reader cache. No WebCodecs needed.
  const dataSize = 90 * 48000 * 4;
  const wave = Buffer.alloc(44 + dataSize);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28);
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(dataSize, 40);
  let reads = 0;
  class SeekableFile extends File {
    slice(start, end) {
      const slice = super.slice(start, end);
      slice.stream = () => { throw new Error('Persistent streams can exhaust the desktop connection pool'); };
      const read = slice.arrayBuffer.bind(slice);
      slice.arrayBuffer = () => { reads++; assert.ok(slice.size < this.size); return read(); };
      return slice;
    }
  }
  const input = createRenderInput(library, new SeekableFile([wave], 'cuts.wav'));
  try {
    const track = await input.getPrimaryAudioTrack();
    const sink = new library.AudioSampleSink(track);
    for (const start of [0.2, 30, 65, 0.2, 80]) {
      let count = 0;
      for await (const sample of sink.samples(start, start + 0.1)) { sample.close(); count++; }
      assert.ok(count > 0);
    }
    assert.ok(reads > 1);
  } finally { input.dispose(); }
});

function stalled() {
  let resolve;
  let disposed = 0;
  let returned = 0;
  const samples = {
    [Symbol.asyncIterator]() { return this; },
    next: () => new Promise(done => { resolve = done; }),
    return: () => { returned++; return new Promise(() => {}); }
  };
  return { samples, input: { dispose() { disposed++; } },
    late: value => resolve({ done: false, value }),
    get disposed() { return disposed; }, get returned() { return returned; } };
}

test('stalled audio times out and cleanup does not await a stalled iterator return', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = stalled();
  const iterator = readRenderAudio(state.samples, state.input, new AbortController().signal, 'source 0.20s, range 1/8');
  const pending = iterator.next();
  const rejected = assert.rejects(pending, /60 seconds.*source 0.20s, range 1\/8/);
  await Promise.resolve();
  t.mock.timers.tick(AUDIO_READ_TIMEOUT_MS);
  await rejected;
  assert.equal(state.disposed, 1);
  assert.equal(state.returned, 1);
  let closed = 0;
  state.late({ close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('cancel interrupts a pending audio read immediately and closes a late sample', async () => {
  const state = stalled();
  const abort = new AbortController();
  const iterator = readRenderAudio(state.samples, state.input, abort.signal, 'clip');
  const pending = iterator.next();
  const rejected = assert.rejects(pending, { name: 'EditorCanceledError' });
  await Promise.resolve();
  abort.abort();
  await rejected;
  assert.equal(state.disposed, 1);
  let closed = 0;
  state.late({ close() { closed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('already cancelled reads never request a packet', async () => {
  const abort = new AbortController(); abort.abort();
  let requested = false;
  const samples = { [Symbol.asyncIterator]() { return this; }, async next() { requested = true; return { done: true }; } };
  await assert.rejects(readRenderAudio(samples, { dispose() {} }, abort.signal, 'clip').next(), { name: 'EditorCanceledError' });
  assert.equal(requested, false);
});

test('timeout excludes time spent encoding a yielded sample and resets for the next read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = { close() {} };
  let reads = 0;
  let resolve;
  const samples = { [Symbol.asyncIterator]() { return this; }, next() {
    reads++;
    return reads === 1 ? Promise.resolve({ value: first, done: false }) : new Promise(done => { resolve = done; });
  } };
  const iterator = readRenderAudio(samples, { dispose() { assert.fail('healthy input disposed'); } }, new AbortController().signal, 'clip');
  assert.equal((await iterator.next()).value, first);
  t.mock.timers.tick(AUDIO_READ_TIMEOUT_MS * 2);
  const next = iterator.next();
  await Promise.resolve();
  t.mock.timers.tick(AUDIO_READ_TIMEOUT_MS - 1);
  resolve({ done: true });
  assert.equal((await next).done, true);
});

test('decoder errors keep their original reason', async () => {
  const failure = new Error('bad AAC packet');
  const samples = { [Symbol.asyncIterator]() { return this; }, next() { throw failure; } };
  await assert.rejects(readRenderAudio(samples, { dispose() {} }, new AbortController().signal, 'clip').next(), error => error === failure);
});

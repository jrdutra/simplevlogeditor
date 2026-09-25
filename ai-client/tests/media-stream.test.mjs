import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(new URL('../../web/src/app/shared/desktop/path-backed-file.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { PathBackedFile } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const descriptor = { name: 'clip.mp4', size: 1000000, type: 'video/mp4', lastModified: 0, url: 'http://local.test/media' };

test('paused media streams release their HTTP responses and bound read-ahead', async () => {
  const original = globalThis.fetch;
  let reads = 0;
  const requests = [];
  let activeResponses = 0;
  globalThis.fetch = async (_url, init) => {
    requests.push(init); activeResponses++;
    const [, start, end] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    return { ok: true, arrayBuffer: async () => {
      reads++; activeResponses--;
      return new ArrayBuffer(Number(end) - Number(start) + 1);
    } };
  };
  try {
    const reader = new PathBackedFile({ ...descriptor, size: 20 * 1024 * 1024 }).slice(10).stream().getReader();
    await reader.read();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads <= 2, `must not drain the video in the background: ${reads}`);
    assert.equal(requests[0].headers.Range, 'bytes=10-1048585');
    assert.equal(activeResponses, 0, 'pausing must not pin connections needed by other decoders');
    await reader.cancel();
    assert.ok(requests.every(request => request.signal.aborted));
  } finally { globalThis.fetch = original; }
});

test('cancelling while HTTP headers are pending aborts the request', async () => {
  const original = globalThis.fetch;
  let signal;
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  try {
    const reader = new PathBackedFile(descriptor).stream().getReader();
    const pendingRead = reader.read();
    await new Promise(resolve => setImmediate(resolve));
    await reader.cancel();
    assert.equal(signal.aborted, true);
    assert.equal((await pendingRead).done, true);
  } finally { globalThis.fetch = original; }
});

test('bounded requests preserve every byte and sliced-file boundaries', async () => {
  const original = globalThis.fetch;
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 117 }, (_, i) => i % 251);
  const ranges = [];
  globalThis.fetch = async (_url, init) => {
    const [, a, b] = init.headers.Range.match(/bytes=(\d+)-(\d+)/);
    const start = Number(a), end = Number(b);
    ranges.push([start, end]);
    return new Response(bytes.slice(start, end + 1), { status: 206 });
  };
  try {
    const file = new PathBackedFile({ ...descriptor, size: bytes.length });
    const actual = new Uint8Array(await new Response(file.slice(13, bytes.length - 7).stream()).arrayBuffer());
    assert.deepEqual(actual, bytes.slice(13, bytes.length - 7));
    assert.equal(ranges.length, 3);
    assert.ok(ranges.every(([start, end]) => end - start + 1 <= 1024 * 1024));
    assert.equal(ranges[0][0], 13);
    assert.equal(ranges.at(-1)[1], bytes.length - 8);
  } finally { globalThis.fetch = original; }
});

test('an incomplete local range rejects instead of leaving the decoder waiting', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2), { status: 206 });
  try {
    const reader = new PathBackedFile(descriptor).slice(10, 20).stream().getReader();
    await assert.rejects(reader.read(), /incomplete byte range/);
  } finally { globalThis.fetch = original; }
});

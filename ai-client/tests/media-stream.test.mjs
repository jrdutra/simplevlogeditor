import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from '../../web/node_modules/typescript/lib/typescript.js';

const source = fs.readFileSync(new URL('../../web/src/app/shared/desktop/path-backed-file.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { PathBackedFile } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const descriptor = { name: 'clip.mp4', size: 1000000, type: 'video/mp4', lastModified: 0, url: 'http://local.test/media' };

test('media stream applies backpressure and cancels its HTTP reader', async () => {
  const original = globalThis.fetch;
  let reads = 0;
  let cancelled = false;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = init;
    return { ok: true, body: { getReader: () => ({
      read: async () => { reads++; return { done: false, value: new Uint8Array([1]) }; },
      cancel: async () => { cancelled = true; }, releaseLock() {}
    }) } };
  };
  try {
    const reader = new PathBackedFile(descriptor).slice(10, 20).stream().getReader();
    await reader.read();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads <= 2, `must not drain the video in the background: ${reads}`);
    assert.equal(request.headers.Range, 'bytes=10-19');
    await reader.cancel();
    assert.equal(request.signal.aborted, true);
    assert.equal(cancelled, true);
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
    await reader.cancel();
    assert.equal(signal.aborted, true);
  } finally { globalThis.fetch = original; }
});

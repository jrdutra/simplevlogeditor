import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import ts from 'typescript';

const source = await fs.readFile(new URL('../server-assets.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
} }).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), module, module.exports);
const { siteAssets, normalizeHost } = module.exports;

test('local IPv6 hosts remain local, including bracketed addresses and ports', () => {
  for (const host of ['::1', '[::1]', '[::1]:4000']) assert.equal(normalizeHost(host), '::1');
  assert.equal(normalizeHost('LOCALHOST:4000'), 'localhost');
  assert.equal(normalizeHost('simplevlogeditor.com, proxy'), 'simplevlogeditor.com');
});

test('missing model assets return 404, downloads revalidate, and hashed bundles remain immutable', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-http-assets-'));
  await fs.writeFile(path.join(folder, 'plugin.zip'), 'archive');
  await fs.writeFile(path.join(folder, 'worker-ABCDEFGH.js'), 'bundle');
  const app = express();
  let rendered = 0;
  app.get('*.*', siteAssets(folder));
  app.get('*', (_request, response) => { rendered++; response.send('<html>app</html>'); });
  app.use((error, _request, response, _next) => response.status(error.status || 500).send('Asset unavailable'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  try {
    const missing = await fetch(root + '/missing-model.wasm');
    assert.equal(missing.status, 404); assert.equal(rendered, 0);
    const archive = await fetch(root + '/plugin.zip');
    assert.equal(archive.status, 200); assert.equal(archive.headers.get('cache-control'), 'no-cache');
    await archive.arrayBuffer();
    const bundle = await fetch(root + '/worker-ABCDEFGH.js');
    assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    await bundle.arrayBuffer();
    const route = await fetch(root + '/video-editor');
    assert.equal(route.status, 200); assert.equal(rendered, 1); await route.text();
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(folder, { recursive: true, force: true });
  }
});

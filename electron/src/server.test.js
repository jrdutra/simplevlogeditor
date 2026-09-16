'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { startServer } = require('./server');

test('serves local media incrementally with HTTP byte ranges', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-server-'));
  const file = path.join(root, 'vídeo com espaço.mp4');
  await fs.writeFile(path.join(root, 'index.html'), '<html></html>');
  await fs.writeFile(file, Buffer.from('0123456789'));
  const stat = await fs.stat(file);
  const server = await startServer(root);
  try {
    const url = server.registerMedia(file, stat, 'video/mp4');
    const response = await fetch(url, { headers: { Range: 'bytes=3-6' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
    assert.equal(await response.text(), '3456');
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('binds the requested stable port and falls back safely when it is occupied', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-server-port-'));
  await fs.writeFile(path.join(root, 'index.html'), '<html></html>');
  const first = await startServer(root);
  const stablePort = first.port;
  await first.close();

  const stable = await startServer(root, { port: stablePort, fallbackToRandom: false });
  assert.equal(stable.port, stablePort);
  assert.equal(stable.usedFallback, false);
  await stable.close();

  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(stablePort, '127.0.0.1', resolve);
  });
  try {
    const fallback = await startServer(root, { port: stablePort, fallbackToRandom: true });
    try {
      assert.notEqual(fallback.port, stablePort);
      assert.equal(fallback.usedFallback, true);
    } finally {
      await fallback.close();
    }
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an abandoned media request releases its file handle instead of holding it', async () => {
  // The stall this pins: a client that stops reading without closing leaves the
  // request open, and with it a socket. Six of those and the next reader of the
  // same file never gets a reply — readyState 0, networkState 2, nothing
  // buffered, no error. Seen from a frame grab and from an export.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const http = require('node:http');

  const file = path.join(await require('node:fs/promises').mkdtemp(path.join(os.tmpdir(), 'sve-media-')), 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024, 7));

  const started = await startServer(path.dirname(file), { port: 0 });
  const url = started.registerMedia(file, fs.statSync(file), 'video/mp4');

  const destroyed = await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      assert.equal(response.statusCode, 200);
      // Read one chunk, then walk away without consuming the rest.
      response.once('data', () => {
        request.destroy();
        setTimeout(() => resolve(true), 150);
      });
    });
    request.once('error', () => resolve(true));
    setTimeout(() => reject(new Error('the server never answered')), 4000);
  });
  assert.equal(destroyed, true);

  // The proof that matters: the server still answers the next reader.
  const second = await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
    setTimeout(() => reject(new Error('the next request was never answered')), 4000);
  });
  assert.equal(second, 200);

  await started.close();
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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

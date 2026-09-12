'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { EditorProcessManager } = require('./editor-process-manager');

class FakeSocket extends EventEmitter {
  constructor(connects) {
    super(); this.destroyed = false; this.connects = connects;
    setImmediate(() => this.emit(connects ? 'connect' : 'error', Object.assign(new Error('not ready'), { code: 'ENOENT' })));
  }
  setEncoding() {}
  write(_value, callback) { callback?.(); return true; }
  destroy() { this.destroyed = true; this.emit('close'); }
}

class LifecycleSocket extends FakeSocket {
  constructor() { super(true); }
  write(value, callback) {
    callback?.();
    const envelope = JSON.parse(value);
    if (!envelope.id) return true;
    setImmediate(() => {
      this.emit('data', JSON.stringify({
        id: envelope.id,
        result: { apiVersion: 2, projectRevision: 7, result: { closing: true } }
      }) + '\n');
      if (envelope.request.name === '__editor_lifecycle') setImmediate(() => this.destroy());
    });
    return true;
  }
}

test('ten concurrent callers share one editor startup promise', async () => {
  let attempts = 0;
  let spawns = 0;
  const manager = new EditorProcessManager({
    endpoint: 'fake',
    connectSocket: () => new FakeSocket(++attempts > 2),
    spawnEditor: () => { spawns++; return { unref() {} }; },
    logger: { info() {}, warn() {}, error() {} }
  });
  const sockets = await Promise.all(Array.from({ length: 10 }, () => manager.ensureEditorRunning()));
  assert.equal(spawns, 1);
  assert.ok(sockets.every((socket) => socket === sockets[0]));
  manager.close();
});

test('a dropped IPC call is recoverable and does not poison the manager', async () => {
  const sockets = [];
  const manager = new EditorProcessManager({
    endpoint: 'fake',
    connectSocket: () => { const socket = new FakeSocket(true); sockets.push(socket); return socket; },
    spawnEditor: () => ({ unref() {} }),
    logger: { info() {}, warn() {}, error() {} }
  });
  const pending = manager.callEditor({ name: 'get_project' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  sockets[0].destroy();
  await assert.rejects(pending, (error) => error.code === 'editor_reconnecting' && error.details.recoverable);
  const reconnected = await manager.ensureEditorRunning();
  assert.notEqual(reconnected, sockets[0]);
  manager.close();
});

test('restart closes the current editor and reconnects to a fresh visible instance', async () => {
  const sockets = [];
  const manager = new EditorProcessManager({
    endpoint: 'fake',
    connectSocket: () => { const socket = new LifecycleSocket(); sockets.push(socket); return socket; },
    spawnEditor: () => ({ unref() {} }),
    logger: { info() {}, warn() {}, error() {} }
  });
  await manager.ensureEditorRunning();
  const result = await manager.restartEditor();
  assert.equal(result.result.restarted, true);
  assert.equal(sockets[0].destroyed, true);
  assert.equal(sockets.length, 2);
  assert.equal(manager.diagnostics().state, 'ready');
  manager.close();
});

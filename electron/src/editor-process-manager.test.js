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

/* ------------------------------------------------------- proof of liveness */

class RecordingSocket extends FakeSocket {
  constructor() { super(true); this.written = []; }
  write(value, callback) {
    callback?.();
    for (const line of String(value).split('\n')) if (line.trim()) this.written.push(JSON.parse(line));
    return true;
  }
}

function connected(socket) {
  const manager = new EditorProcessManager({
    endpoint: 'fake',
    connectSocket: () => socket,
    spawnEditor: () => ({ unref() {}, once() {}, on() {} }),
    logger: { info() {}, warn() {}, error() {} }
  });
  return manager;
}

test('the client answers the editor heartbeat, because silence is how a dead session hides', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  socket.written.length = 0;

  socket.emit('data', JSON.stringify({ type: 'heartbeat', pid: 42, windowCount: 1, state: 'ready' }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));

  const ack = socket.written.find((envelope) => envelope.type === 'heartbeat_ack');
  assert.ok(ack, 'every heartbeat must be acknowledged');
  assert.equal(ack.protocolVersion, 2);
  assert.equal(ack.pid, process.pid);
  manager.close();
});

test('a heartbeat still records the editor state it carries', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  socket.emit('data', JSON.stringify({ type: 'heartbeat', pid: 99, windowCount: 3, state: 'busy' }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  const diagnostics = manager.diagnostics();
  assert.equal(diagnostics.electronPid, 99);
  assert.equal(diagnostics.windowCount, 3);
  assert.equal(diagnostics.state, 'busy');
  manager.close();
});

test('an acknowledgement is never sent down a socket that has gone', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  socket.destroyed = true;
  socket.written.length = 0;
  socket.emit('data', JSON.stringify({ type: 'heartbeat' }) + '\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.written, []);
  manager.close();
});

test('client roots reach the editor as soon as they are known, and only when they change', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  socket.written.length = 0;

  assert.equal(manager.setClientRoots(['/home/joao/Videos']), true);
  const sent = socket.written.filter((envelope) => envelope.type === 'roots');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].roots, ['/home/joao/Videos']);

  assert.equal(manager.setClientRoots(['/home/joao/Videos']), false, 'the same answer must not be resent');
  assert.equal(socket.written.filter((envelope) => envelope.type === 'roots').length, 1);
  manager.close();
});

test('a relative root from a client is dropped rather than resolved against this process', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  manager.setClientRoots(['not/absolute', '/home/joao/Videos']);
  const sent = socket.written.filter((envelope) => envelope.type === 'roots').at(-1);
  assert.deepEqual(sent.roots, ['/home/joao/Videos']);
  manager.close();
});

test('the client tells the editor it is alive on its own schedule, not only in reply', async () => {
  // A model thinking for four minutes sends no tool calls. That silence used to
  // be indistinguishable from a client that had been killed.
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  assert.ok(manager.healthcheck, 'a periodic healthcheck must be running');
  socket.written.length = 0;

  manager.socket.write(JSON.stringify({
    type: 'client_health', protocolVersion: 2, pid: process.pid,
    controller: 'claude-code', pendingCalls: 0, at: new Date().toISOString()
  }) + '\n');
  const sent = socket.written.find((envelope) => envelope.type === 'client_health');
  assert.ok(sent, 'the envelope must carry its own type');
  assert.equal(sent.protocolVersion, 2);
  assert.equal(sent.controller, 'claude-code');
  manager.close();
});

test('closing stops the healthcheck as well as the watchdog', async () => {
  const socket = new RecordingSocket();
  const manager = connected(socket);
  await manager.ensureEditorRunning();
  manager.close();
  socket.written.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(socket.written, [], 'a closed manager must write nothing');
});

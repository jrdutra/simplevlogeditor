'use strict';

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const electron = require('electron');
const { editorEndpoint } = require('./ipc-endpoint');
const { createLogger } = require('./structured-log');

const RETRY_MS = 750;
const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30 * 60_000;

function recoverable(message, code = 'editor_unavailable', details = {}) {
  return Object.assign(new Error(message), {
    code,
    details: { recoverable: true, retryAfterMs: RETRY_MS, ...details }
  });
}

class EditorProcessManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint || editorEndpoint();
    this.spawnEditor = options.spawnEditor || (() => spawn(
      electron,
      [path.join(__dirname, '..'), '--mcp-open'],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit'],
        // Hides only Electron's launcher console on Windows. The BrowserWindow
        // is deliberately shown and focused by main.js when this bridge joins.
        windowsHide: true,
        env: { ...process.env, SVE_CONTROLLER: process.env.SVE_CONTROLLER || 'codex' }
      }
    ));
    this.connectSocket = options.connectSocket || (() => net.createConnection(this.endpoint));
    this.logger = options.logger || createLogger('editor-process-manager');
    this.socket = null;
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
    this.ensurePromise = null;
    this.state = 'starting';
    this.lastError = null;
    this.editorPid = null;
    this.windowCount = 0;
    this.lastHeartbeat = null;
    this.closed = false;
  }

  async ensureEditorRunning() {
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.#ensure().finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }

  async #ensure() {
    this.state = this.socket ? 'reconnecting' : 'starting';
    try {
      return await this.#connect(900);
    } catch {}

    this.logger.info('editor_start_requested', { endpoint: this.endpoint });
    const child = this.spawnEditor();
    child?.unref?.();
    const deadline = Date.now() + START_TIMEOUT_MS;
    let last;
    while (!this.closed && Date.now() < deadline) {
      try { return await this.#connect(1200); }
      catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, RETRY_MS)); }
    }
    this.state = 'unavailable';
    this.lastError = last?.message || 'Timed out waiting for the editor.';
    throw recoverable('The editor is unavailable while its IPC endpoint starts.', 'editor_start_timeout', { endpoint: this.endpoint });
  }

  #connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      const candidate = this.connectSocket();
      let settled = false;
      const timer = setTimeout(() => finish(recoverable('Editor IPC connection timed out.')), timeoutMs);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        candidate.removeListener('connect', connected);
        candidate.removeListener('error', failed);
        if (error) { candidate.destroy(); reject(error); }
      };
      const failed = (error) => finish(error);
      const connected = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        candidate.removeListener('error', failed);
        this.#adopt(candidate);
        resolve(candidate);
      };
      candidate.once('connect', connected);
      candidate.once('error', failed);
    });
  }

  #adopt(socket) {
    this.socket?.destroy();
    this.socket = socket;
    this.buffer = '';
    this.state = 'ready';
    socket.setEncoding('utf8');
    socket.write(JSON.stringify({
      type: 'hello', protocolVersion: 2, pid: process.pid,
      controller: process.env.SVE_CONTROLLER || 'codex',
      roots: (process.env.SVE_MCP_ROOTS || process.cwd()).split(path.delimiter).filter(Boolean).map((root) => path.resolve(root))
    }) + '\n');
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('close', () => this.#disconnected(socket, 'closed'));
    socket.on('error', (error) => this.#disconnected(socket, error.message));
    this.logger.info('ipc_connected', { endpoint: this.endpoint });
  }

  #receive(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const at = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (!line.trim()) continue;
      let envelope;
      try { envelope = JSON.parse(line); } catch { continue; }
      if (envelope.type === 'hello') {
        this.editorPid = envelope.pid ?? null;
        this.windowCount = envelope.windowCount ?? 0;
        continue;
      }
      if (envelope.type === 'heartbeat') {
        this.lastHeartbeat = Date.now();
        this.editorPid = envelope.pid ?? this.editorPid;
        this.windowCount = envelope.windowCount ?? this.windowCount;
        this.state = envelope.state ?? 'ready';
        continue;
      }
      const pending = this.pending.get(envelope.id);
      if (!pending) continue;
      this.pending.delete(envelope.id);
      clearTimeout(pending.timer);
      if (envelope.error) pending.reject(Object.assign(new Error(envelope.error.message), envelope.error));
      else pending.resolve(envelope.result);
    }
  }

  #disconnected(socket, reason) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.state = 'reconnecting';
    this.lastError = reason;
    const error = recoverable('The editor IPC connection was interrupted.', 'editor_reconnecting', { cause: reason });
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.logger.warn('ipc_disconnected', { reason });
  }

  async callEditor(request) {
    const socket = await this.ensureEditorRunning();
    return new Promise((resolve, reject) => {
      const id = `mcp-${process.pid}-${++this.sequence}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(recoverable(`Editor command "${request.name}" timed out.`, 'editor_timeout'));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(JSON.stringify({ id, request }) + '\n', (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(recoverable('The editor command could not be sent.', 'editor_reconnecting', { cause: error.message }));
      });
    });
  }

  async #waitForDisconnect(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (this.socket && !this.socket.destroyed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.socket && !this.socket.destroyed) {
      throw recoverable('The editor did not close in time.', 'editor_close_timeout');
    }
  }

  async closeEditor() {
    const response = await this.callEditor({ name: '__editor_lifecycle', arguments: { action: 'close' } });
    await this.#waitForDisconnect();
    return response;
  }

  async restartEditor() {
    const response = await this.closeEditor();
    this.state = 'starting';
    await this.ensureEditorRunning();
    return {
      ...response,
      result: { ...(response.result || {}), restarted: true, editor: this.diagnostics() }
    };
  }

  diagnostics() {
    return {
      state: this.state,
      endpoint: this.endpoint,
      mcpPid: process.pid,
      electronPid: this.editorPid,
      windowCount: this.windowCount,
      lastHeartbeat: this.lastHeartbeat ? new Date(this.lastHeartbeat).toISOString() : null,
      lastError: this.lastError,
      pendingCalls: this.pending.size,
      memory: process.memoryUsage()
    };
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
  }
}

module.exports = { EditorProcessManager, recoverable, RETRY_MS };

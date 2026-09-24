'use strict';

const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { editorEndpoint } = require('./ipc-endpoint');
const { splitRoots } = require('./mcp-roots');
const { createLogger } = require('./structured-log');

const RETRY_MS = 750;
/**
 * How often this process tells the editor it is still here.
 *
 * Independent of anything the model is doing. A client thinking for four
 * minutes is not a client that has gone, and the editor must not be left to
 * infer liveness from the absence of tool calls.
 */
const CLIENT_HEALTHCHECK_MS = 7_000;
const START_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30 * 60_000;
const HEARTBEAT_TIMEOUT_MS = 20_000;

/**
 * How to open the visible editor from wherever this host is running.
 *
 * Two situations, told apart by the process itself rather than by a setting:
 *
 *   packaged   This host is the editor's own executable running as Node
 *              (`ELECTRON_RUN_AS_NODE`), which is how the plugin's bundled
 *              runtime and an installed or portable copy start it. The window
 *              is that same executable started normally; nothing outside the
 *              runtime folder is consulted.
 *   checkout   Plain Node from the repository (`npm run mcp`). The window is
 *              the development Electron from `node_modules`, pointed at the
 *              `electron` folder, exactly as before.
 *
 * `require('electron')` is only reached in the second case. From inside a
 * packaged app it would fail — Electron is a development dependency and is not
 * in the archive — which is why it can no longer sit at the top of this file.
 */
function editorLaunchCommand(options = {}) {
  const environment = options.environment || process.env;
  const versions = options.versions || process.versions;
  const execPath = options.execPath || process.execPath;
  const dev = Boolean(options.dev);
  const controller = environment.SVE_CONTROLLER || 'codex';
  const childEnvironment = { ...environment, SVE_CONTROLLER: controller };
  // The window must be a real Electron browser process, never Node again.
  delete childEnvironment.ELECTRON_RUN_AS_NODE;

  if (versions.electron && environment.ELECTRON_RUN_AS_NODE) {
    // Inside an archive the executable already knows its application. From a
    // checkout (`electron . --mcp-stdio`) it has to be told which folder.
    const appDirectory = options.appDirectory || path.join(__dirname, '..');
    const packed = /\.asar$/i.test(appDirectory);
    return {
      mode: packed ? 'packaged' : 'checkout-electron',
      command: execPath,
      args: [...(packed ? [] : [appDirectory]), '--mcp-open', ...(dev ? ['--dev'] : [])],
      env: childEnvironment
    };
  }
  const resolveElectron = options.resolveElectron || (() => require('electron'));
  return {
    mode: 'checkout',
    command: resolveElectron(),
    args: [path.join(__dirname, '..'), '--mcp-open', ...(dev ? ['--dev'] : [])],
    env: childEnvironment
  };
}

/** This host's own editor version: the package it was shipped in. */
function ownEditorVersion() {
  try { return require(path.join(__dirname, '..', 'package.json')).version || null; } catch { return null; }
}

/** -1, 0 or 1; a missing version counts as the oldest there is. */
function compareVersions(a, b) {
  const parts = (value) => String(value || '0').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    if ((x[index] || 0) !== (y[index] || 0)) return (x[index] || 0) < (y[index] || 0) ? -1 : 1;
  }
  return a && !b ? 1 : !a && b ? -1 : 0;
}

function recoverable(message, code = 'editor_unavailable', details = {}) {
  return Object.assign(new Error(message), {
    code,
    details: { recoverable: true, retryAfterMs: RETRY_MS, ...details }
  });
}

class EditorProcessManager {
  constructor(options = {}) {
    this.endpoint = options.endpoint || editorEndpoint();
    this.dev = options.dev ?? process.argv.includes('--dev');
    this.spawnEditor = options.spawnEditor || (() => {
      const launch = editorLaunchCommand({ dev: this.dev });
      this.launchMode = launch.mode;
      // Detached on purpose, and only the window: it is the user's editor and
      // outlives this session, so ending an MCP session never closes work in
      // progress. This process — the one serving MCP — is never detached.
      // None of our streams are handed to it: stdout is the MCP channel, and
      // a window that inherited our stderr would be writing into a dead pipe
      // (EPIPE) from the moment this session ends. Its logs go to
      // SVE_MCP_LOG_FILE, which it inherits through the environment.
      return spawn(launch.command, launch.args, {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
        // Hides only Electron's launcher console on Windows. The BrowserWindow
        // is deliberately shown and focused by main.js when this bridge joins.
        windowsHide: true,
        shell: false,
        env: launch.env
      });
    });
    this.connectSocket = options.connectSocket || (() => net.createConnection(this.endpoint));
    this.logger = options.logger || createLogger('editor-process-manager');
    this.socket = null;
    this.buffer = '';
    this.sequence = 0;
    this.clientRoots = [];
    this.healthcheck = null;
    this.pending = new Map();
    this.ensurePromise = null;
    this.state = 'starting';
    this.lastError = null;
    this.editorPid = null;
    this.windowCount = 0;
    this.lastHeartbeat = null;
    this.closed = false;
    this.ownVersion = options.ownVersion === undefined ? ownEditorVersion() : options.ownVersion;
    this.editorVersion = null;
    this.helloWaiters = new Set();
    this.replacedOlderEditor = false;
    // Waiting for the editor's hello needs a real editor on the other end;
    // injected test sockets never send one.
    this.checkVersion = options.checkVersion ?? !options.connectSocket;
    this.heartbeatWatchdog = setInterval(() => {
      if (!this.socket || this.socket.destroyed || !this.lastHeartbeat) return;
      const silentForMs = Date.now() - this.lastHeartbeat;
      if (silentForMs <= HEARTBEAT_TIMEOUT_MS) return;
      this.logger.warn('ipc_heartbeat_timeout', { silentForMs, endpoint: this.endpoint });
      this.lastError = `No editor heartbeat for ${silentForMs} ms.`;
      this.socket.destroy();
    }, 5000);
    this.heartbeatWatchdog.unref?.();

    // Two directions, on purpose. The editor's heartbeat proves the window is
    // alive; this proves the client is, whether or not a tool call is in
    // flight. Long silences here are normal — the model may think for minutes —
    // and used to be indistinguishable from a client that had been killed.
    this.healthcheck = setInterval(() => {
      if (this.closed || !this.socket || this.socket.destroyed || this.state !== 'ready') return;
      this.socket.write(JSON.stringify({
        type: 'client_health', protocolVersion: 2, pid: process.pid,
        controller: process.env.SVE_CONTROLLER || 'codex',
        pendingCalls: this.pending.size, at: new Date().toISOString()
      }) + '\n');
    }, CLIENT_HEALTHCHECK_MS);
    this.healthcheck.unref?.();
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
      const socket = await this.#connect(900);
      if (!(await this.#olderEditorRunning())) return socket;
      /*
       * An older editor already owns the pipe — typically a window left open
       * from an earlier version or an earlier test. Talking to it means every
       * fix since then is missing. It is asked to close (which saves its
       * checkpoint), and this host's own editor opens in its place and
       * restores that checkpoint: the edit carries on, only newer.
       */
      this.replacedOlderEditor = true;
      this.logger.warn('older_editor_replaced', { running: this.editorVersion, own: this.ownVersion });
      try {
        await this.#closeConnected();
      } catch (error) {
        this.logger.warn('older_editor_close_failed', { error });
      }
    } catch {}

    this.logger.info('editor_start_requested', { endpoint: this.endpoint });
    const child = this.spawnEditor();
    child?.unref?.();
    /*
     * A window that exits before its pipe ever answered is not one worth
     * waiting thirty seconds for. The usual cause is another copy of the
     * editor that already holds the single-instance lock but speaks an older
     * protocol on a different pipe: the new window hands itself to that one
     * and quits. Said plainly, it is a one-step fix for the user.
     */
    let exited = null;
    child?.once?.('exit', (code, signal) => { exited = { code, signal }; });
    child?.once?.('error', (error) => { exited = { error }; });
    const deadline = Date.now() + START_TIMEOUT_MS;
    let last;
    while (!this.closed && Date.now() < deadline) {
      try { return await this.#connect(1200); }
      catch (error) { last = error; }
      if (exited) {
        // One more look: a window that exits because it handed over to a
        // running editor on this same pipe is a success, not a failure.
        try { return await this.#connect(1200); } catch { /* still nothing */ }
        this.state = 'unavailable';
        this.lastError = exited.error?.message || `The editor process exited (code ${exited.code ?? 'none'}) before it answered.`;
        throw recoverable(
          'The editor window closed before it could be reached. If SimpleVlogEditor is already open, close it and try again — ' +
          'an older copy that is still running keeps newer ones from starting.',
          'editor_start_failed',
          { endpoint: this.endpoint, exitCode: exited.code ?? null, signal: exited.signal ?? null, cause: exited.error?.message }
        );
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
    }
    this.state = 'unavailable';
    this.lastError = last?.message || 'Timed out waiting for the editor.';
    throw recoverable('The editor is unavailable while its IPC endpoint starts.', 'editor_start_timeout', { endpoint: this.endpoint });
  }

  /** True once, for an editor older than this host (or too old to say its version). */
  async #olderEditorRunning() {
    if (this.replacedOlderEditor || !this.ownVersion || !this.checkVersion) return false;
    const answered = await new Promise((resolve) => {
      if (this.helloSeen) return resolve(true);
      const timer = setTimeout(() => { this.helloWaiters.delete(done); resolve(false); }, 3000);
      const done = () => { clearTimeout(timer); resolve(true); };
      this.helloWaiters.add(done);
    });
    if (!answered) return false;
    return compareVersions(this.editorVersion, this.ownVersion) < 0;
  }

  async #closeConnected() {
    const socket = this.socket;
    if (!socket) return;
    await this.#send(socket, { name: '__editor_lifecycle', arguments: { action: 'close' } });
    await this.#waitForDisconnect();
    // The single-instance lock outlives the socket by a moment.
    await new Promise((resolve) => setTimeout(resolve, 1000));
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

  /**
   * Only what this process was explicitly told, never its working directory:
   * the host is started by whatever launched the MCP client, so its working
   * directory says nothing about what the user wants reachable. Electron
   * supplies the defaults, and folders the MCP client reported arrive later
   * through `setClientRoots`.
   */
  #roots() {
    return [...new Set([...splitRoots(process.env.SVE_MCP_ROOTS || ''), ...this.clientRoots])];
  }

  /**
   * Folders the MCP client reported through roots/list. Forwarded to the editor
   * immediately when a connection is up, and replayed in the next hello
   * otherwise, so a client that answers late is not lost.
   */
  setClientRoots(roots) {
    const next = (roots || []).filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.resolve(root));
    if (next.join('\u0000') === this.clientRoots.join('\u0000')) return false;
    this.clientRoots = next;
    this.logger.info('mcp_client_roots', { roots: next });
    if (this.socket && this.state === 'ready') {
      this.socket.write(JSON.stringify({ type: 'roots', protocolVersion: 2, roots: this.#roots() }) + '\n');
    }
    return true;
  }

  #adopt(socket) {
    this.socket?.destroy();
    this.socket = socket;
    this.buffer = '';
    this.state = 'ready';
    this.lastError = null;
    this.lastHeartbeat = Date.now();
    this.helloSeen = false;
    this.editorVersion = null;
    socket.setEncoding('utf8');
    socket.write(JSON.stringify({
      type: 'hello', protocolVersion: 2, pid: process.pid,
      controller: process.env.SVE_CONTROLLER || 'codex',
      roots: this.#roots()
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
        this.editorVersion = envelope.editorVersion ?? null;
        this.helloSeen = true;
        for (const waiter of this.helloWaiters) waiter();
        this.helloWaiters.clear();
        continue;
      }
      if (envelope.type === 'heartbeat') {
        this.lastHeartbeat = Date.now();
        this.editorPid = envelope.pid ?? this.editorPid;
        this.windowCount = envelope.windowCount ?? this.windowCount;
        this.state = envelope.state ?? 'ready';
        // Answering is what proves this process is still alive. A named pipe
        // whose peer has gone without closing stays writable, so the editor
        // cannot tell a quiet client from a dead one by silence alone.
        if (this.socket && !this.socket.destroyed) {
          this.socket.write(JSON.stringify({ type: 'heartbeat_ack', protocolVersion: 2, pid: process.pid }) + '\n');
        }
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
    return this.#send(socket, request);
  }

  #send(socket, request) {
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

  /**
   * Close and reopen the editor, whatever state it is in, and let it restore
   * its recovery checkpoint. A polite close first (it saves the checkpoint);
   * when the editor cannot even answer that, its process is ended — the
   * checkpoint written after the last change is what the new window opens.
   */
  async recover(reason = 'recovery') {
    this.logger.warn('editor_recovery_started', { reason, electronPid: this.editorPid });
    const pid = this.editorPid;
    try {
      if (this.socket && !this.socket.destroyed) {
        await Promise.race([
          this.closeEditor(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('close timed out')), 15_000))
        ]);
      }
    } catch (error) {
      this.logger.warn('editor_recovery_forced', { reason, error });
      if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
      this.socket?.destroy();
      this.socket = null;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    this.state = 'starting';
    await this.ensureEditorRunning();
    this.recoveries = (this.recoveries || 0) + 1;
    this.logger.info('editor_recovery_completed', { reason, electronPid: this.editorPid });
  }

  diagnostics() {
    return {
      state: this.state,
      endpoint: this.endpoint,
      launchMode: this.launchMode || null,
      runtimeExecutable: process.versions.electron && process.env.ELECTRON_RUN_AS_NODE ? process.execPath : null,
      mcpPid: process.pid,
      electronPid: this.editorPid,
      editorVersion: this.editorVersion,
      hostVersion: this.ownVersion,
      replacedOlderEditor: this.replacedOlderEditor,
      recoveries: this.recoveries || 0,
      windowCount: this.windowCount,
      lastHeartbeat: this.lastHeartbeat ? new Date(this.lastHeartbeat).toISOString() : null,
      lastError: this.lastError,
      pendingCalls: this.pending.size,
      declaredRoots: this.#roots(),
      clientRoots: [...this.clientRoots],
      memory: process.memoryUsage()
    };
  }

  close() {
    this.closed = true;
    clearInterval(this.heartbeatWatchdog);
    clearInterval(this.healthcheck);
    this.socket?.destroy();
    this.socket = null;
  }
}

module.exports = { EditorProcessManager, editorLaunchCommand, compareVersions, recoverable, RETRY_MS };

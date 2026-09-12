/**
 * SimpleVlogEditor, as a window.
 *
 * The window has no frame of its own. The site already draws one — a chassis
 * with a bezel, a bar across the top and three lights at its right end — and
 * two frames around one program is one too many. So the operating system's
 * frame is turned off and the site's becomes the real one: the bar is the drag
 * handle, the lights are the buttons, and the bezel is the strip you grab to
 * resize. Everything a window is expected to do it still does; it is only drawn
 * by the page instead of by Windows.
 */

const { app, BrowserWindow, ipcMain, screen, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');

const { startServer } = require('./server');
const { restoreState, trackWindow } = require('./window-state');
const { editorEndpoint } = require('./ipc-endpoint');
const { MediaImportService } = require('./media-import-service');
const { createLogger, safeError } = require('./structured-log');

/**
 * Below this the console stops being one.
 *
 * The tab strip, the tool's own panels and the timeline all need a width before
 * they start wrapping into something unusable, and a window that can be dragged
 * down to a postage stamp is a window someone will lose the editor inside.
 */
const MINIMUM = { width: 960, height: 640 };

const DEV = process.argv.includes('--dev');
const MCP_OPEN = process.argv.includes('--mcp-open');
const DEV_URL = process.env.SVE_DEV_URL || 'http://localhost:4200';
const log = createLogger('electron-main');

/** Files reachable by automation. The client opts into roots explicitly. */
const MCP_ROOTS = new Set((process.env.SVE_MCP_ROOTS || process.cwd())
  .split(path.delimiter)
  .filter(Boolean)
  .map((entry) => path.resolve(entry)));

function admittedPath(candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error('A non-empty file path is required.');
  const resolved = path.resolve(candidate);
  const admitted = [...MCP_ROOTS].some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  });
  if (!admitted) throw new Error(`The path is outside SVE_MCP_ROOTS: ${resolved}`);
  return resolved;
}

const MIME = new Map(Object.entries({
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.json': 'application/json', '.sve': 'application/json'
}));

/** Where the built site is: beside the sources in development, packed in beside the app once shipped. */
function siteRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'site')
    : path.join(__dirname, '..', '..', 'web', 'dist', 'browser');
}

let server = null;
let origin = null;
let mainWindow = null;
let bridgeServer = null;
let mediaImports = null;
const agentControllers = new Map();
const editorSessionId = randomUUID();
let lastAgentController = 'mcp';
let hadAgentConnection = false;
let lastAgentConnectionAt = null;
let recoveryRoot = [...MCP_ROOTS][0] || process.cwd();
let checkpointQueue = Promise.resolve();
let restoreAttemptedPath = null;

function fromOurApp(contents) {
  const url = contents?.getURL?.() ?? '';
  return Boolean(origin && url.startsWith(origin)) || (DEV && url.startsWith(DEV_URL));
}

/* One instance. A second launch raises the window that already exists rather
   than opening a second copy with its own loopback server. */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (argv.includes('--mcp-open') && origin) window.loadURL(`${DEV ? DEV_URL : origin}/video-editor`);
  });
}

let agentContents = null;
let agentSequence = 0;
const agentPending = new Map();
const agentOperations = new Map();
const agentReadyWaiters = new Set();
const outputFiles = new Map();
let agentBridgeWired = false;
let windowControlsWired = false;

function recoveryProjectPath() {
  return path.join(recoveryRoot, 'simplevlogeditor-recovery.sve.json');
}

function normalizedController(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'codex' || name === 'chatgpt') return name;
  return 'mcp';
}

function agentControlState() {
  const controllers = [...new Set(agentControllers.values())];
  const connected = controllers.length > 0;
  return {
    active: connected,
    visible: connected || hadAgentConnection,
    connectionStatus: connected ? 'connected' : hadAgentConnection ? 'disconnected' : 'idle',
    controller: controllers.includes('codex') ? 'codex' : controllers.includes('chatgpt') ? 'chatgpt' : lastAgentController,
    controllers,
    sessionId: editorSessionId,
    lastConnectionAt: lastAgentConnectionAt,
    recoveryPath: recoveryProjectPath()
  };
}

function publishAgentControlState() {
  if (agentContents && !agentContents.isDestroyed()) {
    agentContents.send('agent:control-state', agentControlState());
  }
}

function publishAgentSystemLog(level, module, message, details) {
  if (agentContents && !agentContents.isDestroyed()) {
    agentContents.send('agent:system-log', {
      timestamp: new Date().toISOString(), level, module, message, details
    });
  }
}

function focusEditorForControl() {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  const target = `${DEV ? DEV_URL : origin}/video-editor`;
  if (origin && !window.webContents.getURL().includes('/video-editor')) {
    window.loadURL(target).then(() => {
      if (!window.isDestroyed()) { window.show(); window.focus(); }
    }).catch((error) => log.warn('agent_route_open_failed', { error }));
  }
}

function callEditor(request) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const operationId = String(request?.arguments?.requestId || request?.id || randomUUID());
    const operation = {
      operationId, name: request.name, state: 'processing', stage: 'dispatching', percent: null,
      startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(),
      elapsedMs: 0, projectRevision: null, result: null, error: null
    };
    agentOperations.set(operationId, operation);
    while (agentOperations.size > 500) agentOperations.delete(agentOperations.keys().next().value);
    const send = () => {
      if (!agentContents || agentContents.isDestroyed()) {
        operation.state = 'unresponsive';
        operation.stage = 'waiting-for-renderer';
        operation.elapsedMs = Date.now() - started;
        operation.updatedAt = new Date().toISOString();
        if (Date.now() - started > 30000) {
          const error = Object.assign(new Error('The editor did not become ready.'), { code: 'renderer_unresponsive' });
          operation.state = 'failed';
          operation.error = { code: error.code, message: error.message };
          return reject(error);
        }
        const waiter = () => { agentReadyWaiters.delete(waiter); send(); };
        agentReadyWaiters.add(waiter);
        return;
      }

      const id = `agent-${++agentSequence}`;
      const timer = setTimeout(() => {
        agentPending.delete(id);
        operation.state = 'failed';
        operation.stage = 'timeout';
        operation.elapsedMs = Date.now() - started;
        operation.updatedAt = new Date().toISOString();
        operation.error = { code: 'editor_timeout', message: `Editor command "${request.name}" timed out.` };
        reject(Object.assign(new Error(operation.error.message), { code: operation.error.code, details: { operationId } }));
      }, 30 * 60 * 1000);
      agentPending.set(id, {
        operationId,
        resolve: (value) => {
          clearTimeout(timer);
          operation.state = 'applied';
          operation.stage = 'completed';
          operation.percent = 100;
          operation.elapsedMs = Date.now() - started;
          operation.updatedAt = new Date().toISOString();
          operation.projectRevision = value?.projectRevision ?? null;
          operation.result = { apiVersion: value?.apiVersion, projectRevision: value?.projectRevision };
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          operation.state = error?.code === 'cancelled' ? 'cancelled' : 'failed';
          operation.stage = error?.details?.stage || operation.stage;
          operation.elapsedMs = Date.now() - started;
          operation.updatedAt = new Date().toISOString();
          operation.error = { code: error?.code || 'editor_error', message: error?.message || String(error), details: error?.details };
          reject(error);
        }
      });
      operation.state = 'processing';
      operation.stage = 'renderer';
      operation.updatedAt = new Date().toISOString();
      agentContents.send('agent:command', { id, request: { ...request, id: operationId } });
    };
    send();
  });
}

function agentResponse(result, projectRevision = 0) {
  return { apiVersion: 2, projectRevision: Number(projectRevision) || 0, result };
}

async function checkpointProject(reason = 'Automatic checkpoint') {
  const checkpointPath = recoveryProjectPath();
  checkpointQueue = checkpointQueue.catch(() => undefined).then(async () => {
    const response = await callEditor({
      name: 'save_project',
      arguments: { path: checkpointPath, kind: 'project', name: 'Automatic Codex recovery' }
    });
    log.info('project_checkpoint_saved', { path: checkpointPath, reason, projectRevision: response.projectRevision });
    return agentResponse({
      saved: true,
      path: checkpointPath,
      reason,
      projectRevision: response.projectRevision
    }, response.projectRevision);
  });
  return checkpointQueue;
}

async function recoveryState() {
  const checkpointPath = recoveryProjectPath();
  try {
    const stat = await fs.stat(checkpointPath);
    return { path: checkpointPath, exists: stat.isFile(), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: checkpointPath, exists: false, size: 0, modifiedAt: null };
    throw error;
  }
}

async function restoreCheckpointIfEmpty() {
  const checkpointPath = recoveryProjectPath();
  if (restoreAttemptedPath === checkpointPath || !agentContents || agentContents.isDestroyed()) return;
  restoreAttemptedPath = checkpointPath;
  const state = await recoveryState();
  if (!state.exists) return;
  const current = await callEditor({ name: 'get_project', arguments: {} });
  if (Number(current.result?.clipCount || 0) > 0) {
    log.info('project_checkpoint_restore_skipped', { path: checkpointPath, reason: 'editor_not_empty' });
    return;
  }
  const restored = await callEditor({ name: 'open_project', arguments: { path: checkpointPath } });
  log.info('project_checkpoint_restored', { path: checkpointPath, projectRevision: restored.projectRevision });
}

function commandVersion(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); resolve({ available: false, error: 'timeout' }); }, 3000);
    child.stdout.on('data', (chunk) => { if (output.length < 4096) output += chunk.toString('utf8'); });
    child.once('error', (error) => { clearTimeout(timer); resolve({ available: false, error: error.code || error.message }); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ available: code === 0, exitCode: code, version: output.split(/\r?\n/, 1)[0] || null });
    });
  });
}

async function routeAgentRequest(request) {
  const args = request?.arguments || {};
  switch (request?.name) {
    case 'add_media':
    case 'queue_media_import': {
      const current = await callEditor({ name: 'get_project', arguments: {} });
      const projectId = current.result?.project?.id || current.result?.project?.name || recoveryProjectPath();
      const queued = mediaImports.queue(args, {
        sessionId: editorSessionId,
        projectId: String(projectId),
        projectRevision: current.projectRevision
      });
      return agentResponse({ ...queued, async: true }, current.projectRevision);
    }
    case 'get_import_status': {
      const status = mediaImports.status(args.jobId);
      return agentResponse(status, status.projectRevision);
    }
    case 'cancel_import': {
      const status = mediaImports.cancel(args.jobId);
      return agentResponse(status, status.projectRevision);
    }
    case 'resume_import': {
      const status = mediaImports.resume(args.jobId);
      return agentResponse(status, status.projectRevision);
    }
    case 'health_check':
      return agentResponse({
        state: agentContents && !agentContents.isDestroyed() ? (mediaImports.activeJob ? 'processing' : 'ready') : 'starting',
        connectionStatus: agentControlState().connectionStatus,
        electronPid: process.pid,
        sessionId: editorSessionId,
        queue: mediaImports.diagnostics()
      });
    case 'get_operation_status': {
      const operation = agentOperations.get(String(args.operationId || ''));
      if (!operation) throw Object.assign(new Error(`Operation "${args.operationId}" was not found in this editor session.`), { code: 'operation_not_found' });
      return agentResponse({ ...operation, sessionId: editorSessionId });
    }
    case 'cancel_operation': {
      const operationId = String(args.operationId || '');
      const operation = agentOperations.get(operationId);
      if (!operation) throw Object.assign(new Error(`Operation "${operationId}" was not found in this editor session.`), { code: 'operation_not_found' });
      if (['applied', 'failed', 'cancelled', 'recovered'].includes(operation.state)) {
        return agentResponse({ ...operation, cancellationRequested: false, terminal: true });
      }
      operation.state = 'canceling';
      operation.stage = 'cancellation-requested';
      operation.updatedAt = new Date().toISOString();
      if (agentContents && !agentContents.isDestroyed()) agentContents.send('agent:cancel', { operationId });
      return agentResponse({ ...operation, cancellationRequested: true, terminal: false });
    }
    case 'get_diagnostics': {
      const [ffmpeg, ffprobe] = await Promise.all([commandVersion(process.env.SVE_FFMPEG || 'ffmpeg'), commandVersion(process.env.SVE_FFPROBE || 'ffprobe')]);
      return agentResponse({
        editorVersion: app.getVersion(), apiVersion: 2, protocolVersion: 2, electronPid: process.pid,
        sessionId: editorSessionId, platform: process.platform, arch: process.arch,
        versions: process.versions,
        windowCount: BrowserWindow.getAllWindows().length,
        rendererReady: Boolean(agentContents && !agentContents.isDestroyed()),
        roots: [...MCP_ROOTS], imports: mediaImports.diagnostics(), memory: process.memoryUsage(),
        externalTools: { ffmpeg, ffprobe }
      });
    }
    case 'get_recovery_state':
      return agentResponse(await recoveryState());
    case 'checkpoint_project':
      return checkpointProject('Requested by controller');
    case '__editor_lifecycle': {
      if (args.action !== 'close') throw Object.assign(new Error('Unsupported editor lifecycle action.'), { code: 'invalid_arguments' });
      let saved = null;
      try { saved = await checkpointProject('Editor closing'); }
      catch (error) { log.warn('shutdown_checkpoint_failed', { error }); }
      const response = agentResponse({ closing: true, checkpoint: saved?.result || null }, saved?.projectRevision || 0);
      // `app.quit()` waits for active named-pipe clients, including the client
      // that is waiting for this very command to finish. Send the response,
      // then tear down the visible window and process explicitly.
      setTimeout(() => {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
        app.exit(0);
      }, 350);
      return response;
    }
    default: {
      if (request.name === 'apply_edit_batch' && args.dryRun !== true) {
        await checkpointProject(`Before edit batch: ${String(args.label || 'Agent edit')}`);
      }
      const response = await callEditor(request);
      if (request.name === 'get_editor_capabilities' && response.result && typeof response.result === 'object') {
        response.result.hostCommands = ['health_check', 'get_operation_status', 'cancel_operation', 'get_recovery_state', 'checkpoint_project', 'close_editor', 'restart_editor'];
        response.result.control = {
          visibleWindow: true,
          activityModal: true,
          automaticCheckpoint: recoveryProjectPath()
        };
      }
      const mutatesProject = request.name === 'undo' || request.name === 'redo' ||
        request.name === 'open_project' || request.name === 'set_project_soundtrack' || request.name === 'analyze_silence' ||
        (request.name === 'apply_edit_batch' && args.dryRun !== true);
      if (mutatesProject) {
        try { await checkpointProject(`After ${request.name}`); }
        catch (error) { log.warn('automatic_checkpoint_failed', { command: request.name, error }); }
      }
      return response;
    }
  }
}

/** The editor owns a stable endpoint. MCP adapters may disconnect/reconnect without closing it. */
function startEditorBridgeServer() {
  const endpoint = editorEndpoint();
  bridgeServer = net.createServer((socket) => {
    let buffered = '';
    let authenticated = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      while (buffered.includes('\n')) {
        const at = buffered.indexOf('\n');
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        let envelope;
        try { envelope = JSON.parse(line); }
        catch { socket.write(JSON.stringify({ error: { code: 'invalid_envelope', message: 'Invalid bridge JSON.' } }) + '\n'); continue; }
        if (!authenticated) {
          if (envelope.type !== 'hello' || envelope.protocolVersion !== 2) { socket.destroy(); continue; }
          authenticated = true;
          const admittedRoots = [];
          for (const root of envelope.roots || []) if (typeof root === 'string' && path.isAbsolute(root)) {
            const resolved = path.resolve(root);
            MCP_ROOTS.add(resolved);
            admittedRoots.push(resolved);
          }
          if (admittedRoots[0]) {
            const nextRecoveryRoot = admittedRoots[0];
            if (nextRecoveryRoot !== recoveryRoot) {
              recoveryRoot = nextRecoveryRoot;
              restoreAttemptedPath = null;
            }
          }
          const controller = normalizedController(envelope.controller);
          const wasDisconnected = hadAgentConnection && agentControllers.size === 0;
          agentControllers.set(socket, controller);
          lastAgentController = controller;
          hadAgentConnection = true;
          lastAgentConnectionAt = new Date().toISOString();
          socket.write(JSON.stringify({ type: 'hello', protocolVersion: 2, pid: process.pid, windowCount: BrowserWindow.getAllWindows().length }) + '\n');
          focusEditorForControl();
          publishAgentControlState();
          publishAgentSystemLog('INFO', 'MCP bridge', wasDisconnected
            ? `${controller === 'codex' ? 'Codex' : controller === 'chatgpt' ? 'ChatGPT' : 'AI client'} connection restored.`
            : `${controller === 'codex' ? 'Codex' : controller === 'chatgpt' ? 'ChatGPT' : 'AI client'} connected to the editor.`);
          restoreCheckpointIfEmpty().catch((error) => log.warn('project_checkpoint_restore_failed', { error }));
          continue;
        }
        routeAgentRequest(envelope.request)
          .then((result) => { if (!socket.destroyed) socket.write(JSON.stringify({ id: envelope.id, result }) + '\n'); })
          .catch((error) => {
            const incidentId = randomUUID();
            log.warn('agent_request_failed', { incidentId, command: envelope.request?.name, error });
            if (!socket.destroyed) socket.write(JSON.stringify({
              id: envelope.id,
              error: {
                message: error.message ?? String(error), code: error.code || 'editor_error',
                details: {
                  ...(error.details && typeof error.details === 'object' ? error.details : {}),
                  incidentId, operation: envelope.request?.name, stage: error.stage || error.details?.stage,
                  error: safeError(error), sessionId: editorSessionId, projectRevision: error.details?.projectRevision
                }
              }
            }) + '\n');
          });
      }
    });
    const heartbeat = setInterval(() => {
      if (!socket.destroyed && authenticated) socket.write(JSON.stringify({
        type: 'heartbeat', pid: process.pid, windowCount: BrowserWindow.getAllWindows().length,
        state: agentContents && !agentContents.isDestroyed() ? (mediaImports?.activeJob ? 'busy' : 'ready') : 'starting'
      }) + '\n');
    }, 5000);
    heartbeat.unref();
    socket.on('close', () => {
      clearInterval(heartbeat);
      const disconnectedController = agentControllers.get(socket) || lastAgentController;
      agentControllers.delete(socket);
      lastAgentConnectionAt = new Date().toISOString();
      publishAgentControlState();
      if (agentControllers.size === 0) publishAgentSystemLog(
        'WARN', 'MCP bridge',
        `${disconnectedController === 'codex' ? 'Codex' : disconnectedController === 'chatgpt' ? 'ChatGPT' : 'AI client'} lost connection to the editor. Waiting for reconnection; the recovery checkpoint remains available.`
      );
    });
    socket.on('error', (error) => log.warn('bridge_socket_error', { error }));
  });
  bridgeServer.on('error', (error) => log.error('bridge_server_error', { endpoint, error }));
  bridgeServer.listen(endpoint, () => log.info('bridge_listening', { endpoint }));
}

function wireAgentBridge() {
  if (agentBridgeWired) return;
  agentBridgeWired = true;
  ipcMain.on('agent:ready', (event) => {
    if (!fromOurApp(event.sender)) return;
    agentContents = event.sender;
    publishAgentControlState();
    if (agentControllers.size > 0) publishAgentSystemLog(
      'INFO', 'MCP bridge',
      `${lastAgentController === 'codex' ? 'Codex' : lastAgentController === 'chatgpt' ? 'ChatGPT' : 'AI client'} is connected and controlling the editor.`
    );
    for (const waiter of [...agentReadyWaiters]) waiter();
    restoreCheckpointIfEmpty().catch((error) => log.warn('project_checkpoint_restore_failed', { error }));
  });

  ipcMain.handle('agent:runtime-info', (event) => {
    if (!fromOurApp(event.sender)) throw new Error('Runtime information was requested by an unknown page.');
    return {
      editorVersion: app.getVersion(), apiVersion: 2, protocolVersion: 2,
      sessionId: editorSessionId, platform: process.platform, arch: process.arch,
      versions: process.versions
    };
  });

  ipcMain.on('agent:response', (event, envelope) => {
    if (!fromOurApp(event.sender) || event.sender !== agentContents) return;
    const pending = agentPending.get(envelope?.id);
    if (!pending) return;
    agentPending.delete(envelope.id);
    if (envelope.error) {
      const error = new Error(envelope.error.message || 'The editor rejected the command.');
      error.code = envelope.error.code;
      error.details = envelope.error.details;
      pending.reject(error);
    } else pending.resolve(envelope.result);
  });

  ipcMain.on('agent:progress', (event, progress) => {
    if (!fromOurApp(event.sender) || event.sender !== agentContents) return;
    const operation = agentOperations.get(String(progress?.operationId || ''));
    if (!operation) return;
    operation.state = progress.state || 'processing';
    operation.stage = progress.stage || operation.stage;
    operation.percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null;
    operation.clipId = progress.clipId || operation.clipId || null;
    operation.file = progress.file || operation.file || null;
    operation.elapsedMs = Date.now() - Date.parse(operation.startedAt);
    operation.updatedAt = new Date().toISOString();
    operation.etaMs = Number.isFinite(progress.etaMs) ? Math.max(0, progress.etaMs) : null;
  });

  ipcMain.handle('agent:read-files', async (event, paths) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    if (!Array.isArray(paths) || paths.length > 100) throw new Error('Choose between 1 and 100 media files.');
    return Promise.all(paths.map(async (candidate) => {
      const requested = admittedPath(candidate);
      const file = admittedPath(await fs.realpath(requested));
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error(`Not a file: ${file}`);
      return {
        path: file,
        name: path.basename(file),
        type: MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
        size: stat.size,
        lastModified: stat.mtimeMs,
        url: server.registerMedia(file, stat, MIME.get(path.extname(file).toLowerCase()))
      };
    }));
  });

  ipcMain.handle('agent:output-open', async (event, candidate) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    const requested = admittedPath(candidate);
    const realParent = admittedPath(await fs.realpath(path.dirname(requested)));
    const file = admittedPath(path.join(realParent, path.basename(requested)));
    const parent = await fs.stat(realParent);
    if (!parent.isDirectory()) throw new Error('The export parent is not a directory.');
    const id = randomUUID();
    outputFiles.set(id, { handle: await fs.open(file, 'w'), file, cursor: 0 });
    return id;
  });

  ipcMain.handle('agent:output-write', async (event, id, position, data) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    const output = outputFiles.get(id);
    if (!output) throw new Error('The export destination is closed.');
    const at = Number.isFinite(position) && position >= 0 ? position : output.cursor;
    const bytes = Buffer.from(data);
    const written = await output.handle.write(bytes, 0, bytes.length, at);
    output.cursor = at + written.bytesWritten;
    return output.cursor;
  });

  ipcMain.handle('agent:output-close', async (event, id) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    const output = outputFiles.get(id);
    if (!output) return;
    outputFiles.delete(id);
    await output.handle.close();
  });

  ipcMain.handle('agent:output-abort', async (event, id) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    const output = outputFiles.get(id);
    if (!output) return;
    outputFiles.delete(id);
    await output.handle.close().catch(() => {});
    await fs.unlink(output.file).catch(() => {});
  });
}

function stateOf(window) {
  return {
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused()
  };
}

/** Tells the page what its window is doing, so the lights can agree with it. */
function publishState(window) {
  if (window.isDestroyed()) return;
  window.webContents.send('window:state', stateOf(window));
}

function createWindow() {
  const restored = restoreState(app, screen, MINIMUM);

  const window = new BrowserWindow({
    width: restored.width,
    height: restored.height,
    x: restored.x,
    y: restored.y,
    minWidth: MINIMUM.width,
    minHeight: MINIMUM.height,
    /*
     * No frame, but still a real window: `resizable` keeps the resize border
     * the compositor owns, which is what lets the bezel round the page be
     * dragged, and what keeps Aero Snap and the double-click gesture working.
     */
    frame: false,
    resizable: true,
    show: false,
    backgroundColor: '#12121b',
    title: 'SimpleVlogEditor',
    icon: path.join(__dirname, '..', '..', 'web', 'src', 'assets', 'icons', 'icon-256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      /* The tools decode and encode media in workers; without this the page is
         one thread and a long recording takes minutes it does not need to. */
      backgroundThrottling: false
    }
  });

  // Painted only once there is something to paint, so the app never opens on a
  // white rectangle in front of a dark theme.
  window.once('ready-to-show', () => {
    if (restored.maximized) window.maximize();
    window.show();
  });

  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur', 'restore']) {
    window.on(event, () => publishState(window));
  }

  trackWindow(app, window);

  /* A link to somewhere else is somewhere else's business: it opens in the
     machine's browser instead of replacing the application with a web page. */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin) || (DEV && url.startsWith(DEV_URL))) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  /* With no menu there are no accelerators, and two of them are worth keeping. */
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();

    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      window.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    if (DEV && input.control && key === 'r') {
      window.webContents.reload();
      event.preventDefault();
    }
  });

  const target = DEV ? DEV_URL : origin;
  window.loadURL(MCP_OPEN ? `${target}/video-editor` : target);
  mainWindow = window;
  window.once('closed', () => { if (mainWindow === window) mainWindow = null; });
  return window;
}

/*
 * The four verbs the title bar has.
 *
 * Each acts on the window the message came from rather than on a window this
 * module remembers, so a second window — should there ever be one — is not
 * closed by a click in the first.
 */
function wireWindowControls() {
  if (windowControlsWired) return;
  windowControlsWired = true;
  const sender = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.on('window:minimize', (event) => sender(event)?.minimize());

  ipcMain.on('window:toggle-maximize', (event) => {
    const window = sender(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });

  ipcMain.on('window:close', (event) => sender(event)?.close());

  ipcMain.handle('window:state', (event) => {
    const window = sender(event);
    return window ? stateOf(window) : { maximized: false, fullScreen: false, focused: true };
  });

  /*
   * Handing the page a gesture, so a project can open its own files.
   *
   * The editor keeps a durable reference to every file the reader added, and
   * a restored project uses them to reopen the media without asking anybody
   * anything. Two things stand in the way, and both are about permission:
   * `queryPermission` answers "ask" on a window that has just started, and
   * `requestPermission` — the answer to that — may only be called while a
   * person is pressing something.
   *
   * The second is what this is for. `executeJavaScript` with `true` runs the
   * page's own function inside a real user activation, which is the only way
   * to make that call legal in a window nobody has touched yet. The permission
   * itself is then granted by the handler below without a dialog, because in
   * this window there is no address bar for anyone to answer from.
   *
   * The page names the function; if it is not there, nothing happens.
   */
  ipcMain.handle('files:reconnect', async (event) => {
    const contents = event.sender;
    if (!contents || contents.isDestroyed()) return false;

    try {
      await contents.executeJavaScript(
        'window.__sveReconnectFiles ? window.__sveReconnectFiles() : null',
        true
      );
      return true;
    } catch {
      // The page navigated, or its own reconnect threw. Neither is worth
      // failing a launch over: the reader is simply asked for the files, which
      // is what happened before any of this existed.
      return false;
    }
  });
}

/**
 * The camera, the microphone and the screen.
 *
 * The narration recorder and the meeting capture ask for these the way any page
 * does, and in a browser the user answers. Here there is no address bar to
 * answer from, so the request is granted for our own origin and refused for
 * everything else — which, with external links opening elsewhere, is everything.
 */
function wirePermissions(session) {
  /*
   * `fileSystem` is the File System Access API, and it is here for the project
   * that reopens itself.
   *
   * The editor keeps a handle for every file the reader adds — a durable
   * reference that survives the application being closed — and uses them to
   * bring the media back when the project is restored. Each use asks this
   * handler whether the page may read that file. Leaving it out of the set did
   * not merely fail to help: it *denied* the request, which is why a project
   * came back with every clip waiting and no way to explain itself.
   *
   * Granting it is not a widening of what the page can reach. A handle is not
   * a path and cannot be invented: it exists only because the reader chose that
   * exact file through a dialog or dropped it onto the window.
   */
  const ALLOWED = new Set([
    'media',
    'clipboard-sanitized-write',
    'clipboard-read',
    'fullscreen',
    'pointerLock',
    'fileSystem'
  ]);

  const fromUs = (contents) => {
    const url = contents?.getURL?.() ?? '';
    return url.startsWith(origin) || (DEV && url.startsWith(DEV_URL));
  };

  session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(fromUs(contents) && ALLOWED.has(permission));
  });

  /*
   * The same answer, to the question asked without a dialog.
   *
   * `queryPermission` — which is what a restored project calls before it has
   * any gesture to spend — goes through this rather than through the handler
   * above. Answering it here is what lets the media come back with nothing
   * said at all; the gesture route in `files:reconnect` stays as the fallback
   * for the builds where it does not.
   */
  if (typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler((contents, _permission, requestingOrigin) => {
      // Deliberately not filtered by `ALLOWED`. This handler answers a question
      // asked *silently*, and narrowing it would take away capabilities the
      // window has today — the screen picker's own check among them — in order
      // to add one. The origin is the boundary that matters, and it is the same
      // one the request handler above enforces.
      if (contents) return fromUs(contents);
      return typeof requestingOrigin === 'string' && requestingOrigin.startsWith(origin);
    });
  }

  /* `getDisplayMedia` needs a source, and the source has to be chosen by a
     person. Windows 11 has a picker of its own; where it is missing the request
     is refused rather than silently sharing a screen nobody picked. */
  if (typeof session.setDisplayMediaRequestHandler === 'function') {
    session.setDisplayMediaRequestHandler(
      (_request, callback) => callback({}),
      { useSystemPicker: true }
    );
  }
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  // The loopback server also owns private, range-enabled media URLs, including
  // in development where the UI itself is served by Angular's dev server.
  server = await startServer(siteRoot());
  origin = DEV ? DEV_URL : server.origin;

  wireWindowControls();
  wireAgentBridge();
  wirePermissions(require('electron').session.defaultSession);

  mediaImports = new MediaImportService({
    callEditor,
    registerMedia: (file, stat, type) => ({ filePath: file, name: path.basename(file), type, size: stat.size, lastModified: stat.mtimeMs, url: server.registerMedia(file, stat, type) }),
    roots: () => [...MCP_ROOTS],
    stateFile: path.join(app.getPath('userData'), 'mcp-import-jobs.json'),
    checkpoint: (reason) => checkpointProject(reason)
  });
  await mediaImports.restore();
  startEditorBridgeServer();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  for (const output of outputFiles.values()) await output.handle.close().catch(() => {});
  outputFiles.clear();
  if (bridgeServer) await new Promise((done) => bridgeServer.close(() => done())).catch(() => {});
  if (server) await server.close();
});

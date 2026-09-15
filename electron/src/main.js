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

const { app, BrowserWindow, dialog, ipcMain, screen, shell, Menu } = require('electron');
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
const { IdempotencyLedger } = require('./idempotency-ledger');
const { RecoveryCheckpointStore } = require('./recovery-checkpoint-store');
const { preferredPort, rememberPort } = require('./stable-origin');
const { editorLocationFile, rememberEditorLocation } = require('./editor-location');
const { RootStore } = require('./mcp-roots');
const { rootsFile, readRoots, writeRoots } = require('./roots-store-file');

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
/** Four missed acknowledgements. Long enough that a busy client is never cut off. */
const AGENT_SILENCE_TIMEOUT_MS = 20_000;
const DEV_URL = process.env.SVE_DEV_URL || 'http://localhost:4200';
const log = createLogger('electron-main');

/**
 * Files reachable by the editor, from its own window and from MCP alike.
 *
 * Built once the application knows where the user's folders are — `app.getPath`
 * is what supplies the defaults, so this cannot be a module-level constant. See
 * mcp-roots.js for the layers and the denylist.
 */
let rootStoreInstance = null;

function ownApplicationData() {
  // roots.json and the recovery checkpoint live inside AppData by design, and
  // the denylist refuses AppData wholesale. These two survive it.
  const found = [];
  for (const attempt of [() => app.getPath('userData'), () => path.join(app.getPath('appData'), 'SimpleVlogEditor'),
    () => process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'SimpleVlogEditor')]) {
    try { const value = attempt(); if (value) found.push(value); } catch { /* not every platform defines it */ }
  }
  return found;
}

function rootStore() {
  if (!rootStoreInstance) {
    rootStoreInstance = new RootStore({
      getPath: (name) => app.getPath(name),
      allowances: ownApplicationData(),
      onChange: (state) => {
        log.info('mcp_roots_changed', { roots: state.roots, rootSource: state.rootSource });
        publishRootState(state);
      }
    });
    log.info('mcp_roots', rootStoreInstance.describe());
  }
  return rootStoreInstance;
}

/**
 * The native folder picker, which is the only thing that grants anything.
 *
 * On Windows and Linux there is no operating-system prompt beyond this dialog:
 * the editor runs as the user and can already reach what the user can reach, so
 * the picker is the consent and the Allowed folders list is the transparency.
 * Under Flatpak or snap, Electron routes this same dialog through the desktop
 * portal. On macOS the picker is what grants TCC access; `securityScopedBookmarks`
 * additionally returns a token that a sandboxed (Mac App Store) build must store
 * and re-open at launch, or the grant dies with the process.
 *
 * @returns {Promise<{folder: string, bookmark?: string}|null>} null when cancelled
 */
async function chooseFolder(options = {}) {
  const properties = ['openDirectory', 'createDirectory'];
  if (process.platform === 'darwin') properties.push('securityScopedBookmarks');
  const result = await (options.window
    ? dialog.showOpenDialog(options.window, { ...pickerOptions(options), properties })
    : dialog.showOpenDialog({ ...pickerOptions(options), properties }));
  if (result.canceled || !result.filePaths?.length) return null;
  return { folder: path.resolve(result.filePaths[0]), bookmark: result.bookmarks?.[0] || undefined };
}

function pickerOptions(options) {
  return {
    title: options.title || 'Choose a folder the editor may use',
    message: options.message || '',
    buttonLabel: options.buttonLabel || 'Allow this folder',
    ...(options.defaultPath ? { defaultPath: options.defaultPath } : {})
  };
}

/** Where consent is remembered, beside editor-location.json. */
function consentFile() {
  return rootsFile(process.env.LOCALAPPDATA, app.getPath('userData'));
}

/**
 * Grants carry more than a path on macOS, so they are held here rather than
 * reconstructed from the store's plain string list.
 */
const consentGrants = new Map();
let consentWrite = Promise.resolve();

/** Serialized: two windows granting at once must not interleave writes. */
function persistConsent() {
  const snapshot = [...consentGrants.values()];
  consentWrite = consentWrite
    .then(() => writeRoots(consentFile(), snapshot))
    .catch((error) => log.warn('roots_persist_failed', { error }));
  return consentWrite;
}

/**
 * Remember a folder the user chose. Returns the same shape the store does, so
 * a refusal by policy reaches the caller with its reason instead of being
 * silently dropped.
 */
function rememberConsent(folder, options = {}) {
  const outcome = rootStore().add(folder, 'consent');
  if (!outcome.added && outcome.reason) return outcome;
  const key = process.platform === 'win32' ? outcome.root.toLowerCase() : outcome.root;
  const existing = consentGrants.get(key);
  consentGrants.set(key, {
    path: outcome.root,
    grantedAt: existing?.grantedAt || new Date().toISOString(),
    ...(options.bookmark || existing?.bookmark ? { bookmark: options.bookmark || existing?.bookmark } : {})
  });
  persistConsent();
  return outcome;
}

function forgetConsent(folder) {
  const resolved = path.resolve(String(folder || ''));
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const removed = rootStore().remove(resolved);
  if (consentGrants.delete(key)) persistConsent();
  return removed;
}

/**
 * Read at startup. A grant the denylist now refuses — a folder that has since
 * become a system location, or a record written by an older build — is dropped
 * rather than honoured.
 */
async function restoreConsent() {
  const stored = await readRoots(consentFile());
  let dropped = 0;
  for (const entry of stored.roots) {
    const outcome = rootStore().add(entry.path, 'consent');
    if (!outcome.added && outcome.reason) { dropped++; continue; }
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    consentGrants.set(key, entry);
    if (process.platform === 'darwin' && entry.bookmark && process.mas) {
      // Without this the path is remembered but the sandbox still refuses it.
      try { app.startAccessingSecurityScopedResource(entry.bookmark); }
      catch (error) { log.warn('security_scoped_bookmark_failed', { path: entry.path, error }); }
    }
  }
  log.info('roots_restored', { file: consentFile(), granted: consentGrants.size, dropped });
  if (dropped) persistConsent();
}

function admittedPath(candidate) {
  // The standalone recovery document is the sole host-owned path the renderer
  // may reopen; all caller-selected media and outputs remain constrained to the
  // allowed roots.
  return rootStore().admit(candidate, { allowances: [recoveryProjectPath()] });
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
/** When the client last said it was alive, whatever the model was doing. */
let lastClientHealthAt = null;
let lastClientHealth = null;
let recoveryRoot = null;
let restoreAttemptedPath = null;
const mutationLedger = new IdempotencyLedger({ limit: 500 });

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

const TERMINAL_OPERATION_STATES = new Set(['applied', 'failed', 'cancelled', 'recovered']);

function activeAgentOperations() {
  return [...agentOperations.values()].filter((operation) => !TERMINAL_OPERATION_STATES.has(operation.state));
}

/** Keeps operation polling useful without retaining frame pixels or unbounded transcripts. */
function summarizeOperationResult(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}… [truncated]` : value;
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= 5) return Array.isArray(value) ? `[array:${value.length}]` : '[object]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((entry) => summarizeOperationResult(entry, depth + 1, seen));
    if (value.length > items.length) items.push(`[${value.length - items.length} more item(s)]`);
    return items;
  }
  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    result[key] = key === 'dataUrl' ? '[image data omitted]' : summarizeOperationResult(entry, depth + 1, seen);
  }
  return result;
}

function recoveryProjectPath() {
  const root = recoveryRoot || path.join(app.getPath('userData'), 'recovery');
  return path.join(root, 'simplevlogeditor-recovery.sve.json');
}

const checkpointStore = new RecoveryCheckpointStore(() => recoveryProjectPath());

/**
 * Which client is driving, reduced to the names the editor knows how to dress.
 *
 * The value arrives from the client's own `SVE_CONTROLLER`, so it is whatever a
 * plugin author wrote: the Claude Code plugin sends `claude-code`, and a person
 * configuring the server by hand might reasonably write `claude`. Both mean the
 * same window, so both fold into one name rather than falling through to the
 * generic badge.
 */
function normalizedController(value) {
  const name = String(value || '').trim().toLowerCase();
  if (name === 'codex' || name === 'chatgpt') return name;
  if (name === 'claude' || name === 'claude-code' || name === 'claude_code' || name === 'claudecode') return 'claude-code';
  return 'mcp';
}

function agentControlState() {
  const controllers = [...new Set(agentControllers.values())];
  const connected = controllers.length > 0;
  return {
    active: connected,
    visible: connected || hadAgentConnection,
    connectionStatus: connected ? 'connected' : hadAgentConnection ? 'disconnected' : 'idle',
    // First match wins, and the order is only a tie-break for the rare case of
    // two clients connected at once: the badge can name one of them, and the
    // full list is published beside it for anything that wants both.
    controller: ['codex', 'chatgpt', 'claude-code'].find((name) => controllers.includes(name)) || lastAgentController,
    controllers,
    sessionId: editorSessionId,
    lastConnectionAt: lastAgentConnectionAt,
    lastClientHealthAt: lastClientHealthAt,
    recoveryPath: recoveryProjectPath()
  };
}

function publishAgentControlState() {
  if (agentContents && !agentContents.isDestroyed()) {
    agentContents.send('agent:control-state', agentControlState());
  }
}

/**
 * The Allowed folders screen and the consent dialog both read this, and both
 * must see a change the moment it happens rather than on the next restart.
 */
function publishRootState(state) {
  if (agentContents && !agentContents.isDestroyed()) {
    agentContents.send('roots:state', state);
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
    let settled = false;
    let readyRetry = null;
    let readyWaiter = null;
    const operation = {
      operationId, name: request.name, state: 'processing', stage: 'dispatching', percent: null,
      startedAt: new Date(started).toISOString(), updatedAt: new Date(started).toISOString(),
      elapsedMs: 0, projectRevision: null, result: null, error: null
    };
    agentOperations.set(operationId, operation);
    while (agentOperations.size > 500) agentOperations.delete(agentOperations.keys().next().value);
    const clearReadyWait = () => {
      if (readyRetry) clearTimeout(readyRetry);
      readyRetry = null;
      if (readyWaiter) agentReadyWaiters.delete(readyWaiter);
      readyWaiter = null;
    };
    const send = () => {
      if (settled) return;
      if (!agentContents || agentContents.isDestroyed()) {
        operation.state = 'unresponsive';
        operation.stage = 'waiting-for-renderer';
        operation.elapsedMs = Date.now() - started;
        operation.updatedAt = new Date().toISOString();
        if (Date.now() - started > 30000) {
          const error = Object.assign(new Error('The editor did not become ready.'), { code: 'renderer_unresponsive' });
          operation.state = 'failed';
          operation.error = { code: error.code, message: error.message };
          operation.updatedAt = new Date().toISOString();
          settled = true;
          clearReadyWait();
          return reject(error);
        }
        if (!readyWaiter) {
          readyWaiter = () => {
            clearReadyWait();
            send();
          };
          agentReadyWaiters.add(readyWaiter);
        }
        if (!readyRetry) {
          readyRetry = setTimeout(() => {
            readyRetry = null;
            send();
          }, 250);
        }
        return;
      }

      clearReadyWait();
      const id = `agent-${++agentSequence}`;
      const timer = setTimeout(() => {
        agentPending.delete(id);
        operation.state = 'failed';
        operation.stage = 'timeout';
        operation.elapsedMs = Date.now() - started;
        operation.updatedAt = new Date().toISOString();
        operation.error = { code: 'editor_timeout', message: `Editor command "${request.name}" timed out.` };
        settled = true;
        reject(Object.assign(new Error(operation.error.message), { code: operation.error.code, details: { operationId } }));
      }, 30 * 60 * 1000);
      agentPending.set(id, {
        operationId,
        resolve: (value) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          operation.state = 'applied';
          operation.stage = 'completed';
          operation.percent = 100;
          operation.elapsedMs = Date.now() - started;
          operation.updatedAt = new Date().toISOString();
          operation.projectRevision = value?.projectRevision ?? null;
          operation.result = {
            apiVersion: value?.apiVersion,
            projectRevision: value?.projectRevision,
            value: summarizeOperationResult(value?.result)
          };
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
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
  const response = await callEditor({ name: 'get_project', arguments: {} });
  const document = response.result?.project;
  const clipCount = Number(response.result?.clipCount || 0);
  const saved = clipCount > 0
    ? await checkpointStore.write(document, response.projectRevision, reason)
    : await checkpointStore.remove(response.projectRevision, reason);
  log.info(clipCount > 0 ? 'project_checkpoint_saved' : 'project_checkpoint_removed', {
    path: saved.path, reason, projectRevision: response.projectRevision, source: 'electron-snapshot'
  });
  return agentResponse({
    saved: clipCount > 0,
    removed: clipCount === 0,
    path: saved.path,
    reason,
    projectRevision: response.projectRevision
  }, response.projectRevision);
}

async function checkpointRendererProject(payload) {
  const result = await checkpointStore.write(
    payload?.document,
    payload?.projectRevision,
    payload?.reason || 'Editor autosave'
  );
  if (!result.skipped) log.info('project_checkpoint_saved', {
    path: result.path, reason: result.reason, projectRevision: result.projectRevision, source: 'renderer-autosave'
  });
  return result;
}

async function clearRendererCheckpoint(payload) {
  const result = await checkpointStore.remove(payload?.projectRevision, payload?.reason || 'Project cleared');
  log.info('project_checkpoint_removed', { path: result.path, projectRevision: result.projectRevision });
  return result;
}

/**
 * What is in the checkpoint, not merely that there is one.
 *
 * A caller resuming an edit has to decide whether this checkpoint belongs to
 * the work in front of it, and a path, a size and a date cannot answer that.
 * The media it refers to can: same folder, same files, same edit. Read from the
 * document itself and deliberately shallow — names, paths and counts, never the
 * timeline — so that deciding "is this mine" costs one call and no bytes.
 */
async function recoveryState() {
  const checkpointPath = recoveryProjectPath();
  let stat;
  try { stat = await fs.stat(checkpointPath); }
  catch (error) {
    if (error.code === 'ENOENT') return { path: checkpointPath, exists: false, size: 0, modifiedAt: null };
    throw error;
  }
  const base = { path: checkpointPath, exists: stat.isFile(), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  if (!base.exists) return base;

  try {
    const document = JSON.parse(await fs.readFile(checkpointPath, 'utf8'));
    const clips = Array.isArray(document?.clips) ? document.clips : [];
    const media = [];
    for (const clip of clips) {
      if (clip?.kind !== 'media' || !clip.file) continue;
      media.push({
        clipId: typeof clip.id === 'string' ? clip.id : null,
        name: typeof clip.file.name === 'string' ? clip.file.name : null,
        path: typeof clip.file.path === 'string' ? clip.file.path : null
      });
    }
    const folders = [...new Set(media.map((entry) => entry.path).filter(Boolean).map((entry) => path.dirname(entry)))];
    return {
      ...base,
      projectRevision: Number.isFinite(document?.projectRevision) ? document.projectRevision : null,
      clipCount: clips.length,
      media,
      // Every media file in the checkpoint carries its folder; one folder means
      // one working directory, which is the usual shape of a resumed edit.
      folders,
      // Restoring reconnects these from disk automatically. Any that are no
      // longer where the project left them stay waiting and are named.
      missingMedia: await Promise.all(media.filter((entry) => entry.path).map(async (entry) => {
        try { await fs.stat(entry.path); return null; }
        catch { return entry.path; }
      })).then((found) => found.filter(Boolean))
    };
  } catch (error) {
    // A checkpoint too damaged to summarise is still a checkpoint worth
    // reporting; the caller decides whether to open it.
    log.warn('project_checkpoint_unreadable', { path: checkpointPath, error });
    return { ...base, unreadable: true };
  }
}

/**
 * The editor is not open for business until it has finished opening.
 *
 * A client connects and its first tool call can arrive twenty milliseconds
 * later, while the checkpoint is still being restored and the media still being
 * reconnected. Everything it was told in that window was true for a fraction of
 * a second: `transcribe clip-0` was answered "not found" on a project that was
 * about to have clip-0 in it, and a `get_project` that raced the restore handed
 * back revision 4 for a project that settled at 8 — so the batch guarded on 4
 * and was refused. Both read as editor faults and neither was one.
 *
 * So the bridge holds those calls instead of answering them from a half-built
 * project. Status and control are exempt: asking whether the editor is healthy,
 * or telling it to stop, must work precisely when it is busy.
 *
 * The ceiling matters as much as the gate. A startup that never finishes must
 * degrade to the old behaviour rather than hanging every command forever.
 */
const STARTUP_GATE_TIMEOUT_MS = 30_000;

/** Answerable while the project is still being assembled: they do not read it. */
const STARTUP_EXEMPT = new Set([
  'health_check', 'get_diagnostics', 'get_recovery_state', 'get_editor_capabilities',
  'get_operation_status', 'cancel_operation', 'get_import_status', 'cancel_import',
  'close_editor', 'restart_editor'
]);

let startupSettled = null;
let releaseStartup = null;

function startupGate() {
  if (!startupSettled) {
    startupSettled = new Promise((resolve) => { releaseStartup = resolve; });
    const ceiling = setTimeout(() => {
      log.warn('startup_gate_timeout', { afterMs: STARTUP_GATE_TIMEOUT_MS });
      finishStartup('timeout');
    }, STARTUP_GATE_TIMEOUT_MS);
    ceiling.unref?.();
    startupSettled.finally(() => clearTimeout(ceiling));
  }
  return startupSettled;
}

function finishStartup(reason) {
  if (!releaseStartup) return;
  const release = releaseStartup;
  releaseStartup = null;
  log.info('startup_settled', { reason });
  release();
}

async function restoreCheckpointIfEmpty() {
  const checkpointPath = recoveryProjectPath();
  // The renderer is not up yet: leave the gate shut, because `agent:ready`
  // calls this again and that attempt is the one that decides.
  if (!agentContents || agentContents.isDestroyed()) return;
  if (restoreAttemptedPath === checkpointPath) { finishStartup('already_attempted'); return; }
  restoreAttemptedPath = checkpointPath;
  try {
    const state = await recoveryState();
    if (!state.exists) return;
    const current = await callEditor({ name: 'get_project', arguments: {} });
    if (Number(current.result?.clipCount || 0) > 0) {
      log.info('project_checkpoint_restore_skipped', { path: checkpointPath, reason: 'editor_not_empty' });
      return;
    }
    const restored = await callEditor({ name: 'open_project', arguments: { path: checkpointPath } });
    log.info('project_checkpoint_restored', { path: checkpointPath, projectRevision: restored.projectRevision });
  } finally {
    // Restored, skipped or thrown — the project is as assembled as it is going
    // to get, and holding the agent past that point would be its own fault.
    finishStartup('restore_complete');
  }
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

async function executeAgentRequest(request) {
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
    case 'health_check': {
      const activeOperations = activeAgentOperations();
      return agentResponse({
        state: agentContents && !agentContents.isDestroyed()
          ? (mediaImports.activeJob || activeOperations.length ? 'processing' : 'ready')
          : 'starting',
        connectionStatus: agentControlState().connectionStatus,
        electronPid: process.pid,
        sessionId: editorSessionId,
        // Reported here as well as in get_diagnostics: a caller that hit
        // path_not_allowed should not need a second tool to see what is allowed.
        ...rootStore().describe(),
        queue: mediaImports.diagnostics(),
        operations: {
          activeCount: activeOperations.length,
          active: activeOperations.slice(-20).map(({ operationId, name, state, stage, percent, startedAt, updatedAt }) => ({
            operationId, name, state, stage, percent, startedAt, updatedAt
          }))
        }
      });
    }
    case 'get_operation_status': {
      const operation = agentOperations.get(String(args.operationId || ''));
      if (!operation) throw Object.assign(new Error(`Operation "${args.operationId}" was not found in this editor session.`), { code: 'operation_not_found' });
      return agentResponse({ ...operation, sessionId: editorSessionId, terminal: TERMINAL_OPERATION_STATES.has(operation.state) }, operation.projectRevision);
    }
    case 'cancel_operation': {
      const operationId = String(args.operationId || '');
      const operation = agentOperations.get(operationId);
      if (!operation) throw Object.assign(new Error(`Operation "${operationId}" was not found in this editor session.`), { code: 'operation_not_found' });
      if (TERMINAL_OPERATION_STATES.has(operation.state)) {
        return agentResponse({ ...operation, cancellationRequested: false, terminal: true }, operation.projectRevision);
      }
      operation.state = 'canceling';
      operation.stage = 'cancellation-requested';
      operation.updatedAt = new Date().toISOString();
      if (agentContents && !agentContents.isDestroyed()) agentContents.send('agent:cancel', { operationId });
      return agentResponse({ ...operation, cancellationRequested: true, terminal: false }, operation.projectRevision);
    }
    case 'get_diagnostics': {
      const [ffmpeg, ffprobe] = await Promise.all([commandVersion(process.env.SVE_FFMPEG || 'ffmpeg'), commandVersion(process.env.SVE_FFPROBE || 'ffprobe')]);
      const recentOperations = [...agentOperations.values()].slice(-20).map((operation) => ({
        operationId: operation.operationId, name: operation.name, state: operation.state,
        stage: operation.stage, percent: operation.percent, elapsedMs: operation.elapsedMs,
        projectRevision: operation.projectRevision, error: operation.error,
        startedAt: operation.startedAt, updatedAt: operation.updatedAt
      }));
      return agentResponse({
        editorVersion: app.getVersion(), apiVersion: 2, protocolVersion: 2, electronPid: process.pid,
        sessionId: editorSessionId, platform: process.platform, arch: process.arch,
        versions: process.versions,
        windowCount: BrowserWindow.getAllWindows().length,
        rendererReady: Boolean(agentContents && !agentContents.isDestroyed()),
        ...rootStore().describe(),
        clientHealth: lastClientHealth,
        imports: mediaImports.diagnostics(), operations: recentOperations,
        idempotency: { cachedMutations: mutationLedger.size, scope: 'editor-session-and-recovery-project' },
        connection: agentControlState(), memory: process.memoryUsage(),
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
      if ((request.name === 'apply_edit_batch' && args.dryRun !== true) || request.name === 'suppress_noise') {
        await checkpointProject(request.name === 'suppress_noise'
          ? 'Before noise suppression'
          : `Before edit batch: ${String(args.label || 'Agent edit')}`);
      }
      let completionCheckpoint = null;
      if (request.name === 'finish_editing') {
        try { completionCheckpoint = await checkpointProject('AI editing completed'); }
        catch (error) { log.warn('completion_checkpoint_failed', { error }); }
      }
      const response = await callEditor(request);
      if (request.name === 'finish_editing' && response.result && typeof response.result === 'object') {
        response.result = {
          ...response.result,
          checkpoint: completionCheckpoint?.result || null
        };
      }
      if (request.name === 'get_editor_capabilities' && response.result && typeof response.result === 'object') {
        const hostCommands = [
          'queue_media_import', 'get_import_status', 'cancel_import', 'resume_import',
          'health_check', 'get_operation_status', 'cancel_operation', 'get_diagnostics',
          'get_recovery_state', 'checkpoint_project', 'close_editor', 'restart_editor'
        ];
        response.result.hostCommands = hostCommands;
        response.result.commands = [...new Set([...(Array.isArray(response.result.commands) ? response.result.commands : []), ...hostCommands])];
        response.result.control = {
          visibleWindow: true,
          activityModal: true,
          automaticCheckpoint: recoveryProjectPath(),
          manualEditCheckpoint: true,
          mutationIdempotency: 'requestId scoped to editor session and recovery project',
          orderedRendererLane: true,
          priorityCommands: ['health_check', 'get_operation_status', 'cancel_operation', 'get_import_status', 'cancel_import', 'get_diagnostics', 'get_recovery_state', 'close_editor', 'restart_editor']
        };
      }
      const mutatesProject = request.name === 'undo' || request.name === 'redo' ||
        request.name === 'open_project' || request.name === 'set_project_soundtrack' || request.name === 'analyze_silence' ||
        request.name === 'analyze_noise' || request.name === 'suppress_noise' ||
        (request.name === 'apply_edit_batch' && args.dryRun !== true);
      if (mutatesProject) {
        try { await checkpointProject(`After ${request.name}`); }
        catch (error) { log.warn('automatic_checkpoint_failed', { command: request.name, error }); }
      }
      return response;
    }
  }
}

const IDEMPOTENT_PROJECT_MUTATIONS = new Set([
  'add_media',
  'queue_media_import',
  'open_project',
  'set_project_soundtrack',
  'apply_edit_batch',
  'undo',
  'redo',
  'analyze_silence',
  'analyze_noise',
  'suppress_noise'
]);

/**
 * A lost bridge response must never turn one edit into two edits. The ledger is
 * scoped to this Electron session and recovery project: reconnecting MCP hosts
 * replay the original result, while a restarted editor requires a fresh state
 * read and fresh request ids, as advertised by the protocol.
 */
async function routeAgentRequest(request) {
  // Every call that reads or changes the project waits for startup. See
  // `startupGate`: this is the whole reason it exists.
  if (!STARTUP_EXEMPT.has(request?.name)) await startupGate();
  if (!IDEMPOTENT_PROJECT_MUTATIONS.has(request?.name) || request?.arguments?.dryRun === true) {
    return executeAgentRequest(request);
  }
  const args = request.arguments || {};
  const requestId = args.requestId;
  const payload = {
    name: request.name,
    arguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'requestId'))
  };
  const scope = `${editorSessionId}:${recoveryProjectPath()}`;
  return mutationLedger.run(scope, requestId, payload, () => executeAgentRequest(request));
}

/** The editor owns a stable endpoint. MCP adapters may disconnect/reconnect without closing it. */
function startEditorBridgeServer() {
  const endpoint = editorEndpoint();
  bridgeServer = net.createServer((socket) => {
    let buffered = '';
    let authenticated = false;
    // Declared with the socket, read by both the data handler and the
    // heartbeat below. See the heartbeat for why silence is what disconnects.
    let acknowledged = false;
    let lastSeenAt = Date.now();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      while (buffered.includes('\n')) {
        const at = buffered.indexOf('\n');
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        // Anything at all arriving is proof the peer is alive, an ack most of
        // all; a client in the middle of a long edit is not silent.
        lastSeenAt = Date.now();
        let envelope;
        try { envelope = JSON.parse(line); }
        catch { socket.write(JSON.stringify({ error: { code: 'invalid_envelope', message: 'Invalid bridge JSON.' } }) + '\n'); continue; }
        if (!authenticated) {
          if (envelope.type !== 'hello' || envelope.protocolVersion !== 2) { socket.destroy(); continue; }
          authenticated = true;
          const declared = (envelope.roots || []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
          rootStore().setLayer('mcp-client', declared);
          const admittedRoots = rootStore().entries()
            .filter((entry) => entry.source === 'mcp-client')
            .map((entry) => entry.path);
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
          startupGate();
          restoreCheckpointIfEmpty().catch((error) => log.warn('project_checkpoint_restore_failed', { error }));
          continue;
        }
        // The MCP client can answer roots/list after the handshake, and can
        // change its mind later through roots/list_changed. Both arrive here.
        if (envelope.type === 'heartbeat_ack') { acknowledged = true; continue; }
        // The client saying it is still here, on its own schedule rather than
        // in answer to ours. A model thinking for four minutes sends no tool
        // calls, and that silence is not a disconnection.
        if (envelope.type === 'client_health') {
          acknowledged = true;
          lastClientHealth = {
            at: typeof envelope.at === 'string' ? envelope.at : new Date().toISOString(),
            pid: envelope.pid ?? null,
            controller: normalizedController(envelope.controller),
            pendingCalls: Number.isFinite(envelope.pendingCalls) ? envelope.pendingCalls : null
          };
          lastClientHealthAt = lastClientHealth.at;
          // Deliberately not published to the window: this arrives every few
          // seconds and nothing on screen changes because of it. The badge
          // already says "connected"; repainting it is noise.
          continue;
        }
        if (envelope.type === 'roots') {
          const declared = (envelope.roots || []).filter((root) => typeof root === 'string' && path.isAbsolute(root));
          if (rootStore().setLayer('mcp-client', declared)) {
            publishAgentSystemLog('INFO', 'MCP bridge',
              declared.length
                ? `The MCP client connected ${declared.length} folder${declared.length === 1 ? '' : 's'}.`
                : 'The MCP client disconnected its folders.');
          }
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
    /*
     * Liveness has to be proved, not assumed.
     *
     * A named pipe whose peer disappeared without closing — the client killed,
     * the machine asleep — stays writable, and `close` never fires. The editor
     * then goes on heartbeating into nothing and reporting itself connected,
     * which is what made a dead session look like a live one.
     *
     * So the client answers, and silence is what disconnects it. The timeout is
     * only armed once an answer has actually arrived: a client built before
     * this never answers, and must not be hung up on for it.
     */
    const heartbeat = setInterval(() => {
      if (socket.destroyed || !authenticated) return;
      if (acknowledged && Date.now() - lastSeenAt > AGENT_SILENCE_TIMEOUT_MS) {
        log.warn('bridge_peer_silent', {
          silentForMs: Date.now() - lastSeenAt,
          controller: agentControllers.get(socket) || lastAgentController
        });
        socket.destroy();
        return;
      }
      socket.write(JSON.stringify({
        type: 'heartbeat', pid: process.pid, windowCount: BrowserWindow.getAllWindows().length,
        state: agentContents && !agentContents.isDestroyed()
          ? (mediaImports?.activeJob || activeAgentOperations().length ? 'busy' : 'ready')
          : 'starting'
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
    // An MCP-launched window receives its project root in the bridge hello.
    // Waiting for that hello avoids restoring an unrelated standalone
    // user-data checkpoint during the few milliseconds before it arrives.
    if (!MCP_OPEN || agentControllers.size > 0) {
      restoreCheckpointIfEmpty().catch((error) => log.warn('project_checkpoint_restore_failed', { error }));
    } else {
      // Launched by MCP and no client has said hello yet. The hello opens the
      // gate; nothing here should hold it shut on its own.
      finishStartup('renderer_ready_without_client');
    }
  });

  ipcMain.handle('agent:runtime-info', (event) => {
    if (!fromOurApp(event.sender)) throw new Error('Runtime information was requested by an unknown page.');
    return {
      editorVersion: app.getVersion(), apiVersion: 2, protocolVersion: 2,
      sessionId: editorSessionId, platform: process.platform, arch: process.arch,
      versions: process.versions
    };
  });

  ipcMain.handle('project:checkpoint', async (event, payload) => {
    if (!fromOurApp(event.sender)) throw new Error('A recovery save was requested by an unknown page.');
    return checkpointRendererProject(payload);
  });

  ipcMain.handle('project:checkpoint-clear', async (event, payload) => {
    if (!fromOurApp(event.sender)) throw new Error('A recovery reset was requested by an unknown page.');
    return clearRendererCheckpoint(payload);
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
    for (const key of ['operationIndex', 'operationCount', 'frameIndex', 'frameCount', 'clipIndex', 'clipCount']) {
      if (Number.isFinite(progress[key])) operation[key] = progress[key];
    }
    if (typeof progress.clipName === 'string') operation.clipName = progress.clipName.slice(0, 500);
  });

  /*
   * A file the user put into this window with a picker or a drop. Their choice
   * is the consent: the folder that holds it becomes reachable, and is
   * remembered so the same project opens tomorrow without asking again.
   */
  ipcMain.handle('roots:remember', async (event, paths) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    const candidates = (Array.isArray(paths) ? paths : [paths])
      .filter((entry) => typeof entry === 'string' && entry.trim() && path.isAbsolute(entry))
      .slice(0, 200);
    const granted = [];
    const refused = [];
    for (const candidate of candidates) {
      let folder = path.dirname(path.resolve(candidate));
      try { if ((await fs.stat(candidate)).isDirectory()) folder = path.resolve(candidate); }
      catch { /* a path that is gone still names the folder it was in */ }
      if (rootStore().admits(folder)) continue;
      const outcome = rememberConsent(folder);
      if (outcome.added) granted.push(outcome.root);
      else if (outcome.reason) refused.push({ folder: outcome.root, reason: outcome.reason });
    }
    if (granted.length) {
      log.info('roots_granted_by_choice', { granted });
      publishAgentSystemLog('INFO', 'Allowed folders',
        `Allowed ${granted.length} folder${granted.length === 1 ? '' : 's'} you chose: ${granted.join(', ')}`);
    }
    return { granted, refused, ...rootStore().describe() };
  });

  /*
   * Asked before a path is used, not after it fails. "Ask rather than fail"
   * only works if the window knows what is missing while it can still put a
   * dialog in front of the user, and an IPC rejection carries a message but
   * none of the error's own fields — so the check is a question, not a catch.
   */
  ipcMain.handle('roots:ensure', (event, paths) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    const missing = [];
    for (const candidate of (Array.isArray(paths) ? paths : [paths]).slice(0, 500)) {
      if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) continue;
      const resolved = path.resolve(candidate);
      if (rootStore().admits(resolved)) continue;
      const folder = path.dirname(resolved);
      if (!missing.some((entry) => entry.folder === folder)) missing.push({ path: resolved, folder });
    }
    return { missing, ...rootStore().describe() };
  });

  ipcMain.handle('roots:list', (event) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    return rootStore().describe();
  });

  /** "Add folder…" in the settings. The picker itself is the consent. */
  ipcMain.handle('roots:add', async (event) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    const chosen = await chooseFolder({
      window: BrowserWindow.fromWebContents(event.sender),
      title: 'Choose a folder the editor may use',
      message: 'The editor will be able to read media from this folder and write exports into it.',
      buttonLabel: 'Allow this folder'
    });
    if (!chosen) return { granted: null, cancelled: true, ...rootStore().describe() };
    const outcome = rememberConsent(chosen.folder, { bookmark: chosen.bookmark });
    return {
      granted: outcome.added ? outcome.root : null,
      refused: outcome.reason ? { folder: outcome.root, reason: outcome.reason } : null,
      cancelled: false,
      ...rootStore().describe()
    };
  });

  ipcMain.handle('roots:remove', (event, folder) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    const removed = forgetConsent(folder);
    if (removed) log.info('roots_revoked', { folder: path.resolve(String(folder || '')) });
    return { removed, ...rootStore().describe() };
  });

  /*
   * An agent asked for a path the editor may not reach. Rather than failing,
   * the window explains what was asked for and this opens the native folder
   * picker positioned at that folder. What the user picks there is the grant —
   * the request only positions the dialog, and a pick that does not contain the
   * requested path is refused and explained rather than quietly widened.
   */
  ipcMain.handle('roots:request-consent', async (event, request) => {
    if (!fromOurApp(event.sender)) throw new Error('Folder access was requested by an unknown page.');
    const wanted = typeof request?.path === 'string' && request.path.trim() ? path.resolve(request.path) : null;
    if (!wanted) throw Object.assign(new Error('A path is required to ask for access.'), { code: 'path_required' });
    const folder = typeof request?.folder === 'string' && request.folder.trim()
      ? path.resolve(request.folder)
      : path.dirname(wanted);

    const chosen = await chooseFolder({
      window: BrowserWindow.fromWebContents(event.sender),
      defaultPath: folder,
      title: 'Allow the editor to use this folder',
      message: `Choose ${path.basename(folder) || folder}, or a folder above it, to allow access to ${path.basename(wanted)}.`,
      buttonLabel: 'Allow this folder'
    });

    if (!chosen) {
      log.info('path_consent_denied', { path: wanted, folder });
      publishAgentSystemLog('WARN', 'Allowed folders', `Access to ${folder} was not granted.`);
      return { granted: null, code: 'path_consent_denied', ...rootStore().describe() };
    }

    // defaultPath only positions the dialog. The folder actually chosen decides
    // the scope, and it has to contain what was asked for.
    const relative = path.relative(chosen.folder, wanted);
    const covers = relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
    if (!covers) {
      return {
        granted: null,
        code: 'path_consent_mismatch',
        chosen: chosen.folder,
        message: `${chosen.folder} does not contain ${wanted}. Choose that file's folder, or one above it.`,
        ...rootStore().describe()
      };
    }

    const outcome = rememberConsent(chosen.folder, { bookmark: chosen.bookmark });
    if (!outcome.added && outcome.reason) {
      return { granted: null, code: 'path_consent_refused', message: `That folder cannot be allowed: ${outcome.reason}.`, ...rootStore().describe() };
    }
    log.info('path_consent_granted', { path: wanted, folder: outcome.root });
    publishAgentSystemLog('INFO', 'Allowed folders', `You allowed ${outcome.root}.`);
    return { granted: outcome.root, code: null, ...rootStore().describe() };
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
    try {
      const existing = admittedPath(await fs.realpath(file));
      const existingStat = await fs.stat(existing);
      if (!existingStat.isFile()) throw new Error('The export destination is not a file.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    // Render beside the destination and publish it only after the writer has
    // closed successfully. Cancellation or an encoder failure can then remove
    // only this temporary file, never an older export or saved project.
    const temporary = admittedPath(path.join(realParent, `.${path.basename(file)}.${id}.sve-writing`));
    outputFiles.set(id, {
      handle: await fs.open(temporary, 'wx'), file, temporary, cursor: 0
    });
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
    try {
      await output.handle.sync();
      await output.handle.close();
      await fs.rename(output.temporary, output.file);
    } catch (error) {
      await output.handle.close().catch(() => {});
      error.details = {
        ...(error.details && typeof error.details === 'object' ? error.details : {}),
        destination: output.file,
        recoverableTemporaryFile: output.temporary
      };
      throw error;
    }
  });

  ipcMain.handle('agent:output-abort', async (event, id) => {
    if (!fromOurApp(event.sender)) throw new Error('File access was requested by an unknown page.');
    const output = outputFiles.get(id);
    if (!output) return;
    outputFiles.delete(id);
    await output.handle.close().catch(() => {});
    await fs.unlink(output.temporary).catch(() => {});
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

  await rememberEditorLocation(
    editorLocationFile(process.env.LOCALAPPDATA, app.getPath('userData')),
    {
      sourceRoot: path.resolve(__dirname, '..', '..'),
      executablePath: app.getPath('exe'),
      resourcesPath: process.resourcesPath
    }
  ).catch((error) => log.warn('editor_location_not_registered', { error: safeError(error) }));

  // The loopback server also owns private, range-enabled media URLs, including
  // in development where the UI itself is served by Angular's dev server. In
  // production its port is remembered, because localStorage and IndexedDB are
  // scoped to the complete origin and must survive an application restart.
  const originStateFile = path.join(app.getPath('userData'), 'loopback-origin.json');
  const wantedPort = DEV ? 0 : await preferredPort(originStateFile, `${app.getName()}:${app.getPath('userData')}`);
  server = await startServer(siteRoot(), { port: wantedPort, fallbackToRandom: true });
  if (!DEV) {
    await rememberPort(originStateFile, server.port);
    if (server.usedFallback) log.warn('loopback_port_changed', {
      preferredPort: wantedPort, actualPort: server.port,
      reason: 'preferred_port_in_use'
    });
  }
  origin = DEV ? DEV_URL : server.origin;

  wireWindowControls();
  wireAgentBridge();
  wirePermissions(require('electron').session.defaultSession);

  mediaImports = new MediaImportService({
    callEditor,
    registerMedia: (file, stat, type) => ({ filePath: file, name: path.basename(file), type, size: stat.size, lastModified: stat.mtimeMs, url: server.registerMedia(file, stat, type) }),
    admit: (candidate) => admittedPath(candidate),
    stateFile: path.join(app.getPath('userData'), 'mcp-import-jobs.json'),
    checkpoint: (reason) => checkpointProject(reason)
  });
  await restoreConsent().catch((error) => log.warn('roots_restore_failed', { error }));
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
  for (const output of outputFiles.values()) {
    await output.handle.close().catch(() => {});
    await fs.unlink(output.temporary).catch(() => {});
  }
  outputFiles.clear();
  if (bridgeServer) await new Promise((done) => bridgeServer.close(() => done())).catch(() => {});
  if (server) await server.close();
});

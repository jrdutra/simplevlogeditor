/**
 * The only thing the page is given.
 *
 * The renderer runs the site, and the site is a web page: it gets no Node, no
 * file system and no `ipcRenderer`. It gets four verbs about its own window, a
 * way to be told when that window's state changes, and one more that asks the
 * application to hand the page a user gesture — nothing that would let a bug on
 * the page reach the machine.
 *
 * `window.desktop` being present is also how the site knows it is not in a
 * browser tab, which is what turns the title bar's decorative lights into
 * working ones.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const CHANNEL = 'window:state';
let agentHandler = null;
let rootStateHandler = null;
let agentCancelHandler = null;
let beforeCloseHandler = null;

ipcRenderer.on('agent:command', async (_event, envelope) => {
  if (!agentHandler) {
    ipcRenderer.send('agent:response', { id: envelope.id, error: { message: 'The video editor route is not ready.' } });
    return;
  }
  try {
    let answered = false;
    agentHandler(envelope.request, (response) => {
      if (answered) return;
      answered = true;
      ipcRenderer.send('agent:response', { id: envelope.id, ...response });
    });
  } catch (error) {
    ipcRenderer.send('agent:response', {
      id: envelope.id,
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === 'object' && 'code' in error ? error.code : 'editor_error',
        details: error && typeof error === 'object' && 'details' in error ? error.details : undefined
      }
    });
  }
});

ipcRenderer.on('agent:cancel', (_event, envelope) => {
  agentCancelHandler?.(envelope?.operationId);
});

ipcRenderer.on('roots:state', (_event, state) => {
  rootStateHandler?.(state);
});

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  shortCommand: (name, args) => ipcRenderer.invoke('short:command', name, args),
  chooseShortOutput: (name) => ipcRenderer.invoke('short:choose-output', name),

  minimize: () => ipcRenderer.send('window:minimize'),
  focus: () => ipcRenderer.send('window:focus'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: async () => {
    try { await beforeCloseHandler?.(); }
    finally { ipcRenderer.send('window:close'); }
  },

  /** The state right now, for the first paint. */
  getState: () => ipcRenderer.invoke('window:state'),

  /** Every state change from here on. Returns the unsubscribe. */
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANNEL, handler);
  },

  onAgentControlState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('agent:control-state', handler);
    return () => ipcRenderer.removeListener('agent:control-state', handler);
  },

  onAgentSystemEvent: (listener) => {
    const handler = (_event, entry) => listener(entry);
    ipcRenderer.on('agent:system-log', handler);
    return () => ipcRenderer.removeListener('agent:system-log', handler);
  },

  getAgentRuntimeInfo: () => ipcRenderer.invoke('agent:runtime-info'),

  /** Autosave the renderer's complete edit to Electron's fixed recovery file. */
  checkpointProject: (payload) => ipcRenderer.invoke('project:checkpoint', payload),
  clearProjectCheckpoint: (payload) => ipcRenderer.invoke('project:checkpoint-clear', payload),
  /** "Clear all": every recovery checkpoint and AI temporary the editor ever left. */
  purgeProjectRecovery: (payload) => ipcRenderer.invoke('project:recovery-purge', payload),
  registerBeforeCloseHandler: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('The close handler must be a function.');
    beforeCloseHandler = handler;
    return () => { if (beforeCloseHandler === handler) beforeCloseHandler = null; };
  },

  /**
   * Asks the application to reopen the project's files.
   *
   * The page already knows how — it kept a durable reference to every file the
   * reader added — and the one thing standing between it and doing so on its
   * own is that reopening asks for permission, and a permission may only be
   * asked for while a person is pressing something. In a browser that is the
   * reader clicking a button. Here there is nobody to click: the window has
   * just opened by itself, which is precisely when the project should come back.
   *
   * So the page asks the application, and the application calls the page back
   * with a gesture behind the call. The permission is then granted without a
   * dialog, because in this window the application is the one who answers.
   */
  reconnectFiles: () => ipcRenderer.invoke('files:reconnect')
  ,

  registerAgentHandler: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('The agent handler must be a function.');
    agentHandler = handler;
    ipcRenderer.send('agent:ready');
    return () => {
      if (agentHandler === handler) agentHandler = null;
    };
  },

  registerAgentCancelHandler: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('The cancellation handler must be a function.');
    agentCancelHandler = handler;
    return () => { if (agentCancelHandler === handler) agentCancelHandler = null; };
  },
  reportAgentProgress: (progress) => ipcRenderer.send('agent:progress', progress),

  readAgentFiles: (paths) => ipcRenderer.invoke('agent:read-files', paths),
  ensureAgentFolder: (path) => ipcRenderer.invoke('agent:output-folder', path),
  openAgentOutput: (path) => ipcRenderer.invoke('agent:output-open', path),
  writeAgentOutput: (id, position, data) => ipcRenderer.invoke('agent:output-write', id, position, data),
  closeAgentOutput: (id) => ipcRenderer.invoke('agent:output-close', id),
  abortAgentOutput: (id) => ipcRenderer.invoke('agent:output-abort', id),

  /*
   * Choosing a file in this window is the user saying which folder the editor
   * may work in. The page sees a `File`, which in Electron carries no path, so
   * the application is asked to name it — and it is named only for files the
   * user themselves put into the window, through a picker or a drop.
   *
   * This is the narrowest widening of this bridge that lets a choice in the
   * window mean the same thing as a choice in a permission dialog. It hands
   * back a path; it grants nothing on its own. `rememberFolders` is what asks
   * for the grant, and the application still applies the denylist to it.
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; }
    catch { return null; }
  },
  rememberFolders: (paths) => ipcRenderer.invoke('roots:remember', paths),
  ensureRoots: (paths) => ipcRenderer.invoke('roots:ensure', paths),
  listRoots: () => ipcRenderer.invoke('roots:list'),
  addRoot: (purpose) => ipcRenderer.invoke('roots:add', purpose === 'packaging' ? 'packaging' : undefined),
  removeRoot: (folder) => ipcRenderer.invoke('roots:remove', folder),
  requestRootConsent: (request) => ipcRenderer.invoke('roots:request-consent', request),
  onRootState: (handler) => {
    rootStateHandler = typeof handler === 'function' ? handler : null;
    return () => { if (rootStateHandler === handler) rootStateHandler = null; };
  }
});

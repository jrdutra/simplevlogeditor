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

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'window:state';
let agentHandler = null;
let agentCancelHandler = null;

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

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,

  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),

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
  openAgentOutput: (path) => ipcRenderer.invoke('agent:output-open', path),
  writeAgentOutput: (id, position, data) => ipcRenderer.invoke('agent:output-write', id, position, data),
  closeAgentOutput: (id) => ipcRenderer.invoke('agent:output-close', id),
  abortAgentOutput: (id) => ipcRenderer.invoke('agent:output-abort', id)
});

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
});

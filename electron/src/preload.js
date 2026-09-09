/**
 * The only thing the page is given.
 *
 * The renderer runs the site, and the site is a web page: it gets no Node, no
 * file system and no `ipcRenderer`. It gets four verbs about its own window and
 * a way to be told when that window's state changes — nothing that would let a
 * bug on the page reach the machine.
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
  }
});

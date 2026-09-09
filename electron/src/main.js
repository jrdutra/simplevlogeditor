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

const { startServer } = require('./server');
const { restoreState, trackWindow } = require('./window-state');

/**
 * Below this the console stops being one.
 *
 * The tab strip, the tool's own panels and the timeline all need a width before
 * they start wrapping into something unusable, and a window that can be dragged
 * down to a postage stamp is a window someone will lose the editor inside.
 */
const MINIMUM = { width: 960, height: 640 };

const DEV = process.argv.includes('--dev');
const DEV_URL = process.env.SVE_DEV_URL || 'http://localhost:4200';

/** Where the built site is: beside the sources in development, packed in beside the app once shipped. */
function siteRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'site')
    : path.join(__dirname, '..', '..', 'web', 'dist', 'browser');
}

let server = null;
let origin = null;

/* One instance. A second launch raises the window that already exists rather
   than opening a second copy with its own loopback server. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
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

  window.loadURL(DEV ? DEV_URL : origin);
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
  const ALLOWED = new Set(['media', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'pointerLock']);

  session.setPermissionRequestHandler((contents, permission, callback) => {
    const url = contents.getURL();
    const ours = url.startsWith(origin) || (DEV && url.startsWith(DEV_URL));
    callback(ours && ALLOWED.has(permission));
  });

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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  if (!DEV) {
    server = await startServer(siteRoot());
    origin = server.origin;
  } else {
    origin = DEV_URL;
  }

  wireWindowControls();
  wirePermissions(require('electron').session.defaultSession);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', async () => {
  if (server) await server.close();
});

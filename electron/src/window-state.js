/**
 * Remembering where the window was.
 *
 * A window that opens in the middle of the screen at the same size every time
 * is a window that has to be arranged again every time. What is kept is the
 * frame and whether it was maximized — nothing about the work, which the site
 * already saves for itself.
 *
 * The saved frame is checked against the displays that exist *now*: a window
 * restored onto a monitor that has since been unplugged is a window nobody can
 * reach, so a frame that no longer overlaps any screen is thrown away.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { width: 1280, height: 820 };

function file(app) {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function read(app) {
  try {
    const saved = JSON.parse(fs.readFileSync(file(app), 'utf8'));
    const usable =
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height) &&
      saved.width > 0 &&
      saved.height > 0;
    return usable ? saved : null;
  } catch {
    return null;
  }
}

function onSomeScreen(screen, bounds) {
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;

  return screen.getAllDisplays().some(({ workArea }) => {
    const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
    const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
    // A sliver is not enough: the title bar has to be grabbable.
    return overlapX > 120 && overlapY > 60;
  });
}

/** The options to open with, merged into whatever else the window wants. */
function restoreState(app, screen, minimum) {
  const saved = read(app);
  if (!saved) return { ...DEFAULTS, maximized: false };

  const bounds = {
    width: Math.max(saved.width, minimum.width),
    height: Math.max(saved.height, minimum.height),
    x: saved.x,
    y: saved.y
  };

  if (!onSomeScreen(screen, bounds)) {
    return { width: bounds.width, height: bounds.height, maximized: !!saved.maximized };
  }

  return { ...bounds, maximized: !!saved.maximized };
}

/**
 * Follows a window and writes its frame down.
 *
 * `getNormalBounds` rather than `getBounds`, so a window closed while maximized
 * still remembers the size to return to when it is unmaximized later.
 */
function trackWindow(app, window) {
  let timer = null;

  const save = () => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    const state = { ...bounds, maximized: window.isMaximized() };
    try {
      fs.mkdirSync(path.dirname(file(app)), { recursive: true });
      fs.writeFileSync(file(app), JSON.stringify(state, null, 2));
    } catch {
      // A window position is not worth an error dialog.
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
  };

  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('maximize', schedule);
  window.on('unmaximize', schedule);
  window.once('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

module.exports = { restoreState, trackWindow, DEFAULTS };

'use strict';

/**
 * Which folders the editor may touch, and why.
 *
 * This used to be one line: `SVE_MCP_ROOTS` or the working directory. That is
 * wrong for a graphical application. A window opened from the Start menu, from
 * a desktop shortcut, or by an MCP client inherits whatever working directory
 * its launcher happened to have — `C:\WINDOWS\System32` is the common one — and
 * rooting file access there refuses every real media path while reading like a
 * broken permission. The working directory is not evidence of anything the user
 * intended, so it is not used at all.
 *
 * What replaces it is four layers, in this order of precedence:
 *
 *   env         SVE_MCP_ROOTS. An advanced override: when it is set, the
 *               default media folders are NOT added, so an administrator can
 *               pin an exact set. Consent still applies on top, because a user
 *               who clicks "allow" must always be obeyed.
 *   mcp-client  Folders the MCP client reported through roots/list — what the
 *               user connected in their Claude session.
 *   consent     Folders the user chose themselves, in this app, through a file
 *               or folder picker. Persisted in roots.json.
 *   defaults    The user's own media folders, from Electron. Used when no
 *               override is present, so the app works on first launch with no
 *               configuration at all.
 *
 * Above all four sits a denylist that no layer can override, not even the
 * environment variable: operating-system locations, program directories, other
 * applications' data, and bare drive roots.
 *
 * Every helper takes its platform explicitly and uses that platform's path
 * rules, so Windows behaviour is provable from a test run on any machine.
 */

const fs = require('node:fs');
const nodePath = require('node:path');

/** Precedence, strongest first. Also the order the notice reads them in. */
const LAYERS = ['env', 'mcp-client', 'consent', 'defaults'];

/** The Electron path names that make up the default layer. */
const DEFAULT_PATH_NAMES = ['videos', 'pictures', 'music', 'downloads', 'desktop', 'documents'];

function pathFor(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function inside(impl, parent, child) {
  const relative = impl.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${impl.sep}`) && !impl.isAbsolute(relative));
}

/**
 * Locations no edit ever legitimately reads from or writes to. Kept as
 * prefixes: anything at or below one of these is refused.
 */
function denyList(platform, env = process.env) {
  if (platform !== 'win32') {
    return ['/bin', '/sbin', '/usr', '/etc', '/var', '/opt', '/boot', '/dev', '/proc', '/sys',
      '/System', '/Library', '/Applications', '/private/var'];
  }
  return [
    env.SystemRoot, env.windir, env.ProgramData, env.ProgramFiles, env['ProgramFiles(x86)'],
    'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData',
    'C:\\$Recycle.Bin', 'C:\\System Volume Information',
    // Other applications' data. The editor's own folders under these are
    // re-admitted explicitly by `allowances`, because the recovery checkpoint
    // and roots.json live there.
    env.APPDATA, env.LOCALAPPDATA
  ].filter(Boolean);
}

/**
 * @param {string} candidate absolute path, already resolved
 * @param {{platform?: string, env?: object, allowances?: string[]}} options
 *   `allowances` are paths that survive the denylist — the editor's own
 *   application-data folders, which sit inside AppData by design.
 */
function deniedRoot(candidate, options = {}) {
  const platform = options.platform || process.platform;
  const impl = pathFor(platform);
  if (typeof candidate !== 'string' || !candidate.trim()) return 'a path is required';
  const resolved = impl.resolve(candidate);
  if (impl.dirname(resolved) === resolved) return 'it is a drive or filesystem root';
  // Refused before the allowances are consulted: nothing re-admits these.
  for (const entry of options.denied || []) {
    if (entry && inside(impl, impl.resolve(entry), resolved)) return `it is inside the editor's own program folder, ${impl.resolve(entry)}`;
  }
  for (const allowed of options.allowances || []) {
    if (allowed && inside(impl, impl.resolve(allowed), resolved)) return null;
  }
  for (const entry of denyList(platform, options.env || process.env)) {
    if (inside(impl, impl.resolve(entry), resolved)) return `it is inside ${impl.resolve(entry)}`;
  }
  return null;
}

/** The checkout that contains `electron` and `web`, or null once packaged. */
function editorProjectRoot(fromDirectory = __dirname) {
  const candidate = nodePath.resolve(fromDirectory, '..', '..');
  const marker = nodePath.join(candidate, 'electron', 'src', 'mcp-host.js');
  try { return fs.existsSync(marker) ? candidate : null; }
  catch { return null; }
}

function splitRoots(value, platform = process.platform) {
  const impl = pathFor(platform);
  return String(value || '')
    .split(impl.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => impl.resolve(entry));
}

/**
 * The user's own media folders, asked of Electron rather than guessed, plus
 * the editor's project folder when running from a checkout. Each lookup is
 * guarded: `app.getPath` throws for a folder the platform does not define.
 */
function defaultRoots(options = {}) {
  const getPath = options.getPath || (() => null);
  const platform = options.platform || process.platform;
  const impl = pathFor(platform);
  const found = [];
  for (const name of DEFAULT_PATH_NAMES) {
    let value = null;
    try { value = getPath(name); } catch { value = null; }
    if (typeof value === 'string' && value.trim()) found.push(impl.resolve(value));
  }
  const projectRoot = options.projectRoot === undefined ? editorProjectRoot() : options.projectRoot;
  if (projectRoot) found.push(impl.resolve(projectRoot));
  return found;
}

/**
 * The live set of roots, assembled from the four layers and consulted by both
 * the graphical editor and the MCP server. One instance per Electron process;
 * mutating a layer takes effect on the next call, with no restart, which is
 * what lets the settings screen and the consent dialog work.
 */
class RootStore {
  /**
   * @param {{platform?: string, env?: object, getPath?: (name: string) => string,
   *          projectRoot?: string|null, allowances?: string[], denied?: string[],
   *          onChange?: Function}} options
   */
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.impl = pathFor(this.platform);
    this.allowances = (options.allowances || []).filter(Boolean).map((entry) => this.impl.resolve(entry));
    /**
     * Extra refusals on top of the denylist — the running program's own
     * folder. A plugin unpacked under Downloads carries the whole editor with
     * it, and Downloads is allowed by default; its runtime is not media.
     */
    this.denied = (options.denied || []).filter(Boolean).map((entry) => this.impl.resolve(entry));
    this.listeners = new Set();
    if (options.onChange) this.listeners.add(options.onChange);

    // Set before any layer is cleaned: #clean records refusals into it.
    this.refusedByPolicy = [];
    this.layers = new Map(LAYERS.map((name) => [name, []]));
    this.layers.set('env', this.#clean(splitRoots(this.env.SVE_MCP_ROOTS, this.platform)));
    this.layers.set('defaults', this.#clean(defaultRoots({
      getPath: options.getPath, platform: this.platform, projectRoot: options.projectRoot
    })));
  }

  #clean(candidates) {
    const kept = [];
    for (const candidate of candidates) {
      const resolved = this.impl.resolve(candidate);
      const reason = deniedRoot(resolved, { platform: this.platform, env: this.env, allowances: this.allowances, denied: this.denied });
      if (reason) {
        this.refusedByPolicy = [...new Set([...(this.refusedByPolicy || []), `${resolved} (${reason})`])];
        continue;
      }
      if (!kept.some((entry) => this.#same(entry, resolved))) kept.push(resolved);
    }
    return kept;
  }

  #same(a, b) {
    return this.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  }

  #announce() {
    for (const listener of this.listeners) {
      try { listener(this.describe()); } catch { /* a listener must not break a path check */ }
    }
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replace one layer wholesale. Returns true when the effective set changed. */
  setLayer(name, candidates) {
    if (!this.layers.has(name)) throw new Error(`Unknown root layer: ${name}`);
    const before = this.roots().join('\u0000');
    this.layers.set(name, this.#clean(candidates || []));
    const changed = this.roots().join('\u0000') !== before;
    if (changed) this.#announce();
    return changed;
  }

  /**
   * Add one folder to a layer. Returns `{ added, root, reason }` — `added`
   * false with a reason when policy refuses it, which the consent dialog
   * shows to the user rather than silently dropping.
   */
  add(candidate, layer = 'consent') {
    if (!this.layers.has(layer)) throw new Error(`Unknown root layer: ${layer}`);
    const resolved = this.impl.resolve(String(candidate || ''));
    const reason = deniedRoot(resolved, { platform: this.platform, env: this.env, allowances: this.allowances, denied: this.denied });
    if (reason) return { added: false, root: resolved, reason };
    const current = this.layers.get(layer);
    if (current.some((entry) => this.#same(entry, resolved))) return { added: false, root: resolved, reason: null };
    this.layers.set(layer, [...current, resolved]);
    this.#announce();
    return { added: true, root: resolved, reason: null };
  }

  /** Remove one folder from every layer it appears in. */
  remove(candidate) {
    const resolved = this.impl.resolve(String(candidate || ''));
    let removed = false;
    for (const [name, entries] of this.layers) {
      const kept = entries.filter((entry) => !this.#same(entry, resolved));
      if (kept.length !== entries.length) { this.layers.set(name, kept); removed = true; }
    }
    if (removed) this.#announce();
    return removed;
  }

  /**
   * The layers actually in force. `SVE_MCP_ROOTS` is an override, so when it is
   * set the defaults stand down and an administrator's pinned list is exactly
   * what it says. Consent is never dropped: a user who clicked "allow" in this
   * app must be obeyed whatever the environment says.
   */
  #activeLayers() {
    return this.overridden ? LAYERS.filter((name) => name !== 'defaults') : LAYERS;
  }

  /** Every root once, strongest layer first. */
  roots() {
    const seen = [];
    for (const name of this.#activeLayers()) {
      for (const entry of this.layers.get(name)) {
        if (!seen.some((kept) => this.#same(kept, entry))) seen.push(entry);
      }
    }
    return seen;
  }

  /** Each root with the strongest layer that contributed it. */
  entries() {
    const seen = [];
    for (const name of this.#activeLayers()) {
      for (const root of this.layers.get(name)) {
        if (!seen.some((kept) => this.#same(kept.path, root))) seen.push({ path: root, source: name });
      }
    }
    return seen;
  }

  /** The strongest layer that contributed anything, for a one-word answer. */
  get source() {
    for (const name of this.#activeLayers()) if (this.layers.get(name).length) return name;
    return 'none';
  }

  /** True when the environment override is in force and the defaults stand down. */
  get overridden() {
    return this.layers.get('env').length > 0;
  }

  /** Whether one already-resolved absolute path sits inside an admitted root. */
  admits(candidate) {
    if (typeof candidate !== 'string' || !candidate.trim()) return false;
    const resolved = this.impl.resolve(candidate);
    // A denied folder inside an allowed one stays denied.
    if (this.denied.some((entry) => inside(this.impl, entry, resolved))) return false;
    return this.roots().some((root) => inside(this.impl, root, resolved));
  }

  /**
   * The single check every file path passes, from the editor window and from
   * MCP alike. Returns the resolved path, or throws with `code` and the
   * `details` the consent flow needs to ask for the right folder.
   */
  admit(candidate, options = {}) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw Object.assign(new Error('A non-empty file path is required.'), { code: 'path_required' });
    }
    const resolved = this.impl.resolve(candidate);
    for (const allowed of options.allowances || []) {
      if (allowed && inside(this.impl, this.impl.resolve(allowed), resolved)) return resolved;
    }
    if (this.admits(resolved)) return resolved;
    const parent = this.impl.dirname(resolved);
    throw Object.assign(
      new Error(`The editor has not been allowed to use this folder: ${resolved}. ${this.notice()}`),
      {
        code: 'path_not_allowed',
        details: { path: resolved, folder: parent, roots: this.roots(), rootSource: this.source, consentable: true }
      }
    );
  }

  /** One English sentence, for logs, diagnostics and the refusal message. */
  notice() {
    const roots = this.roots();
    if (!roots.length) {
      return 'No folder is currently allowed. Add one from Allowed folders in the editor settings, '
        + 'or choose a file through the editor to allow its folder.';
    }
    const where = this.overridden
      ? 'SVE_MCP_ROOTS is set, so the default media folders stand down'
      : 'These are the default media folders plus anything you have allowed';
    return `${where}. Allowed: ${roots.join(this.impl.delimiter)}.`;
  }

  /** The shape reported by get_diagnostics, health_check and the settings screen. */
  describe() {
    return {
      roots: this.roots(),
      entries: this.entries(),
      rootSource: this.source,
      overridden: this.overridden,
      refusedByPolicy: this.refusedByPolicy,
      rootNotice: this.notice()
    };
  }
}

module.exports = {
  RootStore, LAYERS, DEFAULT_PATH_NAMES,
  deniedRoot, denyList, defaultRoots, editorProjectRoot, splitRoots
};

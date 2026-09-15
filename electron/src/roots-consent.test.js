'use strict';

/**
 * The three things that must stay true, written as the user described them.
 *
 * These are deliberately end-to-end within the Node half: a real RootStore, a
 * real roots.json, and a real MediaImportService. The Electron dialog is the
 * one part that cannot run here, so what is tested is everything either side
 * of it — what is asked for, and what is remembered once the answer comes back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { RootStore } = require('./mcp-roots');
const { readRoots, writeRoots } = require('./roots-store-file');
const { MediaImportService } = require('./media-import-service');

const win = path.win32;
const HOME = 'C:\\Users\\joaor';
const MEDIA = {
  videos: `${HOME}\\Videos`, pictures: `${HOME}\\Pictures`, music: `${HOME}\\Music`,
  downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`
};
const WINDOWS_ENV = {
  SystemRoot: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: `${HOME}\\AppData\\Local`, APPDATA: `${HOME}\\AppData\\Roaming`
};

function windowsStore(overrides = {}) {
  return new RootStore({
    platform: 'win32',
    env: { ...WINDOWS_ENV, ...(overrides.env || {}) },
    getPath: (name) => MEDIA[name],
    projectRoot: `${HOME}\\ferramentas\\simplevlogeditor`,
    allowances: [`${WINDOWS_ENV.LOCALAPPDATA}\\SimpleVlogEditor`]
  });
}

/* ------------------------------------------------ launched from System32 */

test('launched from System32, the editor still reaches the user Videos folder', () => {
  // The scenario that caused all of this: an MCP client started from the Start
  // menu hands the editor C:\WINDOWS\System32 as its working directory.
  const previous = process.cwd();
  const store = windowsStore();
  assert.equal(process.cwd(), previous, 'resolving roots must not depend on, or change, the working directory');

  const roots = store.roots();
  assert.ok(roots.includes(win.resolve(MEDIA.videos)));
  assert.ok(!roots.some((root) => /System32/i.test(root)));
  assert.doesNotThrow(() => store.admit(`${MEDIA.videos}\\2026-09\\fonte\\DJI_0670.MP4`));
});

test('no source file consults the working directory for a root any more', () => {
  // A guard, not a formality: the whole defect was one `|| process.cwd()`, and
  // it would read as harmless again in a future edit.
  for (const file of ['mcp-roots.js', 'main.js', 'editor-process-manager.js', 'media-import-service.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!/process\.cwd\(\)/.test(source), `${file} must not resolve roots from the working directory`);
  }
});

test('System32 is refused even when someone points the variable at it', () => {
  const store = windowsStore({ env: { SVE_MCP_ROOTS: `C:\\WINDOWS\\System32${win.delimiter}D:\\Work` } });
  assert.deepEqual(store.roots(), [win.resolve('D:\\Work')]);
});

/* ------------------------------------------------------- the consent flow */

test('declining leaves nothing behind, and allowing survives a restart', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sve-consent-'));
  const file = path.join(dir, 'roots.json');
  const wanted = path.join(dir, 'Elsewhere', 'clip.mp4');

  // A first run, with nothing granted.
  const first = new RootStore({ getPath: () => null, projectRoot: null });
  assert.equal(first.admits(wanted), false);
  const refusal = (() => { try { first.admit(wanted); } catch (error) { return error; } })();
  assert.equal(refusal.code, 'path_not_allowed');
  assert.equal(refusal.details.folder, path.dirname(wanted));

  // The user closes the picker. Nothing is written, and nothing is reachable.
  assert.deepEqual((await readRoots(file)).roots, []);
  assert.equal(first.admits(wanted), false);

  // The user picks the folder. The grant is stored the way main.js stores it.
  const granted = first.add(path.dirname(wanted), 'consent');
  assert.equal(granted.added, true);
  await writeRoots(file, [{ path: granted.root }]);
  assert.equal(first.admits(wanted), true);

  // The editor restarts: a brand-new store, told nothing but what was written.
  const second = new RootStore({ getPath: () => null, projectRoot: null });
  assert.equal(second.admits(wanted), false, 'a fresh store starts with nothing');
  for (const entry of (await readRoots(file)).roots) second.add(entry.path, 'consent');
  assert.equal(second.admits(wanted), true, 'the grant must survive the restart');
  assert.equal(second.entries().find((entry) => entry.path === granted.root).source, 'consent');
});

test('a stored grant that policy now refuses is dropped rather than honoured', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sve-consent-'));
  const file = path.join(dir, 'roots.json');
  await writeRoots(file, [{ path: path.resolve('/usr/lib') }, { path: path.join(dir, 'Fine') }]);

  const store = new RootStore({ platform: 'linux', env: {}, getPath: () => null, projectRoot: null });
  const kept = [];
  for (const entry of (await readRoots(file)).roots) {
    if (store.add(entry.path, 'consent').added) kept.push(entry.path);
  }
  assert.deepEqual(kept, [path.join(dir, 'Fine')]);
});

/* ------------------------------ one list for the window and for the agent */

test('a folder allowed through the window is immediately importable through MCP', async () => {
  // The asymmetry this replaces: media imports used their own copy of the rule,
  // so a folder could be reachable through one door and refused through the
  // other. They now share one admit().
  const store = new RootStore({ getPath: () => null, projectRoot: null });
  const admit = (candidate) => store.admit(candidate);

  const folder = path.resolve('/tmp/sve-shared-list');
  const media = path.join(folder, 'take.mp4');

  const service = new MediaImportService({
    admit,
    callEditor: async () => ({ apiVersion: 2, projectRevision: 1, result: {} }),
    registerMedia: () => ({}),
    fs: {
      realpath: async (value) => value,
      stat: async () => ({ isFile: () => true, size: 10, mtimeMs: 0 }),
      open: async () => ({ close: async () => {} })
    }
  });

  assert.throws(() => admit(media), (error) => error.code === 'path_not_allowed');
  assert.equal(service.admit === admit, true, 'the import service must hold the same function, not a copy of the rule');

  // The user chooses the folder in the editor window.
  store.add(folder, 'consent');

  assert.doesNotThrow(() => admit(media));
  assert.doesNotThrow(() => service.admit(media), 'the same choice must reach the import path');
});

test('the import service has no path rule of its own left to drift', () => {
  const source = fs.readFileSync(path.join(__dirname, 'media-import-service.js'), 'utf8');
  assert.ok(!/function withinRoots/.test(source), 'the second copy of the rule must stay gone');
  assert.ok(/this\.admit\(/.test(source), 'it must call the shared check');
});

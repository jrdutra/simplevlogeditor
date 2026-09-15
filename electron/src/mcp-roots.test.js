'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { RootStore, deniedRoot, defaultRoots, splitRoots } = require('./mcp-roots');

const win = path.win32;
const WINDOWS_ENV = {
  SystemRoot: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files',
  ProgramData: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\joaor\\AppData\\Local',
  APPDATA: 'C:\\Users\\joaor\\AppData\\Roaming'
};
const HOME = 'C:\\Users\\joaor';
const MEDIA = {
  videos: `${HOME}\\Videos`, pictures: `${HOME}\\Pictures`, music: `${HOME}\\Music`,
  downloads: `${HOME}\\Downloads`, desktop: `${HOME}\\Desktop`, documents: `${HOME}\\Documents`
};
const OWN_DATA = 'C:\\Users\\joaor\\AppData\\Local\\SimpleVlogEditor';

function store(options = {}) {
  return new RootStore({
    platform: 'win32',
    env: { ...WINDOWS_ENV, ...(options.env || {}) },
    getPath: (name) => MEDIA[name],
    projectRoot: options.projectRoot === undefined ? 'C:\\Users\\joaor\\ferramentas\\simplevlogeditor' : options.projectRoot,
    allowances: options.allowances === undefined ? [OWN_DATA] : options.allowances
  });
}

test('launched from System32, the user media folders are the roots and System32 is not', () => {
  // The working directory is not consulted at all now, so the launcher's cwd
  // cannot reach the result. This is the regression the whole change exists for.
  const roots = store().roots();
  assert.ok(roots.includes(win.resolve(MEDIA.videos)), 'the Videos folder must be reachable');
  assert.ok(roots.some((root) => /simplevlogeditor$/i.test(root)), 'the editor project must be reachable');
  assert.ok(!roots.some((root) => /System32/i.test(root)), 'System32 must never be a root');
  assert.ok(!roots.some((root) => /^C:\\WINDOWS/i.test(root)), 'nothing under Windows may be a root');
});

test('a media path under Videos is admitted without any configuration', () => {
  const admitted = store().admit(`${MEDIA.videos}\\vlog\\fonte\\DJI_0670.MP4`);
  assert.equal(admitted, win.resolve(`${MEDIA.videos}\\vlog\\fonte\\DJI_0670.MP4`));
});

test('SVE_MCP_ROOTS overrides the defaults rather than adding to them', () => {
  const pinned = store({ env: { SVE_MCP_ROOTS: `D:\\Only${win.delimiter}E:\\Also` } });
  assert.deepEqual(pinned.roots(), [win.resolve('D:\\Only'), win.resolve('E:\\Also')]);
  assert.equal(pinned.source, 'env');
  assert.equal(pinned.overridden, true);
  assert.throws(() => pinned.admit(`${MEDIA.videos}\\a.mp4`), (error) => error.code === 'path_not_allowed');
});

test('consent still applies on top of the environment override', () => {
  const pinned = store({ env: { SVE_MCP_ROOTS: 'D:\\Only' } });
  assert.equal(pinned.add(`${MEDIA.videos}`, 'consent').added, true);
  assert.equal(pinned.admits(`${MEDIA.videos}\\a.mp4`), true);
  // Precedence is about which layer is reported, not about silencing consent.
  assert.equal(pinned.entries().find((entry) => /Videos$/i.test(entry.path)).source, 'consent');
});

test('the denylist refuses system locations from every layer, including the variable', () => {
  const pinned = store({ env: { SVE_MCP_ROOTS: `C:\\WINDOWS\\System32${win.delimiter}${MEDIA.videos}` } });
  assert.deepEqual(pinned.roots(), [win.resolve(MEDIA.videos)]);
  assert.ok(pinned.refusedByPolicy.some((entry) => /System32/i.test(entry)));
  assert.equal(pinned.add('C:\\Program Files\\Thing', 'consent').added, false);
  assert.match(pinned.add('C:\\', 'consent').reason, /drive or filesystem root/);
  assert.match(pinned.add('C:\\Users\\joaor\\AppData\\Roaming\\OtherApp', 'consent').reason, /AppData\\Roaming/i);
});

test("the editor's own application data survives the denylist", () => {
  // roots.json and the recovery checkpoint live inside AppData by design.
  assert.equal(deniedRoot(`${OWN_DATA}\\roots.json`, { platform: 'win32', env: WINDOWS_ENV, allowances: [OWN_DATA] }), null);
  assert.ok(deniedRoot(`${OWN_DATA}\\roots.json`, { platform: 'win32', env: WINDOWS_ENV }));
});

test('precedence orders the roots and names each one origin', () => {
  const s = store();
  s.setLayer('mcp-client', ['D:\\Session']);
  s.add('E:\\Chosen', 'consent');
  const entries = s.entries();
  assert.deepEqual(entries.slice(0, 2).map((entry) => entry.source), ['mcp-client', 'consent']);
  assert.equal(entries.at(-1).source, 'defaults');
  assert.equal(s.source, 'mcp-client');
});

test('adding and removing take effect immediately and notify listeners', () => {
  const seen = [];
  const s = store();
  s.onChange((state) => seen.push(state.roots.length));
  assert.equal(s.admits('E:\\New\\clip.mp4'), false);
  s.add('E:\\New', 'consent');
  assert.equal(s.admits('E:\\New\\clip.mp4'), true);
  s.remove('E:\\New');
  assert.equal(s.admits('E:\\New\\clip.mp4'), false);
  assert.deepEqual(seen.length, 2);
});

test('a refusal carries the folder to ask for, so the caller can request consent', () => {
  const s = store();
  const error = (() => { try { s.admit('E:\\Elsewhere\\clip.mp4'); } catch (e) { return e; } })();
  assert.equal(error.code, 'path_not_allowed');
  assert.equal(error.details.folder, win.resolve('E:\\Elsewhere'));
  assert.equal(error.details.consentable, true);
  assert.match(error.message, /has not been allowed/);
});

test('duplicates collapse case-insensitively on Windows', () => {
  const s = store();
  s.add('E:\\One', 'consent');
  s.add('e:\\ONE', 'consent');
  assert.equal(s.roots().filter((root) => /one$/i.test(root)).length, 1);
});

test('defaultRoots tolerates a platform that does not define a folder', () => {
  const found = defaultRoots({
    platform: 'win32', projectRoot: null,
    getPath: (name) => { if (name === 'music') throw new Error('no music folder'); return MEDIA[name] ?? null; }
  });
  assert.ok(!found.some((entry) => /Music$/i.test(entry)));
  assert.ok(found.some((entry) => /Videos$/i.test(entry)));
});

test('splitRoots drops blanks instead of resolving them to the process directory', () => {
  assert.deepEqual(splitRoots(`  ${win.delimiter}C:\\Videos${win.delimiter} `, 'win32'), [win.resolve('C:\\Videos')]);
});

test('posix system locations are refused too', () => {
  assert.ok(deniedRoot('/usr/local/share', { platform: 'linux', env: {} }));
  assert.ok(deniedRoot('/', { platform: 'linux', env: {} }));
  assert.equal(deniedRoot('/home/me/videos', { platform: 'linux', env: {} }), null);
});

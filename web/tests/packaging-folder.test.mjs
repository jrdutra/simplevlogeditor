import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const app = new URL('../src/app/', import.meta.url);
const compile = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText).toString('base64');
const paths = await import(compile(fs.readFileSync(new URL('shared/desktop/path-backed-file.ts', app), 'utf8')));
const folders = await import(compile(fs.readFileSync(new URL('ferramentas/video-packaging/packaging-paths.ts', app), 'utf8')));

// Execute the real folder methods, isolated from Angular/media decoders. No
// native picker is opened and no actual project or media is modified here.
const source = fs.readFileSync(new URL('ferramentas/editor-de-video/editor-de-video.component.ts', app), 'utf8');
const ast = ts.createSourceFile('editor.ts', source, ts.ScriptTarget.Latest, true);
const editor = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'EditorDeVideoComponent');
const methods = ['packagingFolder', 'ensurePackagingFolder'].map(name => {
  const method = editor.members.find(member => member.name?.getText(ast) === name);
  assert.ok(method, name);
  return method.getText(ast);
}).join('\n');
const fixtureModule = await import(compile(`export function build(deps) {
  const { pathBackedPath, packagingFolderFor, joinPath, EditorAgentError } = deps;
  const isMediaClip = clip => clip.kind === 'media';
  return class { ${methods} };
}`));
class EditorAgentError extends Error { constructor(message, code) { super(message); this.code = code; } }
const Fixture = fixtureModule.build({ ...paths, ...folders, EditorAgentError });
function fixture(clips, choice = { granted: 'C:\\Output', cancelled: false }) {
  const subject = new Fixture();
  subject.clips = clips;
  subject.packagingOutputFolder = null;
  subject.saves = 0;
  subject.picks = 0;
  subject.scheduleSave = () => subject.saves++;
  subject.pushAgentLog = () => {};
  subject.desktop = { isDesktop: true, addRoot: async purpose => {
    assert.equal(purpose, 'packaging'); subject.picks++; return choice;
  } };
  return subject;
}
const clip = extra => ({ kind: 'media', id: 'same-id', file: new File(['video'], 'vlog.mp4'), manualCuts: [{ start: 1, end: 2 }], ...extra });

test('native picker path is resolved without changing bytes or requiring reimport', async () => {
  const media = clip({});
  globalThis.window = { desktop: { pathForFile: file => file === media.file ? 'C:\\Videos\\vlog.mp4' : null } };
  try {
    const subject = fixture([media]);
    const originalFile = media.file;
    assert.equal(await subject.ensurePackagingFolder(), 'C:\\Videos\\video-packaging');
    assert.equal(media.sourcePath, 'C:\\Videos\\vlog.mp4');
    assert.equal(media.file, originalFile);
    assert.deepEqual(media.manualCuts, [{ start: 1, end: 2 }]);
    assert.equal(subject.saves, 1);
    assert.equal(subject.picks, 0);
  } finally { delete globalThis.window; }
});

test('old project reference restores the folder even with a plain File', async () => {
  const media = clip({ fileRef: { path: 'D:\\Footage\\vlog.mp4', name: 'vlog.mp4', size: 5 } });
  const subject = fixture([media]);
  assert.equal(await subject.ensurePackagingFolder(), 'D:\\Footage\\video-packaging');
  assert.equal(media.sourcePath, media.fileRef.path);
  assert.equal(subject.picks, 0);
});

test('pathless but readable media asks once for an output folder, never for reimport', async () => {
  const media = clip({});
  const subject = fixture([media]);
  assert.equal(await subject.ensurePackagingFolder(), 'C:\\Output\\video-packaging');
  assert.equal(await subject.ensurePackagingFolder(), 'C:\\Output\\video-packaging');
  assert.equal(subject.picks, 1);
  assert.equal(media.sourcePath, undefined, 'output folder must never become a fake source path');
  assert.equal(await media.file.text(), 'video');
});

test('cancelled or refused folder leaves the project and destination unchanged', async () => {
  for (const cancelled of [true, false]) {
    const media = clip({});
    const subject = fixture([media], { granted: null, cancelled });
    await assert.rejects(subject.ensurePackagingFolder(), { code: cancelled ? 'cancelled' : 'path_unavailable' });
    assert.equal(subject.packagingOutputFolder, null);
    assert.equal(subject.clips[0], media);
    assert.equal(subject.saves, 0);
  }
});

test('web/SSR and synthetic files tolerate an absent or rejecting native bridge', () => {
  const file = new File(['video'], 'vlog.mp4');
  assert.equal(paths.pathBackedPath(file), undefined);
  globalThis.window = { desktop: { pathForFile: () => { throw new Error('not a native file'); } } };
  try { assert.equal(paths.pathBackedPath(file), undefined); }
  finally { delete globalThis.window; }
});

test('MCP path-backed files work without a native bridge', () => {
  const file = new paths.PathBackedFile({ name: 'vlog.mp4', type: 'video/mp4', size: 5, lastModified: 123,
    filePath: 'C:\\Videos\\vlog.mp4', url: 'http://localhost/media' });
  assert.equal(paths.pathBackedPath(file), 'C:\\Videos\\vlog.mp4');
});

test('real folder IPC accepts existing grants, honors refusal/cancel and checks the sender', async () => {
  const main = fs.readFileSync(new URL('../../electron/src/main.js', import.meta.url), 'utf8');
  const start = main.indexOf("ipcMain.handle('roots:add'");
  const end = main.indexOf("ipcMain.handle('roots:remove'", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let trusted = true;
  let chosen = { folder: 'C:\\Output' };
  let outcome = { added: false, root: 'C:\\Output', reason: null };
  let options;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_, fn) => { handler = fn; } },
    fromOurApp: () => trusted,
    BrowserWindow: { fromWebContents: () => ({}) },
    chooseFolder: async value => { options = value; return chosen; },
    rememberConsent: () => outcome,
    rootStore: () => ({ describe: () => ({ roots: ['C:\\Output'] }) })
  });
  assert.equal((await handler({ sender: {} }, 'packaging')).granted, 'C:\\Output');
  assert.match(options.title, /Video Packaging/);
  outcome = { ...outcome, reason: 'system folder' };
  assert.equal((await handler({ sender: {} }, 'packaging')).granted, null);
  chosen = null;
  assert.equal((await handler({ sender: {} }, 'packaging')).cancelled, true);
  trusted = false;
  await assert.rejects(handler({ sender: {} }, 'packaging'), /unknown page/);
});

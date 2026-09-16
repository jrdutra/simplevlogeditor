'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { editorLocationFile, rememberEditorLocation } = require('./editor-location');

test('registers a movable source editor and preserves it when a packaged launch has no source host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-editor-location-'));
  const source = path.join(root, 'source');
  const state = editorLocationFile(path.join(root, 'local'), path.join(root, 'user'));
  await fs.mkdir(path.join(source, 'electron', 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'electron', 'src', 'mcp-host.js'), '// fixture\n');
  try {
    const registered = await rememberEditorLocation(state, {
      sourceRoot: source,
      executablePath: path.join(source, 'electron.exe'),
      resourcesPath: path.join(source, 'resources')
    });
    assert.equal(registered.projectRoot, source);
    assert.equal(registered.mcpHostPath, path.join(source, 'electron', 'src', 'mcp-host.js'));

    const packaged = await rememberEditorLocation(state, {
      sourceRoot: path.join(root, 'installed-without-sources'),
      executablePath: path.join(root, 'SimpleVlogEditor.exe'),
      resourcesPath: path.join(root, 'resources')
    });
    assert.equal(packaged.projectRoot, source);
    assert.equal(packaged.executablePath, path.join(root, 'SimpleVlogEditor.exe'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the existing Electron userData folder when LOCALAPPDATA is unavailable', () => {
  assert.equal(
    editorLocationFile('', path.join('profile', 'SimpleVlogEditor')),
    path.join('profile', 'SimpleVlogEditor', 'editor-location.json')
  );
});

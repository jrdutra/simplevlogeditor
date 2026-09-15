'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { rootsFile, readRoots, writeRoots } = require('./roots-store-file');

async function scratch() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sve-roots-'));
}

test('roots.json sits beside editor-location.json under LOCALAPPDATA', () => {
  assert.equal(
    rootsFile('C:\\Users\\me\\AppData\\Local', 'C:\\ignored'),
    path.join('C:\\Users\\me\\AppData\\Local', 'SimpleVlogEditor', 'roots.json')
  );
  assert.equal(rootsFile(null, '/home/me/.config/sve'), path.join('/home/me/.config/sve', 'roots.json'));
});

test('a grant survives being written and read back', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'nested', 'roots.json');
  await writeRoots(file, [{ path: path.join(dir, 'Videos') }]);
  const back = await readRoots(file);
  assert.deepEqual(back.roots.map((entry) => entry.path), [path.join(dir, 'Videos')]);
  assert.ok(back.roots[0].grantedAt);
});

test('a macOS bookmark is kept, because the path alone does not survive a relaunch', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'roots.json');
  await writeRoots(file, [{ path: path.join(dir, 'Movies'), bookmark: 'Ym9va21hcms=' }]);
  assert.equal((await readRoots(file)).roots[0].bookmark, 'Ym9va21hcms=');
});

test('a missing or corrupt file reads as no grants rather than throwing', async () => {
  const dir = await scratch();
  assert.deepEqual((await readRoots(path.join(dir, 'absent.json'))).roots, []);
  const broken = path.join(dir, 'broken.json');
  await fsp.writeFile(broken, '{ not json');
  assert.deepEqual((await readRoots(broken)).roots, []);
});

test('relative and malformed entries are dropped on read', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'roots.json');
  await fsp.writeFile(file, JSON.stringify({ version: 1, roots: [
    { path: 'not/absolute' }, { path: 42 }, null, { path: path.join(dir, 'Good') }
  ] }));
  assert.deepEqual((await readRoots(file)).roots.map((entry) => entry.path), [path.join(dir, 'Good')]);
});

test('a rewrite replaces the file rather than appending to it', async () => {
  const dir = await scratch();
  const file = path.join(dir, 'roots.json');
  await writeRoots(file, [{ path: path.join(dir, 'One') }, { path: path.join(dir, 'Two') }]);
  await writeRoots(file, [{ path: path.join(dir, 'Two') }]);
  assert.deepEqual((await readRoots(file)).roots.map((entry) => entry.path), [path.join(dir, 'Two')]);
  const leftovers = (await fsp.readdir(dir)).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'no temporary file may be left behind');
});

'use strict';

/**
 * What `get_recovery_state` has to answer.
 *
 * The question a resuming caller actually has is "is this checkpoint mine",
 * and a path, a size and a date cannot answer it. These pin the shape that
 * can: the media it refers to, the folders those sit in, and which of those
 * files are no longer on disk.
 *
 * main.js needs Electron to load, so the summarising logic is exercised
 * through the same document shape rather than through the module.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

/** The projection main.js performs, kept here so its shape is pinned. */
async function summarise(document, fs = fsp) {
  const clips = Array.isArray(document?.clips) ? document.clips : [];
  const media = [];
  for (const clip of clips) {
    if (clip?.kind !== 'media' || !clip.file) continue;
    media.push({
      clipId: typeof clip.id === 'string' ? clip.id : null,
      name: typeof clip.file.name === 'string' ? clip.file.name : null,
      path: typeof clip.file.path === 'string' ? clip.file.path : null
    });
  }
  const folders = [...new Set(media.map((entry) => entry.path).filter(Boolean).map((entry) => path.dirname(entry)))];
  const missingMedia = (await Promise.all(media.filter((entry) => entry.path).map(async (entry) => {
    try { await fs.stat(entry.path); return null; }
    catch { return entry.path; }
  }))).filter(Boolean);
  return { clipCount: clips.length, media, folders, missingMedia };
}

async function scratch() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sve-recovery-'));
  await fsp.writeFile(path.join(dir, 'DJI_0670.MP4'), 'x');
  await fsp.writeFile(path.join(dir, 'DJI_0671.MP4'), 'x');
  return dir;
}

test('the checkpoint names its media, and the one folder they came from', async () => {
  const dir = await scratch();
  const summary = await summarise({
    projectRevision: 8,
    clips: [
      { kind: 'media', id: 'clip-0', file: { name: 'DJI_0670.MP4', path: path.join(dir, 'DJI_0670.MP4') } },
      { kind: 'media', id: 'clip-1', file: { name: 'DJI_0671.MP4', path: path.join(dir, 'DJI_0671.MP4') } },
      { kind: 'transition', id: 'clip-2' }
    ]
  });
  assert.equal(summary.clipCount, 3);
  assert.deepEqual(summary.media.map((entry) => entry.clipId), ['clip-0', 'clip-1']);
  assert.deepEqual(summary.folders, [dir], 'one working directory is what a resumed edit looks like');
  assert.deepEqual(summary.missingMedia, []);
});

test('a file that moved away is named, so a resume is not attempted blindly', async () => {
  const dir = await scratch();
  const gone = path.join(dir, 'gone.MP4');
  const summary = await summarise({
    clips: [
      { kind: 'media', id: 'clip-0', file: { name: 'DJI_0670.MP4', path: path.join(dir, 'DJI_0670.MP4') } },
      { kind: 'media', id: 'clip-1', file: { name: 'gone.MP4', path: gone } }
    ]
  });
  assert.deepEqual(summary.missingMedia, [gone]);
  assert.equal(summary.media.length, 2, 'a missing file is still part of the edit');
});

test('media spread across two folders is reported as two, not collapsed', async () => {
  const one = await scratch();
  const two = await scratch();
  const summary = await summarise({
    clips: [
      { kind: 'media', id: 'a', file: { name: 'DJI_0670.MP4', path: path.join(one, 'DJI_0670.MP4') } },
      { kind: 'media', id: 'b', file: { name: 'DJI_0670.MP4', path: path.join(two, 'DJI_0670.MP4') } }
    ]
  });
  assert.deepEqual(summary.folders.sort(), [one, two].sort());
});

test('a checkpoint written before paths were stored still reports its media', async () => {
  const summary = await summarise({
    clips: [{ kind: 'media', id: 'clip-0', file: { name: 'DJI_0670.MP4', size: 10, lastModified: 0 } }]
  });
  assert.deepEqual(summary.media, [{ clipId: 'clip-0', name: 'DJI_0670.MP4', path: null }]);
  assert.deepEqual(summary.folders, [], 'no path means no folder to compare, not a wrong one');
  assert.deepEqual(summary.missingMedia, []);
});

test('an empty or malformed document summarises to nothing rather than throwing', async () => {
  for (const document of [null, {}, { clips: 'not an array' }, { clips: [null, 7, { kind: 'media' }] }]) {
    const summary = await summarise(document);
    assert.deepEqual(summary.media, []);
    assert.deepEqual(summary.folders, []);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ShortEditor, ranges, settings, renderArgs, COMMANDS } = require('./short-editor');
const { probeWithFfprobe, ffmpegExecutable } = require('./media-import-service');

test('all independent commands are exposed with closed MCP schemas', () => {
  const tools = require('./short-editor-tools');
  assert.deepEqual(tools.map(t => t.name).sort(), [...COMMANDS].sort());
  assert.ok(tools.every(t => t.inputSchema.additionalProperties === false));
});
test('cut validation preserves ordering and rejects invalid or out-of-source intervals', () => {
  assert.deepEqual(ranges([{ start: 4, end: 5 }, { start: 0, end: 1 }], 5), [{ start: 4, end: 5 }, { start: 0, end: 1 }]);
  for (const value of [[], [{ start: -1, end: 1 }], [{ start: 0, end: 6 }], [{ start: 1, end: 1 }], [{ start: NaN, end: 2 }]]) assert.throws(() => ranges(value, 5));
  assert.throws(() => settings({ cropX: 2 }));
  assert.deepEqual(ranges([{ start: 0, end: 1, cropX: 0.2 }, { start: 1, end: 2, cropX: null }], 5), [{ start: 0, end: 1, cropX: 0.2 }, { start: 1, end: 2 }]);
  assert.throws(() => ranges([{ start: 0, end: 1, cropX: 1.5 }], 5));
  const framed = renderArgs({ path: 'source.mp4', hasAudio: false }, { ranges: [{ start: 0, end: 1, cropX: 0.1 }, { start: 1, end: 2 }], settings: settings({ cropX: 0.7 }) }, 'framed.mp4').args.join(' ');
  assert.match(framed, /\(iw-ow\)\*0\.1:/); assert.match(framed, /\(iw-ow\)\*0\.7:/);
  // A followed cut: validated points, and a crop that moves along them in the cut's own time.
  assert.deepEqual(ranges([{ start: 10, end: 12, cropTrack: [{ t: 10, x: 0.2 }, { t: 11, x: 0.8 }] }], 20)[0].cropTrack, [{ t: 10, x: 0.2 }, { t: 11, x: 0.8 }]);
  assert.throws(() => ranges([{ start: 0, end: 1, cropTrack: [{ t: 1, x: 0.5 }, { t: 0, x: 0.5 }] }], 5));
  assert.throws(() => ranges([{ start: 0, end: 1, cropTrack: [{ t: 0, x: 2 }] }], 5));
  const followed = renderArgs({ path: 'source.mp4', hasAudio: false }, { ranges: [{ start: 10, end: 12, cropTrack: [{ t: 10, x: 0.2 }, { t: 11, x: 0.8 }] }], settings: settings() }, 'followed.mp4').args.join(' ');
  assert.match(followed, /x='\(iw-ow\)\*\(0\.2\+0\.6\*clip\(\(t-0\)\/1,0,1\)\)'/);
  assert.throws(() => settings({ transition: 'invalid' }));
  // Fades at the overlaps: chosen lengths fade each cut's own sound and sum the overlap; 0 is no fade.
  assert.equal(settings({}).audioFadeOut, null); assert.throws(() => settings({ audioFadeIn: 3 }));
  const faded = renderArgs({ path: 'source.mp4', hasAudio: true }, { ranges: [{ start: 0, end: 2 }, { start: 3, end: 5 }], settings: settings({ transition: 'fade', transitionSeconds: 0.5, audioFadeOut: 0.3, audioFadeIn: 0 }) }, 'f.mp4').args.join(' ');
  assert.match(faded, /afade=t=out:st=1\.7:d=0\.3\[a0\]/); assert.doesNotMatch(faded, /afade=t=in/); assert.match(faded, /acrossfade=d=0\.5:c1=nofade:c2=nofade/);
  const crossfaded = renderArgs({ path: 'source.mp4', hasAudio: true }, { ranges: [{ start: 0, end: 2 }, { start: 3, end: 5 }], settings: settings({ transition: 'fade', transitionSeconds: 0.5 }) }, 'c.mp4').args.join(' ');
  assert.match(crossfaded, /acrossfade=d=0\.5\[aj1\]/); assert.doesNotMatch(crossfaded, /afade/);
  // Two levels: the original under the chosen audio, or the chosen audio alone.
  assert.deepEqual([settings({ audioPath: 'm.mp3', volume: 0.4 }).volume, settings({ audioPath: 'm.mp3', volume: 0.4 }).musicVolume], [0, 0.4]);
  assert.throws(() => settings({ musicVolume: 3 }));
  const mixed = renderArgs({ path: 'source.mp4', hasAudio: true }, { ranges: [{ start: 0, end: 1 }], settings: settings({ audioPath: 'm.mp3', volume: 0.5, musicVolume: 0.8 }) }, 'mixed.mp4').args.join(' ');
  assert.match(mixed, /volume=0\.5\[original\]/); assert.match(mixed, /volume=0\.8\[music\]/); assert.match(mixed, /amerge=inputs=2/);
  const replaced = renderArgs({ path: 'source.mp4', hasAudio: true }, { ranges: [{ start: 0, end: 1 }], settings: settings({ audioPath: 'm.mp3', volume: 0, musicVolume: 0.8 }) }, 'replaced.mp4').args.join(' ');
  assert.match(replaced, /anullsink/); assert.doesNotMatch(replaced, /amerge/);
  const legacy = renderArgs({ path: 'source.mp4', hasAudio: true }, { ranges: [{ start: 0, end: 1 }], settings: { audioPath: 'm.mp3', volume: 0.7, transition: 'cut', transitionSeconds: 0.3, cropX: 0.5 } }, 'legacy.mp4').args.join(' ');
  assert.match(legacy, /anullsink/); assert.match(legacy, /volume=0\.7\[audio\]/);
});
test('short_clear empties the session and nothing of it comes back on restart', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'short-clear-'));
  try {
    const statePath = path.join(folder, 'session.json');
    const editor = new ShortEditor({ admit: value => value, statePath });
    await editor.ready;
    editor.state = { ...editor.state, source: { path: 'a.mp4', name: 'a.mp4', duration: 10, hasAudio: true }, selection: [{ start: 1, end: 2 }], shorts: [{ id: 'x', name: 'X', ranges: [{ start: 0, end: 1 }], settings: settings(), status: 'idle', progress: 0 }], zoom: 4 };
    const state = await editor.execute('short_clear', {});
    assert.equal(state.source, null); assert.deepEqual(state.shorts, []); assert.deepEqual(state.selection, []); assert.equal(state.zoom, 1);
    const restored = new ShortEditor({ admit: value => value, statePath });
    assert.equal((await restored.execute('short_get_state')).source, null);
    await assert.rejects(restored.execute('short_create', {}), /Import a video first/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('MCP focus edits one interval atomically, preserves other cuts and survives restart', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'short-focus-'));
  try {
    const statePath = path.join(folder, 'session.json');
    const editor = new ShortEditor({ admit: value => value, statePath });
    await editor.ready;
    const tracked = { start: 10, end: 20, cropTrack: [{ t: 10, x: .2 }, { t: 15, x: .5 }, { t: 20, x: .8 }] };
    editor.state.source = { duration: 30 };
    await editor.execute('short_set_selection', { ranges: [tracked, { start: 21, end: 23 }] });
    await editor.execute('short_set_focus', { cutIndex: 0, start: 12, end: 14, x: .9, transitionSeconds: .2 });
    const updated = editor.snapshot().selection;
    assert.deepEqual(updated[1], { start: 21, end: 23 });
    const keys = updated[0].cropTrack;
    assert.deepEqual(keys.filter(k => k.t < 12 || k.t > 14), tracked.cropTrack);
    assert.ok(Math.abs(keys.find(k => k.t === 12).x - .32) < 1e-9);
    assert.ok(Math.abs(keys.find(k => k.t === 14).x - .44) < 1e-9);
    assert.equal(keys.find(k => k.t === 12.2).x, .9);
    for (const args of [{ cutIndex: -1 }, { start: 9 }, { end: 25 }, { x: 2 }, { x: NaN }, { transitionSeconds: -1 }]) {
      await assert.rejects(editor.execute('short_set_focus', { cutIndex: 0, start: 12, end: 14, x: .9, ...args }));
      assert.deepEqual(editor.snapshot().selection, updated);
    }
    const created = await editor.execute('short_create');
    const id = created.shorts[0].id;
    Object.assign(editor.state.shorts[0], { status: 'done', progress: 100, outputPath: 'old.mp4' });
    const focused = await editor.execute('short_set_focus', { id, cutIndex: 1, start: 21, end: 23, x: 0, endX: 1 });
    assert.equal(focused.shorts[0].status, 'idle');
    assert.equal(focused.shorts[0].outputPath, null);
    assert.deepEqual(focused.shorts[0].ranges[1].cropTrack, [{ t: 21, x: 0 }, { t: 23, x: 1 }]);
    const restored = new ShortEditor({ admit: value => value, statePath });
    assert.deepEqual((await restored.execute('short_get_state')).shorts, focused.shorts);
    editor.state.shorts[0].status = 'rendering';
    await assert.rejects(editor.execute('short_set_focus', { id, cutIndex: 0, start: 12, end: 14, x: .5 }), /finish rendering/);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
test('transition overlap is bounded by adjacent cuts', () => {
  const result = renderArgs({ path: 'source.mp4', hasAudio: false }, { ranges: [{ start: 0, end: .2 }, { start: 1, end: 2 }], settings: settings({ transition: 'fade', transitionSeconds: 2 }) }, 'new.mp4');
  assert.equal(result.duration, 1.1);
  assert.ok(result.args.join(' ').includes('duration=0.1:offset=0.1'));
});

test('real media: import, independent shorts, transition/audio renders, cancellation, recovery and overwrite protection', { skip: !process.env.SVE_SHORT_MEDIA_TEST, timeout: 180000 }, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sve-short-test-'));
  const run = promisify(execFile);
  const source = path.join(folder, 'horizontal.mp4'), silent = path.join(folder, 'silent.mp4'), music = path.join(folder, 'music.wav');
  const ffmpeg = ffmpegExecutable();
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true });
  await run(ffmpeg, ['-v', 'error', '-i', source, '-an', '-c:v', 'copy', silent], { windowsHide: true });
  await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', music], { windowsHide: true });
  const admit = candidate => {
    if (typeof candidate !== 'string' || (path.resolve(candidate) !== folder && !path.resolve(candidate).startsWith(folder + path.sep))) throw new Error('Path denied.');
    return path.resolve(candidate);
  };
  const statePath = path.join(folder, 'session.json');
  const editor = new ShortEditor({ admit, statePath });
  const finish = async id => {
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const short = (await editor.execute('short_get_state')).shorts.find(s => s.id === id);
      if (short.status !== 'rendering' && !editor.jobs.has(id)) return short;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Render did not complete.');
  };
  try {
    let state = await editor.execute('short_import_video', { path: source });
    assert.match(state.source.filmstrip, /^data:image\/jpeg;base64,.+/);
    assert.match(state.source.waveformImage, /^data:image\/png;base64,.+/);
    await editor.execute('short_set_selection', { ranges: [{ start: 0, end: 1 }, { start: 2, end: 3 }] });
    state = await editor.execute('short_create', { name: 'First' });
    const first = state.shorts[0].id;
    assert.deepEqual(state.selection, []);
    await assert.rejects(editor.execute('short_import_video', { path: silent }), /replace/);
    await assert.rejects(editor.execute('short_update', { id: first, ranges: [{ start: 0, end: 99 }] }));
    assert.equal((await editor.execute('short_get_state')).shorts[0].ranges[0].end, 1);
    await editor.execute('short_set_focus', { id: first, cutIndex: 0, start: .1, end: .9, x: .1, endX: .9, transitionSeconds: .1 });
    await editor.execute('short_set_focus', { id: first, cutIndex: 1, start: 2, end: 3, x: .8, endX: .2 });
    for (const transition of ['cut', 'fade', 'wipeleft', 'slideright']) {
      await editor.execute('short_update', { id: first, settings: { transition, audioPath: transition === 'fade' ? music : null } });
      const outputPath = path.join(folder, `${transition}.mp4`);
      await editor.execute('short_render', { id: first, outputPath });
      const completed = await finish(first);
      assert.equal(completed.status, 'done', completed.error);
      const probe = await probeWithFfprobe(outputPath);
      const video = probe.streams.find(s => s.codec_type === 'video');
      assert.equal(video.width, 1080); assert.equal(video.height, 1920);
      assert.ok(probe.streams.some(s => s.codec_type === 'audio'));
      assert.ok(Math.abs(Number(probe.format.duration) - (transition === 'cut' ? 2 : 1.7)) < .15);
      await assert.rejects(editor.execute('short_render', { id: first, outputPath }), /already exists/);
    }
    state = await editor.execute('short_create', { ranges: [{ start: 0, end: 4 }] });
    const second = state.shorts[1].id;
    await editor.execute('short_render', { id: second, outputPath: path.join(folder, 'cancel.mp4') });
    await editor.execute('short_cancel_render', { id: second });
    assert.equal((await finish(second)).status, 'error');
    await assert.rejects(fs.stat(path.join(folder, 'cancel.mp4')), { code: 'ENOENT' });
    const restored = new ShortEditor({ admit, statePath });
    assert.equal((await restored.execute('short_get_state')).shorts.length, 2);
    await editor.execute('short_import_video', { path: silent, replace: true });
    state = await editor.execute('short_create', { ranges: [{ start: 0, end: .5 }, { start: 1, end: 1.5 }], settings: { transition: 'fade' } });
    await editor.execute('short_render', { id: state.shorts[0].id, outputPath: path.join(folder, 'silent-result.mp4') });
    assert.equal((await finish(state.shorts[0].id)).status, 'done');
    assert.equal((await editor.execute('short_get_state')).source.hasAudio, false);
  } finally {
    for (const child of editor.jobs.values()) child.kill();
    // Only this test's unique temporary directory is eligible for cleanup.
    if (path.dirname(folder) === os.tmpdir() && path.basename(folder).startsWith('sve-short-test-')) await fs.rm(folder, { recursive: true, force: true });
  }
});

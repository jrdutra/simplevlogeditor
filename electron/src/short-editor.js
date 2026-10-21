'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { probeWithFfprobe, ffmpegExecutable } = require('./media-import-service');

const { validateCaptions, captionAss, mergeCaptions, transcriptSegments, defaultCaptionStyle, CAPTION_PRESETS, CAPTION_FONTS } = require('./short-captions');

const COMMANDS = ['short_get_state', 'short_import_video', 'short_set_selection', 'short_create', 'short_update', 'short_delete', 'short_render', 'short_cancel_render', 'short_set_view', 'short_clear', 'short_set_focus',
  'short_get_capabilities', 'short_get_transcript', 'short_save_document', 'short_open_document'];
/** Commands that only read: no requestId, nothing persisted. */
const READS = new Set(['short_get_state', 'short_get_capabilities', 'short_get_transcript']);
/** Written into every saved file. The same value the window's Save writes, so either can open the other's files. */
const DOCUMENT_APP = 'simplevlogeditor-short-editor';
const TRANSITIONS = ['cut', 'fade', 'wipeleft', 'slideright'];
// `volume` is the original sound's level; `musicVolume` the chosen replacement's, mixed over it.
// `audioFadeOut`/`audioFadeIn`: seconds the sound of each cut fades out/in where a transition overlaps two cuts;
// null keeps the original behaviour, a crossfade exactly as long as the overlap. 0 means no fade at all.
const defaults = () => ({ audioPath: null, volume: 1, musicVolume: 1, transition: 'cut', transitionSeconds: 0.3, cropX: 0.5, audioFadeOut: null, audioFadeIn: null });
function ranges(value, duration) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error('Choose between 1 and 100 cuts.');
  return value.map(r => {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end > duration + 0.001 || r.end - r.start < 0.1) throw new Error('Cuts must be within the video and last at least 0.1 seconds.');
    const cut = { start: r.start, end: Math.min(r.end, duration) };
    // Optional framing of this cut alone; without it the short's cropX applies.
    if (r.cropX !== undefined && r.cropX !== null) {
      if (!Number.isFinite(r.cropX) || r.cropX < 0 || r.cropX > 1) throw new Error('Invalid cropX for a cut.');
      cut.cropX = r.cropX;
    }
    // Person tracking: the frame follows these points (seconds of the source) instead of standing still.
    if (r.cropTrack !== undefined && r.cropTrack !== null) {
      if (!Array.isArray(r.cropTrack) || r.cropTrack.length > 3000) throw new Error('Invalid cropTrack for a cut.');
      let previous = -Infinity;
      const track = r.cropTrack.map(key => {
        const t = Number(key && key.t), x = Number(key && key.x);
        if (!Number.isFinite(t) || !Number.isFinite(x) || x < 0 || x > 1 || t < previous) throw new Error('Invalid cropTrack for a cut.');
        previous = t;
        return { t, x };
      });
      if (track.length) cut.cropTrack = track;
    }
    // The choices the tracked path was drawn with: waits before changing person, and smoothness.
    if (r.follow !== undefined && r.follow !== null) {
      const f = r.follow, ms = n => Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) <= 5000;
      if (typeof f !== 'object' || typeof f.delays !== 'boolean' || !ms(f.startDelayMs) || !ms(f.holdDelayMs) || !['abrupt', 'slight', 'smooth', 'very'].includes(f.smoothness)) throw new Error('Invalid follow settings for a cut.');
      cut.follow = { delays: f.delays, startDelayMs: Number(f.startDelayMs), holdDelayMs: Number(f.holdDelayMs), smoothness: f.smoothness };
    }
    return cut;
  });
}
function settings(value = {}) {
  const s = { ...defaults(), ...value };
  // Settings saved before the two levels existed meant "replace": the original
  // was silent and `volume` was the replacement's. They keep meaning that.
  if (value && value.audioPath && value.musicVolume === undefined) { s.musicVolume = s.volume; s.volume = 0; }
  if (!['cut', 'fade', 'wipeleft', 'slideright'].includes(s.transition)) throw new Error('Unknown transition.');
  for (const [key, min, max] of [['volume', 0, 2], ['musicVolume', 0, 2], ['cropX', 0, 1], ['transitionSeconds', 0.05, 2]]) {
    if (!Number.isFinite(s[key]) || s[key] < min || s[key] > max) throw new Error(`Invalid ${key}.`);
  }
  for (const key of ['audioFadeOut', 'audioFadeIn']) {
    if (s[key] === undefined) s[key] = null;
    if (s[key] !== null && (!Number.isFinite(s[key]) || s[key] < 0 || s[key] > 2)) throw new Error(`Invalid ${key}.`);
  }
  if (s.audioPath !== null && (typeof s.audioPath !== 'string' || !s.audioPath)) throw new Error('Invalid audio path.');
  const result = Object.fromEntries(Object.keys(defaults()).map(k => [k, s[k]]));
  if (s.captions !== undefined) result.captions = validateCaptions(s.captions);
  return result;
}

// Edit only the requested source-time interval. Keeping the old path at the
// boundaries avoids moving the camera in neighbouring (already tracked) scenes.
function focusRange(cut, fallback, args) {
  const { start, end, x, endX = x, transitionSeconds = 0.2 } = args;
  if (![start, end, x, endX, transitionSeconds].every(Number.isFinite)
    || start < cut.start || end > cut.end || end - start < 0.1
    || x < 0 || x > 1 || endX < 0 || endX > 1 || transitionSeconds < 0 || transitionSeconds > 2) {
    throw new Error('Focus requires an interval inside the cut, positions from 0 to 1 and transitionSeconds from 0 to 2.');
  }
  const old = cut.cropTrack?.length ? cut.cropTrack : [{ t: cut.start, x: cut.cropX ?? fallback }, { t: cut.end, x: cut.cropX ?? fallback }];
  const at = t => {
    if (t <= old[0].t) return old[0].x;
    for (let i = 1; i < old.length; i++) if (t < old[i].t) {
      const a = old[i - 1], b = old[i];
      return a.x + (b.x - a.x) * (t - a.t) / (b.t - a.t);
    }
    return old[old.length - 1].x;
  };
  // An instantaneous change is represented by one millisecond, shared by the
  // preview and FFmpeg interpolators; no duplicate timestamps are introduced.
  const ramp = Math.min(Math.max(0.001, transitionSeconds), (end - start) / 2);
  const keys = old.filter(key => key.t < start || key.t > end);
  if (start > cut.start) keys.push({ t: start, x: at(start) });
  keys.push({ t: start > cut.start ? start + ramp : start, x });
  keys.push({ t: end < cut.end ? end - ramp : end, x: endX });
  if (end < cut.end) keys.push({ t: end, x: at(end) });
  keys.sort((a, b) => a.t - b.t);
  const track = keys.filter((key, i) => i === keys.length - 1 || key.t !== keys[i + 1].t);
  if (track.length > 3000) throw new Error('Focus would exceed 3000 framing points. Simplify the cropTrack first.');
  return { ...cut, cropTrack: track };
}

/**
 * The crop's horizontal position for one cut, as an ffmpeg expression.
 *
 * A still framing is a number. A followed one is the tracked path joined by
 * straight lines — a sum of clipped ramps rather than nested ifs, so a long
 * path does not nest deeply — in the cut's own time, which starts at zero.
 */
function cropExpression(r, fallback) {
  const keys = Array.isArray(r.cropTrack) ? r.cropTrack : [];
  if (!keys.length) return `(iw-ow)*${r.cropX ?? fallback}`;
  const n = value => Number(value.toFixed(4));
  let path = `${n(keys[0].x)}`;
  for (let i = 1; i < keys.length; i++) {
    const from = keys[i - 1], to = keys[i], step = n(to.x - from.x), span = Math.max(0.001, to.t - from.t);
    if (step) path += `+${step}*clip((t-${n(from.t - r.start)})/${n(span)},0,1)`;
  }
  return `'(iw-ow)*(${path})'`;
}

// Each input is trimmed before composition. Both tracks use exactly the same cut boundaries.
function renderArgs(source, short, output, captionsFile) {
  const s = short.settings, cuts = short.ranges;
  const args = ['-v', 'error', '-nostdin', '-filter_complex_threads', '1'];
  for (const r of cuts) args.push('-ss', String(r.start), '-t', String(r.end - r.start), '-i', source.path);
  if (s.audioPath) args.push('-stream_loop', '-1', '-i', s.audioPath);
  const filters = [];
  // Chosen fades at the overlaps: each cut's own sound fades, and the overlap is then a plain sum.
  const chosenFades = s.transition !== 'cut' && (Number.isFinite(s.audioFadeOut) || Number.isFinite(s.audioFadeIn));
  cuts.forEach((r, i) => {
    const d = r.end - r.start;
    let fades = '';
    if (chosenFades) {
      const fadeIn = i > 0 ? Math.min(s.audioFadeIn ?? 0, d) : 0, fadeOut = i < cuts.length - 1 ? Math.min(s.audioFadeOut ?? 0, d) : 0;
      if (fadeIn > 0) fades += `,afade=t=in:st=0:d=${fadeIn}`;
      if (fadeOut > 0) fades += `,afade=t=out:st=${d - fadeOut}:d=${fadeOut}`;
    }
    filters.push(`[${i}:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=w=1080:h=1920:x=${cropExpression(r, s.cropX)}:y=(ih-oh)/2,setsar=1,fps=30,format=yuv420p,settb=AVTB[v${i}]`);
    filters.push(source.hasAudio
      ? `[${i}:a]atrim=duration=${d},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${d}${fades}[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
  });
  let v = 'v0', a = 'a0', duration = cuts[0].end - cuts[0].start;
  for (let i = 1; i < cuts.length; i++) {
    const d = cuts[i].end - cuts[i].start;
    if (s.transition === 'cut') {
      filters.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[vj${i}][aj${i}]`);
      duration += d;
    } else {
      const fade = Math.min(s.transitionSeconds, (cuts[i - 1].end - cuts[i - 1].start) / 2, d / 2);
      filters.push(`[${v}][v${i}]xfade=transition=${s.transition}:duration=${fade}:offset=${duration - fade}[vj${i}]`);
      filters.push(chosenFades ? `[${a}][a${i}]acrossfade=d=${fade}:c1=nofade:c2=nofade[aj${i}]` : `[${a}][a${i}]acrossfade=d=${fade}[aj${i}]`);
      duration += d - fade;
    }
    v = `vj${i}`; a = `aj${i}`;
  }
  if (s.audioPath) {
    // A short saved before the two levels existed has no musicVolume: its
    // `volume` was the replacement's and the original was silent.
    const music = s.musicVolume ?? s.volume, original = s.musicVolume === undefined ? 0 : s.volume;
    if (original > 0) {
      filters.push(`[${cuts.length}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,atrim=duration=${duration},volume=${music}[music]`);
      filters.push(`[${a}]volume=${original}[original]`);
      filters.push(`[original][music]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3[audio]`);
    } else {
      filters.push(`[${a}]anullsink`);
      filters.push(`[${cuts.length}:a]aresample=48000,asetpts=PTS-STARTPTS,atrim=duration=${duration},volume=${music}[audio]`);
    }
  } else filters.push(`[${a}]volume=${s.volume}[audio]`);
  if (captionsFile) {
    const escaped = captionsFile.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    filters.push(`[${v}]subtitles=filename='${escaped}'[captioned]`); v = 'captioned';
  }
  args.push('-filter_complex', filters.join(';'), '-map', `[${v}]`, '-map', '[audio]', '-t', String(duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', '-progress', 'pipe:1', '-n', output);
  return { args, duration };
}

function run(args, onData, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    onChild?.(child);
    let errorText = '', chunks = [], size = 0;
    child.stdout.on('data', data => {
      if (onData) onData(data);
      else if ((size += data.length) <= 24 * 1024 * 1024) chunks.push(data);
      else child.kill();
    });
    child.stderr.on('data', data => { errorText = (errorText + data).slice(-8000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errorText || 'Media processing stopped.')));
  });
}

/** Everything an assistant needs to know before driving the Short Editor. */
function capabilities() {
  return {
    output: { width: 1080, height: 1920, frameRate: 30, container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' },
    transitions: TRANSITIONS,
    defaults: defaults(),
    limits: {
      cutsPerShort: 100, minimumCutSeconds: 0.1, volume: [0, 2], musicVolume: [0, 2], cropX: [0, 1],
      transitionSeconds: [0.05, 2], audioFade: [0, 2], cropTrackPoints: 3000, zoom: [1, 20], simultaneousRenders: 2
    },
    captions: {
      defaultStyle: defaultCaptionStyle(), presets: CAPTION_PRESETS, fonts: CAPTION_FONTS,
      limits: { fontSize: [32, 200], outlineWidth: [0, 8], highlightScale: [1, 1.4], lineHeight: [1, 2.5], positionY: [10, 90], charsPerCaption: [10, 120] },
      note: 'Words come from short_generate_captions (speech recognition on this computer). Each word is highlighted while it is spoken. Captions are burned into the render.'
    },
    personTracking: {
      command: 'short_track_person',
      smoothness: ['abrupt', 'slight', 'smooth', 'very'],
      defaultFollow: { delays: false, startDelayMs: 100, holdDelayMs: 100, smoothness: 'smooth' },
      note: 'Keeps the person in the horizontal centre of the vertical frame: a face first, then whoever is speaking, then a body. Where nobody is visible the frame returns to restX (default: the cut\'s cropX, else the short\'s).'
    },
    documents: { app: DOCUMENT_APP, kinds: ['project', 'settings'] },
    commands: COMMANDS.concat(['short_track_person', 'short_generate_captions'])
  };
}

class ShortEditor {
  constructor({ admit, statePath, changed = () => {} }) {
    this.admit = admit; this.statePath = statePath; this.changed = changed;
    this.state = { source: null, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: 0 };
    this.jobs = new Map(); this.lane = Promise.resolve();
    this.sourceEpoch = randomUUID();
    this.ready = this.restore();
  }
  async restore() {
    try {
      const saved = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      if (saved.source && Array.isArray(saved.shorts)) {
        this.state = saved;
        this.state.shorts.forEach(s => { if (s.status === 'rendering') { s.status = 'error'; s.error = 'Rendering interrupted. Render again.'; } });
      }
    } catch (e) { if (e.code !== 'ENOENT') this.state.recoveryError = 'Could not restore the previous Short Editor session.'; }
  }
  analysisToken() {
    // Playback, zoom and render progress do not invalidate an analysis. Editorial
    // changes do; the epoch also distinguishes reimports of the very same file.
    const { source, selection, draftSettings, shorts } = this.state;
    return createHash('sha256').update(JSON.stringify({ epoch: this.sourceEpoch,
      source: source && { path: source.path, duration: source.duration }, selection, draftSettings,
      shorts: shorts.map(({ id, ranges, settings }) => ({ id, ranges, settings }))
    })).digest('hex');
  }
  snapshot() { return { ...structuredClone(this.state), analysisToken: this.analysisToken() }; }
  async commitState(next, replaceSource = false) {
    const candidate = { ...next, revision: this.state.revision + 1 };
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temp = this.statePath + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify(candidate));
      await fs.rename(temp, this.statePath);
    } catch (error) {
      await fs.unlink(temp).catch(() => {});
      throw error;
    }
    this.state = candidate;
    if (replaceSource) this.sourceEpoch = randomUUID();
    this.changed(this.snapshot());
  }
  async persist() {
    this.state.revision++;
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const temp = this.statePath + '.tmp';
    await fs.writeFile(temp, JSON.stringify(this.state));
    await fs.rename(temp, this.statePath);
    this.changed(this.snapshot());
  }
  execute(name, args = {}, assertActive = () => {}) {
    const result = this.lane.then(async () => { await this.ready; return this.command(name, args, assertActive); });
    this.lane = result.catch(() => {});
    return result;
  }
  async file(candidate) { return this.admit(await fs.realpath(this.admit(candidate))); }
  async validateSettings(value) {
    const s = settings(value);
    if (s.audioPath) {
      s.audioPath = await this.file(s.audioPath);
      const probe = await probeWithFfprobe(s.audioPath);
      if (!probe.streams?.some(t => t.codec_type === 'audio')) throw new Error('The replacement file has no audio.');
    }
    return s;
  }
  /** Settings with a change applied; captions are merged rather than replaced, so a style change keeps the words. */
  withSettings(base, change) {
    if (!change) return base;
    const next = { ...base, ...change };
    if (change.captions !== undefined) next.captions = mergeCaptions(base.captions, change.captions);
    return next;
  }
  /** A file that does not exist yet, inside an allowed folder, with this extension. Never overwrites. */
  async newFile(requested, extension) {
    if (typeof requested !== 'string' || !requested) throw new Error('Choose an output path.');
    const admitted = this.admit(requested);
    const parent = this.admit(await fs.realpath(path.dirname(admitted)));
    const target = this.admit(path.join(parent, path.basename(admitted)));
    if (path.extname(target).toLowerCase() !== extension) throw new Error(`Choose a ${extension} output path.`);
    try { await fs.lstat(target); throw new Error('Output already exists. Choose a new filename.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { target, parent };
  }
  /** Validates and prepares a horizontal source without touching the live session. */
  async readSource(candidate) {
    const file = await this.file(candidate), probe = await probeWithFfprobe(file);
    const video = probe.streams?.find(t => t.codec_type === 'video');
    const duration = Number(probe.format?.duration || video?.duration);
    if (!video || !Number.isFinite(duration) || duration <= 0 || video.width <= video.height) throw new Error('Choose a horizontal video with a valid duration.');
    const source = { path: file, name: path.basename(file), duration, width: video.width, height: video.height, hasAudio: probe.streams.some(t => t.codec_type === 'audio'), thumbnails: [], waveform: [] };
    // Fixed-size visual summaries keep IPC and persisted state bounded for long footage.
    const film = await run(['-v', 'error', '-nostdin', '-i', file, '-vf', `fps=12/${duration},scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=12x1`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1']);
    source.filmstrip = 'data:image/jpeg;base64,' + film.toString('base64');
    if (source.hasAudio) {
      const wave = await run(['-v', 'error', '-nostdin', '-i', file, '-filter_complex', '[0:a]aformat=channel_layouts=mono,showwavespic=s=2000x100:colors=0x69dfc5', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1']);
      source.waveformImage = 'data:image/png;base64,' + wave.toString('base64');
    }
    return source;
  }
  async importSource(candidate) {
    const source = await this.readSource(candidate);
    this.state = { source, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: this.state.revision };
    this.sourceEpoch = randomUUID();
  }
  /** The transcribed words of the session, from the draft or from any short that has them. */
  words() {
    const draft = this.state.draftSettings.captions?.words;
    if (draft?.length) return draft;
    return this.state.shorts.find(s => s.settings.captions?.words?.length)?.settings.captions.words ?? [];
  }
  async command(name, args, assertActive = () => {}) {
    if (!COMMANDS.includes(name)) throw new Error('Unknown Short Editor command.');
    const assertAnalysis = () => {
      assertActive();
      if (args._analysisToken !== undefined && args._analysisToken !== this.analysisToken()) {
        throw Object.assign(new Error('The Short Editor changed during analysis. Run the analysis again for the current session.'), { code: 'stale_analysis' });
      }
    };
    assertAnalysis();
    if (name === 'short_get_state') return this.snapshot();
    if (name === 'short_get_capabilities') return capabilities();
    if (name === 'short_get_transcript') {
      const from = args.from === undefined ? -Infinity : Number(args.from), to = args.to === undefined ? Infinity : Number(args.to);
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw new Error('Invalid transcript interval.');
      const words = this.words();
      const source = this.state.source;
      return {
        source: source ? { name: source.name, path: source.path, duration: source.duration, hasAudio: source.hasAudio } : null,
        wordCount: words.length, timeSpace: 'source',
        segments: transcriptSegments(words, from, to),
        // Word timings for exact cut points, only on request and only for a bounded interval.
        ...(args.includeWords === true ? { words: words.filter(w => w.end > from && w.start < to).slice(0, 5000) } : {}),
        ...(words.length ? {} : { nextStep: 'No transcript yet. Run short_generate_captions to transcribe the source video on this computer.' })
      };
    }
    if (name === 'short_save_document') {
      const kind = args.kind ?? 'project';
      if (!['project', 'settings'].includes(kind)) throw new Error('kind must be project or settings.');
      if (kind === 'project' && !this.state.source) throw new Error('Import a video first.');
      const { target } = await this.newFile(args.path, '.json');
      const portable = value => ({ ...value, audioName: value.audioPath ? path.basename(value.audioPath) : null });
      const savedAt = new Date().toISOString(), state = this.state;
      const document = kind === 'settings'
        ? { app: DOCUMENT_APP, kind, version: 1, savedAt, settings: portable(state.draftSettings) }
        : { app: DOCUMENT_APP, kind, version: 1, savedAt,
          source: { name: state.source.name, path: state.source.path, duration: state.source.duration },
          selection: state.selection, draftSettings: portable(state.draftSettings),
          shorts: state.shorts.map(s => ({ name: s.name, ranges: s.ranges, settings: portable(s.settings) })), zoom: state.zoom };
      await fs.writeFile(target, JSON.stringify(document, null, 2), { flag: 'wx' });
      return { ...this.snapshot(), document: { path: target, kind } };
    }
    if (name === 'short_open_document') {
      const file = await this.file(args.path);
      let document;
      try { document = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new Error('The file could not be read as JSON.'); }
      if (!document || document.app !== DOCUMENT_APP || !['project', 'settings'].includes(document.kind)) throw new Error('Not a Short Editor project or settings file.');
      if (document.version !== 1) throw new Error('Unsupported Short Editor document version.');
      if (document.kind === 'project' && (!Array.isArray(document.shorts) || !Array.isArray(document.selection) || !document.draftSettings)) throw new Error('Invalid Short Editor project.');
      if (document.kind === 'settings' && (!document.settings || typeof document.settings !== 'object')) throw new Error('Invalid Short Editor settings.');
      const missing = [];
      const restore = saved => {
        const { audioName, ...rest } = saved && typeof saved === 'object' ? saved : {};
        const value = { ...defaults(), ...rest };
        if (!value.audioPath && audioName) missing.push(audioName);
        return value;
      };
      // An audio that no longer exists leaves that short with its own sound rather than failing the whole file.
      const usable = async value => {
        try { return await this.validateSettings(value); }
        catch (error) {
          if (!value.audioPath) throw error;
          missing.push(path.basename(value.audioPath));
          return this.validateSettings({ ...value, audioPath: null, volume: value.volume === 0 ? 1 : value.volume });
        }
      };
      let next;
      if (document.kind === 'settings') {
        if (!this.state.source) throw new Error('Import a video first, then open the settings.');
        const draftSettings = await usable(restore(document.settings));
        next = { ...this.state, draftSettings };
      } else {
        if (this.jobs.size) throw new Error('Wait for rendering to finish before opening a project.');
        if (this.state.shorts.length && args.replace !== true) throw new Error('Opening a project replaces the shorts in this session. Set replace to true to confirm.');
        const current = this.state.source;
        const sourcePath = document.source?.path
          || (current && current.name === document.source?.name && Math.abs(current.duration - Number(document.source?.duration)) < 0.05 ? current.path : null);
        if (!sourcePath) throw new Error(`This project does not say where its video "${document.source?.name ?? ''}" is. Import that video with short_import_video, then open the project again.`);
        const source = await this.readSource(sourcePath);
        const duration = source.duration;
        next = { source, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0 };
        for (const short of Array.isArray(document.shorts) ? document.shorts : []) {
          next.shorts.push({ id: randomUUID(), name: String(short.name || `Short ${next.shorts.length + 1}`).slice(0, 200), ranges: ranges(short.ranges, duration), settings: await usable(restore(short.settings)), status: 'idle', progress: 0 });
        }
        next.selection = document.selection.length ? ranges(document.selection, duration) : [];
        next.draftSettings = await usable(restore(document.draftSettings));
        if (Number.isFinite(document.zoom) && document.zoom >= 1 && document.zoom <= 20) next.zoom = document.zoom;
      }
      await this.commitState(next, document.kind === 'project');
      return { ...this.snapshot(), document: { path: file, kind: document.kind, missingAudio: [...new Set(missing)] } };
    }
    if (name === 'short_clear') {
      // Everything in the session goes: renders in progress are stopped (their
      // temporary files are removed as they end); exported files stay on disk.
      for (const child of this.jobs.values()) child.kill();
      this.state = { source: null, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: this.state.revision };
      this.sourceEpoch = randomUUID();
    } else if (name === 'short_import_video') {
      if (this.jobs.size) throw new Error('Wait for rendering to finish before replacing the video.');
      if (this.state.shorts.length && args.replace !== true) throw new Error('Importing another video clears the shorts. Set replace to true to confirm.');
      await this.importSource(args.path);
    } else {
      if (!this.state.source) throw new Error('Import a video first.');
      const source = this.state.source;
      if (name === 'short_set_focus') {
        const short = args.id === undefined ? null : this.state.shorts.find(s => s.id === args.id);
        if (args.id !== undefined && !short) throw new Error('Short not found.');
        if (short?.status === 'rendering') throw new Error('Wait for this short to finish rendering.');
        const selected = short ? short.ranges : this.state.selection;
        if (!Number.isInteger(args.cutIndex) || args.cutIndex < 0 || args.cutIndex >= selected.length) throw new Error('Invalid cutIndex (zero-based).');
        const updated = focusRange(selected[args.cutIndex], (short?.settings ?? this.state.draftSettings).cropX, args);
        selected[args.cutIndex] = updated;
        if (short) Object.assign(short, { status: 'idle', progress: 0, outputPath: null, error: null });
      } else if (name === 'short_set_selection') {
        const selection = args.ranges?.length === 0 ? [] : ranges(args.ranges, source.duration);
        const nextSettings = args.settings ? await this.validateSettings(this.withSettings(this.state.draftSettings, args.settings)) : this.state.draftSettings;
        assertAnalysis();
        this.state.selection = selection; this.state.draftSettings = nextSettings;
        if (args.settings?.captions) for (const short of this.state.shorts) {
          if (short.status === 'rendering' || JSON.stringify(short.settings.captions) === JSON.stringify(nextSettings.captions)) continue;
          short.settings = { ...short.settings, captions: structuredClone(nextSettings.captions) };
          Object.assign(short, { status: 'idle', outputPath: null, error: null });
        }
      } else if (name === 'short_set_view') {
        if (args.zoom !== undefined && (!Number.isFinite(args.zoom) || args.zoom < 1 || args.zoom > 20)) throw new Error('Zoom must be between 1 and 20.');
        if (args.playhead !== undefined && (!Number.isFinite(args.playhead) || args.playhead < 0 || args.playhead > source.duration)) throw new Error('Playhead outside video.');
        if (args.zoom !== undefined) this.state.zoom = args.zoom;
        if (args.playhead !== undefined) this.state.playhead = args.playhead;
      } else if (name === 'short_create') {
        const selected = ranges(args.ranges ?? this.state.selection, source.duration);
        const config = await this.validateSettings(this.withSettings(this.state.draftSettings, args.settings));
        this.state.shorts.push({ id: randomUUID(), name: String(args.name || `Short ${this.state.shorts.length + 1}`).slice(0, 200), ranges: selected, settings: config, status: 'idle', progress: 0 });
        this.state.selection = [];
      } else {
        const short = this.state.shorts.find(s => s.id === args.id);
        if (!short) throw new Error('Short not found.');
        if (name === 'short_cancel_render') { this.jobs.get(short.id)?.kill(); return this.snapshot(); }
        if (short.status === 'rendering') throw new Error('Wait for this short to finish rendering.');
        if (name === 'short_delete') this.state.shorts = this.state.shorts.filter(s => s !== short);
        if (name === 'short_update') {
          const selected = args.ranges ? ranges(args.ranges, source.duration) : short.ranges;
          const config = await this.validateSettings(this.withSettings(short.settings, args.settings));
          assertAnalysis();
          Object.assign(short, { ranges: selected, settings: config, name: String(args.name ?? short.name).slice(0, 200), status: 'idle', outputPath: null, error: null });
        }
        if (name === 'short_render') {
          if (this.jobs.size >= 2) throw new Error('Two shorts are already rendering. Please wait.');
          await this.file(source.path);
          await this.validateSettings(short.settings);
          const { target, parent } = await this.newFile(args.outputPath, '.mp4');
          const temporary = path.join(parent, `.short-${randomUUID()}.mp4`);
          const ass = captionAss(short);
          const captionsFile = ass ? temporary + '.ass' : undefined;
          if (captionsFile) await fs.writeFile(captionsFile, ass, 'utf8');
          const { args: ffargs, duration } = renderArgs(source, short, temporary, captionsFile);
          Object.assign(short, { status: 'rendering', progress: 0, error: null });
          let pending = '';
          run(ffargs, data => {
            pending += data.toString();
            const lines = pending.split('\n'); pending = lines.pop();
            for (const line of lines) if (line.startsWith('out_time_us=')) short.progress = Math.min(99, Math.max(0, Number(line.slice(12)) / (duration * 10000)));
          }, child => this.jobs.set(short.id, child)).then(async () => {
            // Exclusive copy avoids overwriting a file created while rendering.
            await fs.copyFile(temporary, target, require('node:fs').constants.COPYFILE_EXCL);
            Object.assign(short, { status: 'done', progress: 100, outputPath: target });
          }).catch(e => { short.status = 'error'; short.error = e.message; }).finally(async () => {
            if (captionsFile) await fs.unlink(captionsFile).catch(() => {});
            await fs.unlink(temporary).catch(() => {}); this.jobs.delete(short.id);
            this.lane = this.lane.then(() => this.persist()).catch(() => {});
          });
        }
      }
    }
    await this.persist();
    return this.snapshot();
  }
}
module.exports = { ShortEditor, COMMANDS, READS, DOCUMENT_APP, capabilities, ranges, settings, renderArgs, cropExpression };

import { loadMediabunny } from '../../services/mediabunny/mediabunny-loader';
import type { VideoSample } from 'mediabunny';

/** One stretch of the source. `cropX` frames this stretch alone; without it the short's setting applies. */
/**
 * One stretch of the source. `cropX` frames it alone; `cropTrack` makes the frame
 * follow a person instead: points in seconds of the source, joined by straight lines.
 */
export interface ShortCut { start: number; end: number; cropX?: number; cropTrack?: { t: number; x: number }[]; follow?: ShortFollow; }
/** How the tracked frame was asked to move (kept so the path can be redrawn with the same choices). */
export interface ShortFollow { delays: boolean; startDelayMs: number; holdDelayMs: number; smoothness: 'abrupt' | 'slight' | 'smooth' | 'very'; }
function checkFollow(value: unknown): ShortFollow | undefined {
  if (value === undefined || value === null) return undefined;
  const follow = value as Partial<ShortFollow>;
  const ms = (n: unknown) => Number.isFinite(Number(n)) && Number(n) >= 0 && Number(n) <= 5000;
  if (typeof follow.delays !== 'boolean' || !ms(follow.startDelayMs) || !ms(follow.holdDelayMs) || !['abrupt', 'slight', 'smooth', 'very'].includes(String(follow.smoothness))) throw new Error('Invalid follow settings for a cut.');
  return { delays: follow.delays, startDelayMs: Number(follow.startDelayMs), holdDelayMs: Number(follow.holdDelayMs), smoothness: follow.smoothness as ShortFollow['smoothness'] };
}
/** The framing a followed stretch has at `time` (seconds of the source), held at the ends. */
export function cropAtTime(keys: readonly { t: number; x: number }[], time: number): number {
  if (!keys.length) return .5;
  if (time <= keys[0].t) return keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    if (time <= keys[i].t) {
      const from = keys[i - 1], to = keys[i];
      return from.x + (to.x - from.x) * ((time - from.t) / Math.max(1e-6, to.t - from.t));
    }
  }
  return keys[keys.length - 1].x;
}
function checkTrack(track: unknown): { t: number; x: number }[] | undefined {
  if (track === undefined || track === null) return undefined;
  if (!Array.isArray(track) || track.length > 3000) throw new Error('Invalid person tracking for a cut.');
  let previous = -Infinity;
  return track.map(key => {
    const t = Number(key?.t), x = Number(key?.x);
    if (!Number.isFinite(t) || !Number.isFinite(x) || x < 0 || x > 1 || t < previous) throw new Error('Invalid person tracking for a cut.');
    previous = t;
    return { t, x };
  });
}
/** `volume` is the original sound's level; `musicVolume` the chosen replacement's, mixed over it. */
/** `audioFadeOut`/`audioFadeIn`: seconds each cut's sound fades where a transition overlaps two cuts; null = a crossfade as long as the overlap; 0 = no fade. */
export interface ShortSettings { audioPath: string | null; volume: number; musicVolume: number; cropX: number; transition: string; transitionSeconds: number; audioFadeOut?: number | null; audioFadeIn?: number | null; }
export interface BrowserShort { id: string; name: string; ranges: ShortCut[]; settings: ShortSettings; status: string; progress: number; outputPath?: string; error?: string; }
export interface BrowserSession {
  source: { path: string; name: string; duration: number; filmstrip: string; waveformImage?: string; hasAudio: boolean } | null;
  selection: ShortCut[]; draftSettings: ShortSettings; shorts: BrowserShort[]; zoom: number; playhead: number; revision: number;
}
/** What the manual controls hand to {@link ShortBrowserEditor.command}. The web version is never driven by MCP. */
export interface ShortCommandArgs {
  replace?: boolean; file?: File; ranges?: ShortCut[]; settings?: Partial<ShortSettings>;
  zoom?: number; playhead?: number; name?: string; id?: string | null;
}
const defaults = (): ShortSettings => ({ audioPath: null, volume: 1, musicVolume: 1, cropX: .5, transition: 'cut', transitionSeconds: .3 });
const canceled = () => new DOMException('Render cancelled.', 'AbortError');
function checkCuts(value: ShortCut[], duration: number): ShortCut[] {
  if (!Array.isArray(value) || value.length > 100 || value.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end > duration + .001 || c.end - c.start < .1)) throw new Error('Cuts must last at least 0.1 s and fit inside the video.');
  if (value.some(c => c.cropX !== undefined && c.cropX !== null && (!Number.isFinite(c.cropX) || c.cropX < 0 || c.cropX > 1))) throw new Error('Invalid framing for a cut.');
  return value.map(c => {
    const cut: ShortCut = { start: c.start, end: Math.min(c.end, duration) };
    if (c.cropX !== undefined && c.cropX !== null) cut.cropX = c.cropX;
    const track = checkTrack(c.cropTrack);
    if (track?.length) cut.cropTrack = track;
    const follow = checkFollow(c.follow);
    if (follow) cut.follow = follow;
    return cut;
  });
}
function checkSettings(value: ShortSettings): ShortSettings {
  if (!['cut', 'fade', 'wipeleft', 'slideright'].includes(value.transition) || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 2 || !Number.isFinite(value.musicVolume) || value.musicVolume < 0 || value.musicVolume > 2 || !Number.isFinite(value.cropX) || value.cropX < 0 || value.cropX > 1 || !Number.isFinite(value.transitionSeconds) || value.transitionSeconds < .05 || value.transitionSeconds > 2) throw new Error('Invalid audio or transition settings.');
  for (const fade of [value.audioFadeOut, value.audioFadeIn]) {
    if (fade !== undefined && fade !== null && (!Number.isFinite(fade) || fade < 0 || fade > 2)) throw new Error('Invalid audio fade length.');
  }
  return { ...value };
}
interface Segment { cut: ShortCut; begin: number; end: number; }
function timeline(short: BrowserShort): { segments: Segment[]; duration: number } {
  const segments: Segment[] = [];
  let cursor = 0;
  short.ranges.forEach((cut, i) => {
    const previous = short.ranges[i - 1];
    const overlap = previous && short.settings.transition !== 'cut'
      ? Math.min(short.settings.transitionSeconds, (previous.end - previous.start) / 2, (cut.end - cut.start) / 2) : 0;
    const begin = cursor - overlap, end = begin + cut.end - cut.start;
    segments.push({ cut, begin, end }); cursor = end;
  });
  return { segments, duration: cursor };
}
function canvas(width: number, height: number): HTMLCanvasElement {
  const result = document.createElement('canvas'); result.width = width; result.height = height; return result;
}
function drawCrop(context: CanvasRenderingContext2D, sample: import('mediabunny').VideoSample, width: number, height: number, cropX: number) {
  const factor = Math.max(width / sample.displayWidth, height / sample.displayHeight);
  const drawWidth = sample.displayWidth * factor, drawHeight = sample.displayHeight * factor;
  sample.draw(context, (width - drawWidth) * cropX, (height - drawHeight) / 2, drawWidth, drawHeight);
}
function keyframeAt(segments: Segment[], time: number): { current: Segment; previous?: Segment; fraction: number } {
  const index = Math.max(0, segments.findIndex((segment, i) => time < segment.end || i === segments.length - 1));
  const current = segments[index], previous = index ? segments[index - 1] : undefined;
  const overlap = previous && time < previous.end ? previous.end - current.begin : 0;
  return { current, previous: overlap ? previous : undefined, fraction: overlap ? Math.max(0, Math.min(1, (time - current.begin) / overlap)) : 1 };
}
/** Where in the source a stretch is at `time` of the short (never past its own end). */
function sourceTime(segment: Segment, time: number): number {
  return Math.min(segment.cut.end - .001, segment.cut.start + time - segment.begin);
}
function audioAt(sound: Float32Array, localTime: number): [number, number] {
  const index = Math.floor(localTime * 48000) * 2;
  return index >= 0 && index + 1 < sound.length ? [sound[index], sound[index + 1]] : [0, 0];
}

export class ShortBrowserEditor {
  state: BrowserSession = { source: null, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: 0 };
  videoFile: File | null = null;
  audioFiles = new Map<string, File>();
  outputUrls: Record<string, string> = {};
  private jobs = new Map<string, AbortController>();
  constructor(private changed: () => void) {}
  snapshot(): BrowserSession { return structuredClone(this.state); }
  dispose() { for (const job of this.jobs.values()) job.abort(); for (const url of Object.values(this.outputUrls)) URL.revokeObjectURL(url); }
  async addAudio(file: File): Promise<string> {
    const library = await loadMediabunny();
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    try { if (!await input.getPrimaryAudioTrack()) throw new Error('The chosen file has no audio.'); }
    finally { input.dispose(); }
    const id = `${crypto.randomUUID()}/${file.name}`;
    this.audioFiles.set(id, file); return id;
  }
  private touch() { this.state.revision++; this.changed(); }
  async command(name: string, args: ShortCommandArgs = {}): Promise<BrowserSession> {
    if (name === 'short_get_state') return this.snapshot();
    if (name === 'short_clear') {
      // Everything in the session goes; renders in progress stop, downloads already saved stay.
      for (const job of this.jobs.values()) job.abort();
      for (const url of Object.values(this.outputUrls)) URL.revokeObjectURL(url);
      this.outputUrls = {}; this.audioFiles.clear(); this.videoFile = null;
      this.state = { source: null, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: this.state.revision };
    } else if (name === 'short_import_video') {
      if (this.jobs.size) throw new Error('Wait for rendering to finish before replacing the video.');
      if (this.state.shorts.length && !args.replace) throw new Error('Confirm replacing the video to discard the current shorts.');
      const file = args.file;
      if (!(file instanceof File)) throw new Error('Choose a video.');
      const source = await this.inspect(file);
      for (const url of Object.values(this.outputUrls)) URL.revokeObjectURL(url);
      this.outputUrls = {}; this.audioFiles.clear(); this.videoFile = file;
      this.state = { source, selection: [], draftSettings: defaults(), shorts: [], zoom: 1, playhead: 0, revision: this.state.revision };
    } else {
      const source = this.state.source;
      if (!source) throw new Error('Load a video first.');
      if (name === 'short_set_selection') {
        this.state.selection = checkCuts(args.ranges ?? [], source.duration);
        if (args.settings) this.state.draftSettings = checkSettings({ ...this.state.draftSettings, ...args.settings });
      } else if (name === 'short_set_view') {
        const zoom = args.zoom, playhead = args.playhead;
        if (zoom !== undefined) { if (!Number.isFinite(zoom) || zoom < 1 || zoom > 20) throw new Error('Zoom out of range.'); this.state.zoom = zoom; }
        if (playhead !== undefined) { if (!Number.isFinite(playhead) || playhead < 0 || playhead > source.duration) throw new Error('Playhead outside the video.'); this.state.playhead = playhead; }
      } else if (name === 'short_create') {
        const cuts = checkCuts(args.ranges ?? this.state.selection, source.duration);
        if (!cuts.length) throw new Error('Select at least one cut.');
        this.state.shorts.push({ id: crypto.randomUUID(), name: String(args.name || `Short ${this.state.shorts.length + 1}`).slice(0, 200), ranges: cuts, settings: checkSettings({ ...this.state.draftSettings, ...args.settings }), status: 'idle', progress: 0 });
        this.state.selection = [];
      } else {
        const short = this.state.shorts.find(item => item.id === args.id);
        if (!short) throw new Error('Short not found.');
        if (name === 'short_cancel_render') { this.jobs.get(short.id)?.abort(); return this.snapshot(); }
        if (short.status === 'rendering') throw new Error('Wait for this short to finish rendering.');
        if (name === 'short_delete') {
          if (short.outputPath) { URL.revokeObjectURL(this.outputUrls[short.outputPath]); delete this.outputUrls[short.outputPath]; }
          this.state.shorts = this.state.shorts.filter(item => item !== short);
        }
        else if (name === 'short_update') {
          const cuts = args.ranges ? checkCuts(args.ranges, source.duration) : short.ranges;
          if (!cuts.length) throw new Error('A short needs at least one cut.');
          if (short.outputPath) { URL.revokeObjectURL(this.outputUrls[short.outputPath]); delete this.outputUrls[short.outputPath]; }
          Object.assign(short, { ranges: cuts, settings: checkSettings({ ...short.settings, ...args.settings }), name: String(args.name ?? short.name).slice(0, 200), status: 'idle', outputPath: undefined, error: undefined });
        } else if (name === 'short_render') {
          if (this.jobs.size >= 2) throw new Error('Two shorts are already rendering. Please wait.');
          const controller = new AbortController(); this.jobs.set(short.id, controller);
          Object.assign(short, { status: 'rendering', progress: 0, error: undefined });
          void this.render(short, controller.signal).then(({ blob, extension }) => {
            if (controller.signal.aborted) throw canceled();
            const fileName = `${short.name.replace(/[<>:"/\\|?*]/g, '_') || 'short'}-${short.id.slice(0, 8)}.${extension}`;
            this.outputUrls[fileName] = URL.createObjectURL(blob);
            Object.assign(short, { outputPath: fileName, status: 'done', progress: 100 });
          }).catch(error => { short.status = 'error'; short.error = error instanceof Error ? error.message : String(error); })
            .finally(() => { this.jobs.delete(short.id); this.touch(); });
        } else throw new Error('Unknown command.');
      }
    }
    this.touch(); return this.snapshot();
  }

  private async inspect(file: File): Promise<NonNullable<BrowserSession['source']>> {
    const library = await loadMediabunny();
    const input = new library.Input({ source: new library.BlobSource(file), formats: library.ALL_FORMATS });
    try {
      if (!await input.canRead()) throw new Error('This browser cannot read this video.');
      const video = await input.getPrimaryVideoTrack(), audio = await input.getPrimaryAudioTrack();
      if (!video || !await video.canDecode()) throw new Error('This browser cannot decode this video.');
      const width = await video.getDisplayWidth(), height = await video.getDisplayHeight();
      if (width <= height) throw new Error('Choose a horizontal video.');
      const duration = await input.computeDuration();
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video has no valid duration.');
      // The timeline draws its own precise waveform (short-waveform.ts) and
      // only names the picture track, so no filmstrip or wave image is made here.
      return { path: file.name, name: file.name, duration, filmstrip: '', hasAudio: !!audio };
    } finally { input.dispose(); }
  }

  private async render(short: BrowserShort, signal: AbortSignal): Promise<{ blob: Blob; extension: string }> {
    const library = await loadMediabunny(), { segments, duration } = timeline(short);
    const width = 1080, height = 1920, frameRate = 30;
    const mp4 = await library.canEncodeVideo('avc', { width, height }) && await library.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 });
    const codec = mp4 ? { video: 'avc' as const, audio: 'aac' as const } : { video: 'vp9' as const, audio: 'opus' as const };
    if (!mp4 && (!await library.canEncodeVideo(codec.video, { width, height }) || !await library.canEncodeAudio(codec.audio, { numberOfChannels: 2, sampleRate: 48000 }))) throw new Error('This browser cannot encode vertical video. Update the browser or use the desktop app.');
    if (!this.videoFile) throw new Error('Load a video first.');
    const input = new library.Input({ source: new library.BlobSource(this.videoFile), formats: library.ALL_FORMATS });
    const readers: AsyncGenerator<VideoSample | null, void, unknown>[] = [];
    let complete = false;
    let output: InstanceType<typeof library.Output> | undefined;
    try {
      const picture = await input.getPrimaryVideoTrack(), originalAudio = await input.getPrimaryAudioTrack();
      if (!picture) throw new Error('The video lost its picture track.');
      const target = new library.BufferTarget();
      output = new library.Output({ format: mp4 ? new library.Mp4OutputFormat() : new library.WebMOutputFormat(), target });
      const surface = canvas(width, height), context = surface.getContext('2d', { alpha: false });
      if (!context) throw new Error('The vertical canvas could not be prepared.');
      const pictureSource = new library.CanvasSource(surface, { codec: codec.video, quality: new library.Quality('high'), keyFrameInterval: 2 });
      const soundSource = new library.AudioSampleSource({ codec: codec.audio, quality: new library.Quality('high'), transform: { numberOfChannels: 2, sampleRate: 48000 } });
      output.addVideoTrack(pictureSource); output.addAudioTrack(soundSource);
      await output.start();

      // Every output frame is planned first, so each stretch can be decoded
      // front to back by its own reader instead of seeking back to a keyframe
      // for every frame. At most two readers work at once (during a transition).
      const frames = Math.ceil(duration * frameRate), sink = new library.VideoSampleSink(picture);
      const plan = Array.from({ length: frames }, (_, frame) => keyframeAt(segments, frame / frameRate));
      const lastUse = new Map<Segment, number>();
      segments.forEach(segment => {
        const times: number[] = [];
        plan.forEach((scene, frame) => {
          if (scene.current !== segment && scene.previous !== segment) return;
          times.push(sourceTime(segment, frame / frameRate)); lastUse.set(segment, frame);
        });
        readers.push(sink.samplesAtTimestamps(times));
      });
      const reader = (segment: Segment) => readers[segments.indexOf(segment)];
      // A followed stretch moves its frame with the person; the others keep theirs.
      const cropOf = (segment: Segment, t: number) => segment.cut.cropTrack?.length
        ? cropAtTime(segment.cut.cropTrack, sourceTime(segment, t))
        : segment.cut.cropX ?? short.settings.cropX;
      let shown = -1;
      for (let frame = 0; frame < frames; frame++) {
        if (signal.aborted) throw canceled();
        const t = frame / frameRate, scene = plan[frame];
        context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
        if (scene.previous) await this.paintNext(reader(scene.previous), context, cropOf(scene.previous, t), width, height);
        if (scene.previous) {
          if (short.settings.transition === 'fade') context.globalAlpha = scene.fraction;
          else if (short.settings.transition === 'wipeleft') { context.save(); context.beginPath(); context.rect(0, 0, width * scene.fraction, height); context.clip(); }
          else if (short.settings.transition === 'slideright') context.translate(width * (1 - scene.fraction), 0);
        }
        await this.paintNext(reader(scene.current), context, cropOf(scene.current, t), width, height);
        if (scene.previous && short.settings.transition === 'wipeleft') context.restore();
        if (scene.previous && short.settings.transition === 'slideright') context.setTransform(1, 0, 0, 1, 0, 0);
        context.globalAlpha = 1;
        await pictureSource.add(t, 1 / frameRate);
        // A stretch that will not be drawn again gives its decoder back.
        for (const [segment, last] of lastUse) if (last === frame) await reader(segment).return(undefined);
        short.progress = Math.round((frame + 1) / frames * 78);
        if (short.progress !== shown) { shown = short.progress; this.changed(); }
      }

      const audioFile = short.settings.audioPath ? this.audioFiles.get(short.settings.audioPath) : this.videoFile;
      if (!audioFile) throw new Error('The chosen audio is no longer available. Choose the file again.');
      const own = audioFile === this.videoFile;
      // The original plays at `volume`; a chosen audio loops over it at `musicVolume`.
      const originalLevel = short.settings.volume, musicLevel = short.settings.musicVolume;
      const audioInput = own ? input : new library.Input({ source: new library.BlobSource(audioFile), formats: library.ALL_FORMATS });
      try {
        const musicTrack = own ? null : await audioInput.getPrimaryAudioTrack();
        // Only the stretches that are used are decoded: a long vlog never has
        // to fit in memory as raw audio.
        const pieces = new Map<Segment, Float32Array>();
        let loop = new Float32Array(0);
        if (originalAudio && originalLevel > 0) for (const segment of segments) pieces.set(segment, await this.readSound(library, originalAudio, segment.cut.start, segment.cut.end, signal));
        if (musicTrack) loop = await this.readSound(library, musicTrack, 0, Math.min(duration, await audioInput.computeDuration()), signal);
        const silent = new Float32Array(0);
        // Chosen fades at the overlaps: each cut's own sound fades, and the overlap is a plain sum.
        const fadeOut = short.settings.audioFadeOut, fadeIn = short.settings.audioFadeIn;
        const chosenFades = short.settings.transition !== 'cut' && (Number.isFinite(fadeOut) || Number.isFinite(fadeIn));
        const order = new Map(segments.map((segment, index) => [segment, index] as const));
        const gainOf = (segment: Segment, t: number) => {
          const index = order.get(segment) ?? 0, length = segment.end - segment.begin;
          let gain = 1;
          const inLength = index > 0 ? Math.min(fadeIn ?? 0, length) : 0, outLength = index < segments.length - 1 ? Math.min(fadeOut ?? 0, length) : 0;
          if (inLength > 0) gain *= Math.min(1, Math.max(0, (t - segment.begin) / inLength));
          if (outLength > 0) gain *= Math.min(1, Math.max(0, (segment.end - t) / outLength));
          return gain;
        };
        const loopSeconds = loop.length / 2 / 48000, total = Math.ceil(duration * 48000);
        for (let start = 0; start < total; start += 4096) {
          if (signal.aborted) throw canceled();
          const count = Math.min(4096, total - start);
          const values = new Float32Array(count * 2);
          for (let frame = 0; frame < count; frame++) {
            const t = (start + frame) / 48000;
            if (pieces.size) {
              const scene = keyframeAt(segments, t);
              const first = audioAt(pieces.get(scene.current) ?? silent, t - scene.current.begin);
              const second = scene.previous ? audioAt(pieces.get(scene.previous) ?? silent, t - scene.previous.begin) : [0, 0];
              if (chosenFades) {
                const currentGain = gainOf(scene.current, t), previousGain = scene.previous ? gainOf(scene.previous, t) : 0;
                for (let channel = 0; channel < 2; channel++) values[frame * 2 + channel] = (first[channel] * currentGain + second[channel] * previousGain) * originalLevel;
              } else for (let channel = 0; channel < 2; channel++) values[frame * 2 + channel] = (first[channel] * scene.fraction + second[channel] * (1 - scene.fraction)) * originalLevel;
            }
            if (loopSeconds) {
              const [left, right] = audioAt(loop, t % loopSeconds);
              values[frame * 2] += left * musicLevel; values[frame * 2 + 1] += right * musicLevel;
            }
          }
          const sample = new library.AudioSample({ data: values, format: 'f32', numberOfChannels: 2, sampleRate: 48000, timestamp: start / 48000 });
          try { await soundSource.add(sample); } finally { sample.close(); }
          short.progress = 78 + Math.round((start + count) / total * 20);
          if (short.progress !== shown) { shown = short.progress; this.changed(); }
        }
      } finally { if (audioInput !== input) audioInput.dispose(); }
      if (signal.aborted) throw canceled();
      await output.finalize(); complete = true;
      if (!target.buffer) throw new Error('The video could not be finished.');
      return { blob: new Blob([target.buffer], { type: mp4 ? 'video/mp4' : 'video/webm' }), extension: mp4 ? 'mp4' : 'webm' };
    } finally {
      for (const item of readers) await item.return(undefined).catch(() => undefined);
      if (!complete && output) await output.cancel().catch(() => {});
      input.dispose();
    }
  }
  private async paintNext(reader: AsyncGenerator<VideoSample | null, void, unknown>, context: CanvasRenderingContext2D, cropX: number, width: number, height: number) {
    const { value: sample } = await reader.next();
    if (sample) { try { drawCrop(context, sample, width, height, cropX); } finally { sample.close(); } }
  }
  /** The audio between `start` and `end`, as 48 kHz interleaved stereo that begins at `start`. */
  private async readSound(library: Awaited<ReturnType<typeof loadMediabunny>>, track: import('mediabunny').InputAudioTrack, start: number, end: number, signal: AbortSignal): Promise<Float32Array> {
    const result = new Float32Array(Math.max(0, Math.ceil((end - start) * 48000)) * 2);
    const sink = new library.AudioSampleSink(track);
    for await (const sample of sink.samples(start, end)) {
      try {
        if (signal.aborted) throw canceled();
        const channels = sample.numberOfChannels, data = new Float32Array(sample.numberOfFrames * channels);
        sample.copyTo(data, { planeIndex: 0, format: 'f32' });
        const first = Math.max(0, Math.ceil((sample.timestamp - start) * 48000));
        const last = Math.min(result.length / 2, Math.floor((sample.timestamp + sample.duration - start) * 48000));
        for (let i = first; i < last; i++) {
          const source = Math.min(sample.numberOfFrames - 1, Math.max(0, Math.floor((i / 48000 + start - sample.timestamp) * sample.sampleRate)));
          result[i * 2] = data[source * channels]; result[i * 2 + 1] = data[source * channels + Math.min(1, channels - 1)];
        }
      } finally { sample.close(); }
    }
    return result;
  }
}

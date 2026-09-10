/**
 * Plays the timeline on screen, without rendering it first.
 *
 * The export decides everything ahead of time and then walks the plan; this
 * does the same walk against a wall clock. One `<video>` element decodes
 * whichever clip is on screen, an independent `<audio>` element carries either
 * its original sound or a supplied soundtrack, and every frame is composed through the same
 * {@link composeFrame} the encoder uses — so a zoom, a caption or a fade that
 * looks wrong here is wrong in the file too, which is the entire point of
 * having a preview.
 *
 * What it deliberately does not do is pretend to be the export. Volume
 * levelling is measured from an analysis and applied sample by sample, which is
 * not something a media element can be asked to do, so the preview plays the
 * clips at their own levels and says so. Everything else — the cuts, the speed,
 * the fades, the zooms, the captions, the replaced and continued sound — is
 * exactly what will be written.
 *
 * The clock is authoritative, not the video element. Output time advances with
 * real time; the source position it implies is computed for each frame and the
 * decoder is nudged onto it whenever the two have drifted apart or a cut has
 * been crossed. Letting the element lead instead would mean the picture decided
 * where the edit was, and a single stalled seek would desynchronise everything
 * after it.
 */

import { drawFrame } from '../criador-de-video-texto/text-scene-renderer';
import { fontStack } from '../criador-de-video-texto/text-video-presets';
import type { SceneBackground, TextScene } from '../criador-de-video-texto/text-video.models';
import { FrameSource, canvasOfSize, composeFrame } from './frame-compositor';
import { clampSpeed, volumeGain } from './video-editor-defaults';
import { clipIndexAt, fadeGainAt, sourceTimeAt, transitionAt } from './video-editor-timeline';
import { TransitionPainter } from './video-transitions';
import { ClipPlan, ProjectPlan, isMediaClip } from './video-editor.models';

/** Widest the preview is composed at. Beyond this it costs more than it shows. */
const PREVIEW_WIDTH = 960;

/** How far the decoder may wander from the clock before it is pulled back. */
const DRIFT_SECONDS = 0.25;

/**
 * How early the shot arriving at a join starts loading.
 *
 * Long enough for a seek and a first decoded frame on a slow machine, short
 * enough that a timeline of many joins is not holding two decoders open for most
 * of its length.
 */
const PREMOUNT_SECONDS = 0.8;

/** Longer than this and a stalled seek is treated as a seek that will not finish. */
const MOUNT_TIMEOUT = 8000;

export interface PlayerElements {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;
  /**
   * A second decoder, used only for the shot arriving during a transition.
   *
   * Optional so the player still works where the page has not supplied one —
   * a join then draws the incoming side as black rather than failing. One
   * element cannot show two clips, and a transition is precisely the moment
   * that matters.
   */
  videoB?: HTMLVideoElement;
  audio: HTMLAudioElement;
}

export interface PlayerCallbacks {
  /** Called on every drawn frame, so the page can follow the playhead. */
  onTick: (time: number, clipIndex: number) => void;
  onEnded: () => void;
}

export class TimelinePlayer {
  private plan: ProjectPlan | null = null;
  private time = 0;
  private running = false;
  private raf = 0;
  private lastNow = 0;

  /** Index of the clip the elements are currently set up for. */
  private mounted = -1;
  /** Which kept range of that clip the decoder was last aimed at. */
  private mountedRange = -1;
  /** True while a source is being loaded; the clock waits rather than skipping. */
  private mounting = false;

  /** Which clip the independent audio element is currently carrying. */
  private audioMounted = -1;
  /** True while the audio source is changing; the clock waits with the picture. */
  private audioMounting = false;
  /** The actual warm-up operations, so Play can wait for frame and sound. */
  private mountTask: Promise<void> | null = null;
  private audioMountTask: Promise<void> | null = null;

  /**
   * A silence cut is one coordinated seek, never two decoders independently
   * chasing a clock that kept moving while they were looking for a keyframe.
   */
  private cutSyncing = false;

  /** Which clip the second decoder is set up for, for the join ahead. */
  private incoming = -1;
  /**
   * True while the second decoder is loading.
   *
   * Deliberately *not* `mounting`: that flag stops the clock, and stopping the
   * clock is the one thing a transition must never do. Loading the incoming shot
   * early is a best effort — if it is not ready the join opens onto black for a
   * frame or two, which is a great deal better than the playhead freezing in the
   * middle of the animation.
   */
  private incomingMounting = false;
  private readonly painter = new TransitionPainter();

  /**
   * How wide the canvas is composed, before the plan's own size caps it.
   *
   * A pane needs far fewer pixels than the export has, and drawing 4K sixty
   * times a second for a picture two inches across is the whole frame budget
   * spent on nothing. On the whole screen the opposite is true, so the host
   * raises this and the picture is composed at a size worth looking at.
   */
  private maxWidth = PREVIEW_WIDTH;
  private width = PREVIEW_WIDTH;
  private height = Math.round((PREVIEW_WIDTH * 9) / 16);
  private context: CanvasRenderingContext2D | null = null;

  /** Object URLs, one per file, reused across mounts and revoked together. */
  private readonly urls = new Map<File, string>();
  private readonly bitmaps = new Map<string, ImageBitmap>();
  /** File behind each bitmap, so replacing a background cannot reuse stale pixels. */
  private readonly bitmapFiles = new Map<string, File>();
  private scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
  /** A second one, for the incoming side of a join. See `scratchCanvas`. */
  private scratchIncoming: OffscreenCanvas | HTMLCanvasElement | null = null;

  /**
   * The media element's `volume` stops at 1, while the editor intentionally
   * offers up to 200%. Web Audio supplies the same linear gain the renderer
   * applies to samples, so the preview does not silently flatten every value
   * above 100%.
   */
  private audioContext: AudioContext | null = null;
  private audioGain: GainNode | null = null;

  constructor(
    private readonly elements: PlayerElements,
    private readonly callbacks: PlayerCallbacks
  ) {
    this.context = elements.canvas.getContext('2d');
    elements.video.muted = true;
    elements.video.playsInline = true;
    elements.video.preload = 'auto';
    elements.audio.preload = 'auto';
    this.disablePitchPreservation(elements.audio);

    if (elements.videoB) {
      // Always silent. The sound of a join comes from the outgoing shot, exactly
      // as it does in the export; two elements playing at once would be the one
      // place the preview and the file disagreed.
      elements.videoB.muted = true;
      elements.videoB.playsInline = true;
      elements.videoB.preload = 'auto';
    }
  }

  get playing(): boolean {
    return this.running;
  }

  get currentTime(): number {
    return this.time;
  }

  get duration(): number {
    return this.plan?.totalDuration ?? 0;
  }

  get clipIndex(): number {
    return this.plan ? clipIndexAt(this.plan, this.time) : -1;
  }

  /**
   * Takes a new plan, keeping the playhead where it is.
   *
   * Settings change while the preview is open — that is what the panel under it
   * is for — so the plan is replaced constantly. The playhead survives because
   * losing your place every time you nudge a slider makes the preview useless
   * for the one thing it is for: checking what a change did.
   */
  setPlan(plan: ProjectPlan): void {
    const previous = this.plan?.clips[this.mounted] ?? null;
    const previousSound = this.plan?.clips[this.audioMounted] ?? null;
    this.plan = plan;
    this.resize(plan);
    this.discardStaleBitmaps(plan);
    this.time = Math.min(this.time, Math.max(0, plan.totalDuration));

    // Only a change that moves the picture is worth a remount. Most edits made
    // with the preview open do not — typing a caption is the obvious one, and
    // re-seeking the decoder on every keystroke would make the field unusable.
    if (!this.stillValid(previous, plan.clips[this.mounted] ?? null)) {
      this.mounted = -1;
      this.mountedRange = -1;
    }

    if (!this.soundStillValid(previousSound, plan.clips[this.audioMounted] ?? null)) {
      this.audioMounted = -1;
      this.elements.audio.pause();
    }

    // The second decoder is always invalidated, whatever the first one decides.
    // It is remembered by *position*, and a clip deleted or dragged elsewhere
    // moves every position after it — so keeping it would mean the next join
    // compositing a shot the reader has just taken off the timeline.
    this.incoming = -1;
    this.elements.videoB?.pause();

    this.draw();
  }

  /** True when the clip at the playhead is the same one, timed the same way. */
  private stillValid(previous: ClipPlan | null, next: ClipPlan | null): boolean {
    if (!previous || !next || previous.clip !== next.clip) return false;
    const bitmapFile = this.bitmapFile(next);

    return (
      previous.outputStart === next.outputStart &&
      previous.outputDuration === next.outputDuration &&
      previous.edits.speed === next.edits.speed &&
      this.sameRanges(previous, next) &&
      (bitmapFile === null || this.bitmapFiles.get(next.clip.id) === bitmapFile)
    );
  }

  /** True when the independently mounted soundtrack still describes the same source. */
  private soundStillValid(previous: ClipPlan | null, next: ClipPlan | null): boolean {
    if (!previous || !next || previous.clip !== next.clip || previous.sound.kind !== next.sound.kind) return false;
    if (
      previous.outputStart !== next.outputStart ||
      previous.outputDuration !== next.outputDuration ||
      previous.edits.speed !== next.edits.speed ||
      !this.sameRanges(previous, next)
    ) {
      return false;
    }

    if (previous.sound.kind === 'file' && next.sound.kind === 'file') {
      return previous.sound.file === next.sound.file && previous.sound.offset === next.sound.offset;
    }

    return true;
  }

  private sameRanges(previous: ClipPlan, next: ClipPlan): boolean {
    return (
      previous.keepRanges.length === next.keepRanges.length &&
      previous.keepRanges.every(
        (range, index) => range.start === next.keepRanges[index].start && range.end === next.keepRanges[index].end
      )
    );
  }

  async play(): Promise<void> {
    if (!this.plan || this.running) return;
    if (this.time >= this.plan.totalDuration - 1e-3) this.time = 0;

    this.ensureAudioGain();
    await this.audioContext?.resume().catch(() => undefined);

    // `setPlan` draws immediately and therefore often starts both mounts just
    // before the reader presses Play. Starting the wall clock while those
    // seeks are still in flight makes the decoder chase a moving target: audio
    // runs cleanly, while the picture is repeatedly re-seeked and appears as
    // skipped frames. Warm the exact instant first, then start one clock.
    this.draw();
    await Promise.all([this.mountTask, this.audioMountTask]);
    if (!this.plan) return;

    this.running = true;
    // `play()` resolves only when the browser has actually started the media.
    // Starting the project clock before that promise settles is especially
    // visible at time zero, where neither decoder has any buffered runway yet.
    await this.startMountedMedia();
    if (!this.running || !this.plan) return;
    this.lastNow = performance.now();
    this.loop();
  }

  pause(): void {
    this.running = false;
    this.elements.video.pause();
    this.elements.videoB?.pause();
    this.elements.audio.pause();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  toggle(): void {
    if (this.running) this.pause();
    else void this.play();
  }

  /**
   * Composes at a different size from now on.
   *
   * Followed by an immediate redraw, because the canvas has just been resized
   * and until something is drawn on it, it is blank — which on the way into
   * full screen is a black flash exactly where the reader is looking.
   */
  setMaxWidth(width: number): void {
    const wanted = Math.max(160, Math.round(width));
    if (wanted === this.maxWidth) return;

    this.maxWidth = wanted;
    if (this.plan) {
      this.resize(this.plan);
      this.draw();
    }
  }

  seek(time: number): void {
    if (!this.plan) return;
    this.time = Math.max(0, Math.min(time, this.plan.totalDuration));
    // Forcing a remount rather than only moving the decoder: a seek may land in
    // a different clip, and even inside the same one it usually lands in a
    // different kept range.
    this.mounted = -1;
    this.mountedRange = -1;
    this.audioMounted = -1;
    this.elements.audio.pause();
    // And the second decoder with it: after a scrub it is almost certainly aimed
    // at the wrong instant, and the drift check would not notice until a quarter
    // of a second into the join it was supposed to open cleanly.
    this.incoming = -1;
    this.elements.videoB?.pause();
    this.draw();
  }

  dispose(): void {
    this.pause();
    this.elements.video.removeAttribute('src');
    this.elements.video.load();
    this.elements.videoB?.removeAttribute('src');
    this.elements.videoB?.load();
    this.incoming = -1;
    this.elements.audio.removeAttribute('src');
    this.elements.audio.load();
    this.audioMounted = -1;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.audioGain = null;

    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    for (const bitmap of this.bitmaps.values()) bitmap.close();
    this.bitmaps.clear();
    this.bitmapFiles.clear();
  }

  // ------------------------------------------------------------- the clock

  private loop = (): void => {
    if (!this.running || !this.plan) return;

    const now = performance.now();
    const elapsed = (now - this.lastNow) / 1000;
    this.lastNow = now;

    // While a source is loading the clock holds still. Letting it run would
    // silently skip whatever the decoder was not ready to show.
    if (!this.mounting && !this.audioMounting && !this.cutSyncing) this.time += elapsed;

    if (this.time >= this.plan.totalDuration) {
      this.time = this.plan.totalDuration;
      this.pause();
      this.draw();
      this.callbacks.onEnded();
      return;
    }

    this.draw();
    this.raf = requestAnimationFrame(this.loop);
  };

  // ------------------------------------------------------------ the frame

  private draw(): void {
    const plan = this.plan;
    const context = this.context;
    if (!plan || !context || !plan.clips.length) return;

    const index = clipIndexAt(plan, this.time);
    const entry = plan.clips[index];
    if (!entry) return;

    // Picture and sound can hand over at different instants during a join.
    // Keeping this decision independent is what makes the preview agree with
    // the renderer's `soundSwitch` instead of following the outgoing picture.
    const join = transitionAt(plan, this.time);
    const soundIndex = join && this.time >= join.soundSwitch ? join.toIndex : index;
    const soundEntry = plan.clips[soundIndex] ?? entry;

    if (index !== this.mounted && !this.mounting) {
      this.mounting = true;
      const task = this.mount(index).finally(() => {
        if (this.mountTask === task) this.mountTask = null;
        this.mounting = false;
      });
      this.mountTask = task;
    }

    if (this.mounted === index) this.follow(entry);

    if (soundIndex !== this.audioMounted && !this.audioMounting) {
      this.elements.audio.pause();
      this.audioMounting = true;
      const task = this.mountAudio(soundIndex).finally(() => {
        if (this.audioMountTask === task) this.audioMountTask = null;
        this.audioMounting = false;
      });
      this.audioMountTask = task;
    }
    if (this.audioMounted === soundIndex && !this.cutSyncing) this.followAudio(soundEntry);

    // The join happening now, or the one close enough that its incoming shot
    // should already be loading. Loading it late is what makes a transition open
    // onto black, so the decoder is given a head start rather than being asked
    // for a picture at the instant it is needed.
    const soon =
      join ??
      plan.transitions.find(
        (candidate) => candidate.start > this.time && candidate.start - this.time < PREMOUNT_SECONDS
      ) ??
      null;

    if (soon && this.incoming !== soon.toIndex && !this.incomingMounting) {
      this.incomingMounting = true;
      void this.mountIncoming(soon.toIndex).finally(() => {
        this.incomingMounting = false;
      });
    } else if (!soon && this.incoming >= 0 && !this.incomingMounting) {
      // No join in sight. Left running, the hidden decoder would keep decoding
      // for the rest of the timeline — for a picture nothing is drawing.
      this.elements.videoB?.pause();
      this.incoming = -1;
    }

    this.applyGain(plan);

    if (join) {
      // Both sides taken from the join rather than from `index`: during an
      // overlap `clipIndexAt` answers with the outgoing shot, and relying on
      // that would make the whole animation depend on a tie-break.
      const outgoing = plan.clips[join.fromIndex] ?? entry;
      const arriving = plan.clips[join.toIndex] ?? null;
      if (arriving) this.followIncoming(arriving);

      // Only once the second decoder is actually aimed at this shot. It is
      // remembered by position, and a clip deleted or dragged elsewhere moves
      // every position after it — so without this the join composites whatever
      // the element still happens to be holding, which is often the clip the
      // reader has just taken off the timeline.
      const ready = this.incoming === join.toIndex;

      composeFrame(context, plan, this.time, this.width, this.height, this.sourceFor(outgoing), {
        entry: join,
        incoming: arriving && ready ? this.sourceFor(arriving, this.elements.videoB ?? null) : null,
        painter: this.painter
      });
    } else {
      composeFrame(context, plan, this.time, this.width, this.height, this.sourceFor(entry));
    }

    this.callbacks.onTick(this.time, index);
  }

  /**
   * Rides the volume of both elements the way the encoder rides the samples.
   *
   * The clip's fade takes everything down, picture and sound together, which is
   * what the compositor is already doing to the frame. The soundtrack's own
   * ramps apply to the supplied file alone, so they reach the `<audio>` element
   * and never the clip's own sound — the same split the export makes.
   */
  private applyGain(plan: ProjectPlan): void {
    // `audioFades` rather than `fades`, exactly as the encoder does it: a clip
    // whose soundtrack is carrying on from the one before contributes no ramp
    // here, so the music plays through the cut while the picture still dips.
    const clipGain = fadeGainAt(plan.audioFades, this.time);
    const sound = plan.clips[this.audioMounted]?.sound;
    const trackGain = sound?.kind === 'file' && plan.soundFades.length ? fadeGainAt(plan.soundFades, this.time) : 1;

    // The clip's own volume, from the clip being *heard* rather than the one
    // being seen: during a join the picture has already changed hands and the
    // sound has not, and taking this from the visible clip would apply the
    // arriving clip's setting to the outgoing clip's sound.
    const heard = plan.clips[this.audioMounted] ?? plan.clips[this.mounted];
    const own = heard ? volumeGain(heard.edits) : 1;

    const { video, audio } = this.elements;
    // Assigned only on a real change: writing `volume` on every animation frame
    // makes some browsers fire a `volumechange` event sixty times a second.
    const wanted = Math.max(0, Math.min(1, clipGain * own));
    if (Math.abs(video.volume - wanted) > 0.001) video.volume = wanted;

    const track = Math.max(0, clipGain * trackGain * own);
    if (this.audioGain) {
      if (Math.abs(this.audioGain.gain.value - track) > 0.001) this.audioGain.gain.value = track;
      if (audio.volume !== 1) audio.volume = 1;
    } else {
      // Fallback for a browser without Web Audio. Values through 100% remain
      // exact; amplification above that is the only unavailable operation.
      const fallback = Math.min(1, track);
      if (Math.abs(audio.volume - fallback) > 0.001) audio.volume = fallback;
    }
  }

  /** Connects the one soundtrack element to an unclamped gain stage once. */
  private ensureAudioGain(): void {
    if (this.audioContext) return;
    const AudioContextCtor = globalThis.AudioContext;
    if (!AudioContextCtor) return;

    try {
      const context = new AudioContextCtor();
      const source = context.createMediaElementSource(this.elements.audio);
      const gain = context.createGain();
      source.connect(gain);
      gain.connect(context.destination);
      this.audioContext = context;
      this.audioGain = gain;
    } catch {
      // The element remains directly audible; `applyGain` uses its native
      // volume control as the conservative fallback.
    }
  }

  /** Keeps the decoder on the position the clock says it should be at. */
  private follow(entry: ClipPlan): void {
    const clip = entry.clip;
    if (!isMediaClip(clip) || clip.summary.kind === 'image') return;

    const { rangeIndex, sourceTime } = sourceTimeAt(entry, this.time);
    const video = this.elements.video;
    if (!Number.isFinite(video.duration)) return;

    // A new kept range means a cut: the decoder is sent to the far side of it
    // rather than being allowed to play through what was removed.
    if (rangeIndex !== this.mountedRange) {
      this.beginCutSync(entry, rangeIndex, sourceTime);
      return;
    }

    if (!video.seeking && Math.abs(video.currentTime - sourceTime) > DRIFT_SECONDS) {
      video.currentTime = sourceTime;
    }
    if (this.running && !this.cutSyncing && video.paused) void video.play().catch(() => undefined);
  }

  /**
   * Moves picture and original sound across one removed range as a unit.
   *
   * A supplied soundtrack is paused but not sought: it follows output time and
   * therefore has no hole to jump. Original sound follows source time, so it is
   * sought to the same surviving frame as the picture. The project clock waits
   * for both and resumes only after both decoders report a usable instant.
   */
  private beginCutSync(entry: ClipPlan, rangeIndex: number, sourceTime: number): void {
    if (this.cutSyncing || !this.running) return;

    const plan = this.plan;
    if (!plan) return;

    const video = this.elements.video;
    const audio = this.elements.audio;
    this.cutSyncing = true;
    video.pause();
    audio.pause();

    video.currentTime = Math.max(0, sourceTime);
    const waits: Promise<void>[] = [this.seekSettled(video)];

    const heard = plan.clips[this.audioMounted];
    if (heard?.sound.kind === 'original') {
      const target = this.audioTarget(heard);
      if (target) {
        audio.currentTime = Math.max(0, target.time);
        waits.push(this.seekSettled(audio));
      }
    }

    void Promise.all(waits).then(() => {
      // A seek or settings change may have replaced the plan while these media
      // operations were in flight. Such an old completion owns no player state.
      if (this.plan !== plan || this.mounted < 0) {
        this.cutSyncing = false;
        return;
      }

      this.mountedRange = rangeIndex;
      this.cutSyncing = false;
      this.lastNow = performance.now();
      if (this.running) void this.startMountedMedia();
    });
  }

  /** Starts only the media already prepared for the current timeline instant. */
  private async startMountedMedia(): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const starts: Promise<void>[] = [];

    const picture = plan.clips[this.mounted];
    if (picture && isMediaClip(picture.clip) && picture.clip.summary.kind !== 'image') {
      starts.push(this.elements.video.play().catch(() => undefined));
    }

    if (this.audioMounted >= 0 && this.audioTarget(plan.clips[this.audioMounted])) {
      starts.push(this.elements.audio.play().catch(() => undefined));
    }

    await Promise.all(starts);
  }

  /** What to draw underneath the zoom, the caption and the fade. */
  private sourceFor(entry: ClipPlan, element: HTMLVideoElement | null = this.elements.video): FrameSource | null {
    const clip = entry.clip;
    const context = this.context;
    if (!context) return null;

    if (!isMediaClip(clip)) {
      const scene = this.buildScene(entry);
      if (!scene) return null;

      // Two scratch canvases, chosen by which side of a join this is. With one,
      // a transition between two text cards drew the second card into it twice —
      // both `FrameSource`s closed over the same pixels — and the join appeared
      // to do nothing at all.
      const scratch = this.scratchCanvas(element === this.elements.video ? 'main' : 'incoming');
      const sceneContext = scratch.getContext('2d') as CanvasRenderingContext2D | null;
      if (!sceneContext) return null;

      const speed = clampSpeed(entry.edits.speed);
      drawFrame(sceneContext, scene, (this.time - entry.outputStart) * speed);

      return {
        draw: (target, x, y, width, height) => target.drawImage(scratch as CanvasImageSource, x, y, width, height),
        width: this.width,
        height: this.height
      };
    }

    if (clip.summary.kind === 'image') {
      const bitmap = this.bitmaps.get(clip.id);
      if (!bitmap) return null;
      return {
        draw: (target, x, y, width, height) => target.drawImage(bitmap, x, y, width, height),
        width: bitmap.width,
        height: bitmap.height
      };
    }

    const video = element;
    // An audio-only clip has a decoder but no picture, and plays over black.
    // So does a second decoder that has not finished loading.
    if (!video || !video.videoWidth || !video.videoHeight) return null;

    return {
      draw: (target, x, y, width, height) => target.drawImage(video, x, y, width, height),
      width: video.videoWidth,
      height: video.videoHeight
    };
  }

  // ---------------------------------------------------------- the mounting

  /** Points the picture element at whatever this clip needs, and waits for it. */
  private async mount(index: number): Promise<void> {
    const plan = this.plan;
    if (!plan) return;

    const entry = plan.clips[index];
    if (!entry) return;

    const clip = entry.clip;
    const video = this.elements.video;

    if (isMediaClip(clip) && clip.summary.kind !== 'image') {
      const url = this.urlFor(clip.file);
      if (video.src !== url) {
        video.src = url;
        await this.settled(video);
      }

      if (this.plan !== plan) return;

      video.playbackRate = clampSpeed(entry.edits.speed);
      video.muted = true;

      const { rangeIndex, sourceTime } = sourceTimeAt(entry, this.time);
      this.mountedRange = rangeIndex;
      video.currentTime = sourceTime;
      await this.seekSettled(video);
      if (this.plan !== plan) return;
      if (this.running) await video.play().catch(() => undefined);
    } else {
      video.pause();
      const bitmapFile = this.bitmapFile(entry);
      if (bitmapFile) await this.ensureBitmap(clip.id, bitmapFile);
    }

    if (this.plan !== plan) return;

    this.mounted = index;
    this.lastNow = performance.now();

    // Paused, nothing is drawing, and the frame on screen is still the one from
    // before the seek — so the last step of a mount is to show what it loaded.
    if (!this.running) this.draw();
  }

  /** Mounts either a supplied track or the clip's original sound. */
  private async mountAudio(index: number): Promise<void> {
    const plan = this.plan;
    const entry = plan?.clips[index];
    if (!plan || !entry) return;

    const audio = this.elements.audio;
    const target = this.audioTarget(entry);
    if (!target) {
      audio.pause();
      if (this.plan === plan) this.audioMounted = index;
      return;
    }

    const url = this.urlFor(target.file);
    if (audio.src !== url) {
      audio.src = url;
      await this.settled(audio);
    }
    if (this.plan !== plan) return;

    audio.playbackRate = target.rate;
    audio.currentTime = Math.max(0, target.time);
    await this.seekSettled(audio);
    if (this.plan !== plan) return;
    this.audioMounted = index;
    this.lastNow = performance.now();
    if (this.running) await audio.play().catch(() => undefined);
  }

  /** Keeps the independent sound decoder on the output clock. */
  private followAudio(entry: ClipPlan): void {
    const target = this.audioTarget(entry);
    const audio = this.elements.audio;
    if (!target) {
      if (!audio.paused) audio.pause();
      return;
    }

    if (audio.playbackRate !== target.rate) audio.playbackRate = target.rate;
    if (!audio.seeking && Number.isFinite(audio.duration) && Math.abs(audio.currentTime - target.time) > DRIFT_SECONDS) {
      audio.currentTime = Math.max(0, target.time);
    }
    if (this.running && !this.cutSyncing && audio.paused) void audio.play().catch(() => undefined);
  }

  private audioTarget(entry: ClipPlan): { file: File; time: number; rate: number } | null {
    if (entry.sound.kind === 'file') {
      return {
        file: entry.sound.file,
        time: entry.sound.offset + Math.max(0, this.time - entry.outputStart),
        rate: 1
      };
    }

    const clip = entry.clip;
    if (
      entry.sound.kind !== 'original' ||
      !isMediaClip(clip) ||
      clip.summary.kind === 'image' ||
      !clip.summary.audioUsable
    ) {
      return null;
    }

    return {
      file: clip.file,
      time: sourceTimeAt(entry, this.time).sourceTime,
      rate: clampSpeed(entry.edits.speed)
    };
  }

  /**
   * Points the second decoder at the shot a join is about to arrive at.
   *
   * A cut-down `mount`: no sound, no `mounted` bookkeeping, and above all it
   * never sets `mounting`, because the clock must keep running. A still or a
   * text card needs no element at all — only its bitmap, which is decoded here so
   * the join does not have to wait for it either.
   */
  private async mountIncoming(index: number): Promise<void> {
    const plan = this.plan;
    const entry = plan?.clips[index];
    if (!plan || !entry) return;

    const clip = entry.clip;
    const video = this.elements.videoB;

    if (isMediaClip(clip) && clip.summary.kind !== 'image') {
      if (!video) return;

      const url = this.urlFor(clip.file);
      if (video.src !== url) {
        video.src = url;
        await this.settled(video);
      }

      if (this.plan !== plan) return;

      video.playbackRate = clampSpeed(entry.edits.speed);
      video.currentTime = sourceTimeAt(entry, Math.max(this.time, entry.outputStart)).sourceTime;
      if (this.running) await video.play().catch(() => undefined);
    } else {
      video?.pause();
      const bitmapFile = this.bitmapFile(entry);
      if (bitmapFile) await this.ensureBitmap(clip.id, bitmapFile);
    }

    if (this.plan !== plan) return;
    this.incoming = index;
  }

  /** Keeps the second decoder on the instant the join says it should be at. */
  private followIncoming(entry: ClipPlan): void {
    const clip = entry.clip;
    const video = this.elements.videoB;
    if (!video || !isMediaClip(clip) || clip.summary.kind === 'image') return;
    if (this.incoming !== this.plan?.clips.indexOf(entry)) return;
    if (!Number.isFinite(video.duration)) return;

    const { sourceTime } = sourceTimeAt(entry, this.time);
    if (Math.abs(video.currentTime - sourceTime) > DRIFT_SECONDS) video.currentTime = sourceTime;
    if (this.running && video.paused) void video.play().catch(() => undefined);
  }

  /** Resolves once the element has data, or once waiting stops being useful. */
  private settled(element: HTMLMediaElement): Promise<void> {
    if (element.readyState >= 2) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        element.removeEventListener('loadeddata', finish);
        element.removeEventListener('error', finish);
        resolve();
      };

      const timer = setTimeout(finish, MOUNT_TIMEOUT);
      element.addEventListener('loadeddata', finish);
      element.addEventListener('error', finish);
    });
  }

  /** Waits for an assigned media time to become a drawable/playable instant. */
  private seekSettled(element: HTMLMediaElement): Promise<void> {
    // HAVE_CURRENT_DATA (2) only promises the frame under the playhead. At the
    // start of a file that produced a perfect still followed by immediate
    // starvation; HAVE_FUTURE_DATA (3) is the first state that promises enough
    // decoded runway to advance. Later seeks normally reach it immediately
    // because the decoder and file cache are already warm.
    if (!element.seeking && element.readyState >= 3) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = (force = false) => {
        if (done) return;
        if (!force && (element.seeking || element.readyState < 3)) return;
        done = true;
        clearTimeout(timer);
        element.removeEventListener('seeked', ready);
        element.removeEventListener('canplay', ready);
        element.removeEventListener('progress', ready);
        element.removeEventListener('error', failed);
        resolve();
      };

      const ready = () => finish(false);
      const failed = () => finish(true);

      const timer = setTimeout(() => finish(true), MOUNT_TIMEOUT);
      element.addEventListener('seeked', ready);
      element.addEventListener('canplay', ready);
      element.addEventListener('progress', ready);
      element.addEventListener('error', failed);
    });
  }

  // ------------------------------------------------------------- the pieces

  private bitmapFile(entry: ClipPlan): File | null {
    const clip = entry.clip;
    if (isMediaClip(clip)) return clip.summary.kind === 'image' ? clip.file : null;
    return clip.backgroundFile;
  }

  private async ensureBitmap(id: string, file: File): Promise<void> {
    if (this.bitmaps.has(id) && this.bitmapFiles.get(id) === file) return;

    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) return;

    const current = this.plan?.clips.find((entry) => entry.clip.id === id) ?? null;
    if (!current || this.bitmapFile(current) !== file) {
      bitmap.close();
      return;
    }

    this.bitmaps.get(id)?.close();
    this.bitmaps.set(id, bitmap);
    this.bitmapFiles.set(id, file);
  }

  private discardStaleBitmaps(plan: ProjectPlan): void {
    for (const [id, file] of this.bitmapFiles) {
      const entry = plan.clips.find((candidate) => candidate.clip.id === id) ?? null;
      if (entry && this.bitmapFile(entry) === file) continue;

      this.bitmaps.get(id)?.close();
      this.bitmaps.delete(id);
      this.bitmapFiles.delete(id);
    }
  }

  private buildScene(entry: ClipPlan): TextScene | null {
    const clip = entry.clip;
    if (isMediaClip(clip)) return null;

    const bitmap = clip.backgroundFile && this.bitmapFiles.get(clip.id) === clip.backgroundFile
      ? this.bitmaps.get(clip.id)
      : null;
    const background: SceneBackground = bitmap
      ? { kind: 'image', image: bitmap, width: bitmap.width, height: bitmap.height }
      : { kind: 'color', color: clip.draft.backgroundColor };

    return {
      width: this.width,
      height: this.height,
      background,
      text: clip.draft.text,
      fontFamily: fontStack(clip.draft.fontId),
      fontScale: clip.draft.fontScale,
      fontWeight: clip.draft.fontWeight,
      color: clip.draft.color,
      letterSpacing: clip.draft.letterSpacing,
      lineHeight: clip.draft.lineHeight,
      align: clip.draft.align,
      vertical: clip.draft.vertical,
      margin: clip.draft.margin,
      legibility: clip.draft.legibility,
      animation: clip.draft.animation,
      revealSeconds: clip.draft.revealSeconds,
      holdSeconds: clip.draft.holdSeconds,
      // The card's own fades are left off: the clip's fades are on the project
      // timeline and the compositor applies them, as it does when exporting.
      fadeIn: false,
      fadeOut: false,
      fadeSeconds: 0
    };
  }

  private urlFor(file: File): string {
    let url = this.urls.get(file);
    if (!url) {
      url = URL.createObjectURL(file);
      this.urls.set(file, url);
    }
    return url;
  }

  private disablePitchPreservation(element: HTMLMediaElement): void {
    if ('preservesPitch' in element) element.preservesPitch = false;
  }

  private scratchCanvas(which: 'main' | 'incoming'): OffscreenCanvas | HTMLCanvasElement {
    const held = which === 'main' ? this.scratch : this.scratchIncoming;

    if (!held || held.width !== this.width || held.height !== this.height) {
      const made = canvasOfSize(this.width, this.height);
      made.width = this.width;
      made.height = this.height;
      if (which === 'main') this.scratch = made;
      else this.scratchIncoming = made;
      return made;
    }

    return held;
  }

  /**
   * Composes at the plan's shape but never at its size.
   *
   * A 4K project drawn sixty times a second would spend the whole frame budget
   * on pixels nobody can see in a preview pane. Everything the compositor draws
   * is a share of the frame rather than a number of pixels, so a smaller canvas
   * shows the same picture.
   */
  private resize(plan: ProjectPlan): void {
    const ratio = plan.height / Math.max(1, plan.width);
    this.width = Math.min(this.maxWidth, plan.width);
    this.height = Math.max(2, Math.round(this.width * ratio));

    const canvas = this.elements.canvas;
    if (canvas.width !== this.width || canvas.height !== this.height) {
      canvas.width = this.width;
      canvas.height = this.height;
      this.context = canvas.getContext('2d');
    }
  }
}

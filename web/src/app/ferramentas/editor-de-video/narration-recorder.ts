/**
 * Recording narration from the microphone.
 *
 * A thin wrapper over `MediaRecorder`, and deliberately thin: the interesting
 * work — taking the room out, taking the pauses out — happens afterwards in
 * {@link ./audio-cleanup}, on a decoded copy, where it can be undone by
 * recording again rather than being baked into the capture.
 *
 * The one thing here that is not just plumbing is the level meter. Recording
 * into a browser with no indication that anything is arriving is how people end
 * up with four minutes of a muted microphone, and the fix costs one analyser
 * node.
 */

/** A moment of the recording, reported roughly twenty times a second. */
export interface RecorderTick {
  /** Seconds recorded so far, pauses excluded. */
  elapsed: number;
  /** Loudest thing heard since the last tick, in `[0, 1]`. */
  level: number;
}

/** Container the browser is asked for, best first. All decode again fine here. */
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

export class RecorderError extends Error {
  constructor(
    message: string,
    readonly hint = ''
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

export class NarrationRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private meter: number | null = null;
  private buffer: Float32Array | null = null;

  private chunks: Blob[] = [];
  private startedAt = 0;
  private accumulated = 0;

  /** True while the microphone is open, whether or not it is paused. */
  running = false;
  paused = false;

  /** Whether this browser can record at all, checked before anything is offered. */
  static get supported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined'
    );
  }

  constructor(private readonly onTick: (tick: RecorderTick) => void) {}

  /**
   * Opens the microphone and starts.
   *
   * The browser's own echo cancellation and noise suppression are left on. They
   * are cheap, they run before anything reaches us, and the heavier pass this
   * app does afterwards works from whatever it is given — asking for the raw
   * signal would mean a worse recording for everyone who never turns the
   * cleanup on.
   */
  async start(): Promise<void> {
    if (!NarrationRecorder.supported) {
      throw new RecorderError(
        'This browser cannot record audio.',
        'Recording needs microphone access, which Safari on iOS and some embedded browsers do not offer.'
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (error) {
      const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      throw new RecorderError(
        denied ? 'The microphone was not allowed.' : 'No microphone could be opened.',
        denied
          ? 'Allow microphone access for this site in the address bar, then try again.'
          : 'Check that a microphone is connected and not in use by another program.'
      );
    }

    this.chunks = [];
    this.accumulated = 0;

    // Everything past this point runs with a live microphone, so anything that
    // throws has to hand it back. A tab left holding an open capture shows the
    // recording indicator forever and keeps the device claimed against every
    // other program on the machine.
    try {
      const mimeType = PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size) this.chunks.push(event.data);
      };

      // A timeslice, so a tab that is closed mid-recording has still delivered
      // most of what was said rather than nothing at all.
      this.recorder.start(1000);
      this.startedAt = performance.now();
      this.running = true;
      this.paused = false;

      this.openMeter();
    } catch (error) {
      this.release();
      throw new RecorderError(
        'The microphone opened but recording could not start.',
        error instanceof Error ? error.message : ''
      );
    }
  }

  pause(): void {
    if (!this.recorder || this.paused || this.recorder.state !== 'recording') return;
    this.recorder.pause();
    this.accumulated += (performance.now() - this.startedAt) / 1000;
    this.paused = true;
  }

  resume(): void {
    if (!this.recorder || !this.paused) return;
    this.recorder.resume();
    this.startedAt = performance.now();
    this.paused = false;
  }

  /** Seconds captured so far, pauses excluded. */
  get elapsed(): number {
    return this.accumulated + (this.running && !this.paused ? (performance.now() - this.startedAt) / 1000 : 0);
  }

  /**
   * Stops and hands back everything recorded.
   *
   * Resolves on the recorder's own `stop` event rather than immediately: the
   * last chunk is delivered as part of stopping, and a blob assembled before it
   * arrives is missing its final second.
   */
  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) throw new RecorderError('Nothing was being recorded.');

    // Only while it was genuinely still running. A recorder the browser stopped
    // on its own — microphone unplugged, permission revoked — stopped at some
    // earlier moment, and counting up to now would claim more audio than the
    // blob actually holds.
    if (!this.paused && recorder.state === 'recording') {
      this.accumulated += (performance.now() - this.startedAt) / 1000;
    }

    // A `MediaRecorder` stops itself when its tracks end — a microphone
    // unplugged, an audio device switched, permission revoked from the address
    // bar. Waiting for an `onstop` that has already fired would hang the dialog
    // on the recording screen with no way out, so the already-stopped case is
    // answered from what is in hand.
    if (recorder.state !== 'inactive') {
      const finished = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.stop();
      await finished;
    }

    const type = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });

    this.release();
    return blob;
  }

  /** Stops and throws the recording away. Safe to call at any time. */
  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.chunks = [];
    this.release();
  }

  private openMeter(): void {
    const Context: typeof AudioContext | undefined =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context || !this.stream) return;

    this.context = new Context();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.context.createMediaStreamSource(this.stream).connect(this.analyser);
    this.buffer = new Float32Array(this.analyser.fftSize);

    // `setInterval` rather than `requestAnimationFrame`: the meter must keep
    // moving while the tab is in the background, because a recording that is
    // still running is exactly when the reader is least likely to be looking.
    this.meter = window.setInterval(() => this.tick(), 50);
  }

  private tick(): void {
    let level = 0;

    if (this.analyser && this.buffer && !this.paused) {
      this.analyser.getFloatTimeDomainData(this.buffer);
      for (let index = 0; index < this.buffer.length; index++) {
        const magnitude = Math.abs(this.buffer[index]);
        if (magnitude > level) level = magnitude;
      }
    }

    this.onTick({ elapsed: this.elapsed, level });
  }

  private release(): void {
    // Stopped first, not merely dropped. A `MediaRecorder` left in `recording`
    // with its reference thrown away keeps the browser's capture pipeline alive
    // even after the tracks below are ended.
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.ondataavailable = null;
      try {
        this.recorder.stop();
      } catch {
        /* Already stopping. Nothing here is worth failing a teardown over. */
      }
    }

    if (this.meter !== null) window.clearInterval(this.meter);
    this.meter = null;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.buffer = null;

    this.recorder = null;
    this.running = false;
    this.paused = false;
  }
}

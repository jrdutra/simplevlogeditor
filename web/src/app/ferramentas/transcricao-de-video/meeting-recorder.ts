/** Captures only audio into the recording. Display capture still requires a
 * video track to keep the browser's sharing controls and source selection. */
export class MeetingRecorder {
  private streams: MediaStream[] = [];
  private context?: AudioContext;
  private recorder?: MediaRecorder;
  private chunks: Blob[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private bytes = 0;

  constructor(private readonly complete: (file: File) => void,
    private readonly failed: (message: string) => void) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia &&
      typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined';
  }

  async start(includeMicrophone: boolean, maxMinutes: number): Promise<void> {
    if (!MeetingRecorder.supported()) throw new Error('Meeting capture is unavailable. Import a recording, or use a browser that supports sharing audio.');
    try {
      // Must be the first asynchronous browser request: display capture needs
      // the activation supplied by the user's click.
      const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.keep(shared);
      if (!shared.getAudioTracks().length) throw new Error('No shared audio was received. Choose the meeting tab and enable Share audio, or import the meeting recording.');
      if (includeMicrophone) {
        this.keep(await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }));
      }
      this.context = new AudioContext();
      await this.context.resume();
      if (this.disposed) throw new Error('Capture was canceled.');
      const mixed = this.context.createMediaStreamDestination();
      this.streams.forEach(stream => {
        const source = this.context!.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
        const gain = this.context!.createGain();
        gain.gain.value = 1 / this.streams.length;
        source.connect(gain).connect(mixed);
      });
      // Never connect to the speakers: that would feed the meeting back into itself.
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('No supported audio recording format. Import the recording instead.');
      this.recorder = new MediaRecorder(mixed.stream, { mimeType, audioBitsPerSecond: 128000 });
      this.recorder.ondataavailable = event => {
        if (this.disposed || !event.data.size) return;
        this.chunks.push(event.data);
        this.bytes += event.data.size;
        if (this.bytes >= 128 * 1024 * 1024) this.stop();
      };
      this.recorder.onerror = () => {
        this.dispose();
        this.failed('Audio recording failed. Please import a recording from your meeting app.');
      };
      this.recorder.onstop = () => {
        const canceled = this.disposed;
        const data = new Blob(this.chunks, { type: mimeType });
        this.release();
        this.chunks = [];
        if (canceled) return;
        this.disposed = true;
        if (!data.size) { this.failed('No audio was recorded.'); return; }
        const extension = mimeType.includes('mp4') ? 'm4a' : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.complete(new File([data], `meeting-${stamp}.${extension}`, { type: mimeType }));
      };
      for (const stream of this.streams) for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => this.stop(), { once: true });
      }
      if (this.streams.some(stream => stream.getTracks().some(track => track.readyState === 'ended'))) {
        throw new Error('The audio source ended before recording started.');
      }
      this.recorder.start(1000);
      this.timer = setTimeout(() => this.stop(), maxMinutes * 60000);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private keep(stream: MediaStream): void {
    if (this.disposed) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('Capture was canceled.');
    }
    this.streams.push(stream);
  }

  stop(): void {
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.release();
    this.chunks = [];
  }

  private release(): void {
    clearTimeout(this.timer);
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    this.streams = [];
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
  }
}

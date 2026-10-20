import { TimelinePlayer } from './timeline-player';
import { ProjectPlan } from './video-editor.models';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => resolve = done);
  return { promise, resolve };
}

function player() {
  const elements = { canvas: document.createElement('canvas'), video: document.createElement('video'),
    videoB: document.createElement('video'), audio: document.createElement('audio') };
  const instance = new TimelinePlayer(elements, { onTick: () => {}, onEnded: () => {} });
  const internal = instance as any;
  for (const media of [elements.video, elements.videoB, elements.audio, internal.audioB]) {
    spyOn(media, 'pause'); spyOn(media, 'load');
  }
  internal.plan = { clips: [], totalDuration: 10 } as unknown as ProjectPlan;
  spyOn(internal, 'draw');
  spyOn(internal, 'ensureAudioGain');
  const start = spyOn(internal, 'startMountedMedia').and.resolveTo();
  const loop = spyOn(internal, 'loop');
  return { instance, internal, start, loop };
}

describe('preview playback lifecycle', () => {
  it('honours pause while the first frame is still loading', async () => {
    const { instance, internal, start, loop } = player();
    const loading = deferred();
    internal.mountTask = loading.promise;
    const playing = instance.play();
    await Promise.resolve();
    expect(instance.playing).toBeTrue();
    instance.pause();
    loading.resolve();
    await playing;
    expect(instance.playing).toBeFalse();
    expect(start).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
    await instance.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(loop).toHaveBeenCalledTimes(1);
    instance.dispose();
  });

  it('coalesces repeated Play and lets Toggle cancel a pending start', async () => {
    const { instance, internal, start } = player();
    const loading = deferred();
    internal.mountTask = loading.promise;
    const first = instance.play();
    await instance.play();
    instance.toggle();
    loading.resolve();
    await first;
    expect(instance.playing).toBeFalse();
    expect(start).not.toHaveBeenCalled();
    instance.dispose();
  });

  it('does not restart or accept a new plan after the preview is disposed', async () => {
    const { instance, internal, start, loop } = player();
    const resume = deferred();
    const close = jasmine.createSpy('close').and.resolveTo();
    internal.audioContext = { resume: () => resume.promise, close };
    const playing = instance.play();
    instance.dispose();
    instance.dispose();
    resume.resolve();
    await playing;
    instance.setPlan({ clips: [], totalDuration: 10 } as unknown as ProjectPlan);
    await instance.play();
    expect(instance.playing).toBeFalse();
    expect(instance.duration).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(loop).not.toHaveBeenCalled();
  });
});

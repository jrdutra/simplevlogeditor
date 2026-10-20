import { VideoEditorRenderService } from './video-editor-render.service';
import { DEFAULT_PROJECT } from './video-editor-defaults';
import { buildProjectPlan } from './video-editor-timeline';
import { presetFrom, settingsFrom, settingsDocumentFrom } from './video-editor-presets';
import { LicensePlateBlurClient, PlateBlurError } from './license-plate-blur';
import { canvasOfSize, FrameContext } from './frame-source';
import { MediaClip, ProjectPlan } from './video-editor.models';
import { TransitionPainter } from './video-transitions';
import { EditorDeVideoComponent } from './editor-de-video.component';
import { restoreProject, serializeProject } from './video-editor-project.store';
import { clipBlursLicensePlates, hasLicensePlateBlur, licensePlateBlurAt } from './license-plate-scope';

function clip(id = 'a'): MediaClip {
  return {
    kind: 'media', id, file: new File(['x'], `${id}.mp4`),
    summary: { kind: 'video', videoUsable: true, audioUsable: false, width: 320, height: 180,
      durationSeconds: 2, frameRate: 10, fileName: `${id}.mp4` },
    overrides: null, detected: [], manualCuts: [], caption: null
  } as unknown as MediaClip;
}
function plan(blurLicensePlates = true): ProjectPlan {
  const a = clip(); a.blurLicensePlates = blurLicensePlates;
  return buildProjectPlan([a, clip('b')], DEFAULT_PROJECT, 'video');
}
function rawFrame(timestamp = .5): any {
  return { timestamp, displayWidth: 320, displayHeight: 180,
    draw: (c: FrameContext, x = 0, y = 0, w = c.canvas.width, h = c.canvas.height) => {
      c.fillStyle = '#ff0000'; c.fillRect(x, y, w, h);
    } };
}
function protect(c: FrameContext): Promise<number> {
  // Stand-in for inference here: the separate real-worker test exercises the model.
  // An unmistakable output colour proves the writer waits for protection.
  c.fillStyle = '#00ff00'; c.fillRect(0, 0, c.canvas.width, c.canvas.height);
  return Promise.resolve(1);
}
function green(canvas: OffscreenCanvas | HTMLCanvasElement): number {
  return (canvas.getContext('2d') as FrameContext).getImageData(10, 10, 1, 1).data[1];
}

describe('plate protection throughout the editor pipeline', () => {
  const service: any = Object.create(VideoEditorRenderService.prototype);

  it('does not carry plate configuration in general settings files or presets', () => {
    const legacyProject = { ...DEFAULT_PROJECT, blurLicensePlates: true };
    expect('blurLicensePlates' in presetFrom('plates', legacyProject).settings).toBeFalse();
    expect('blurLicensePlates' in settingsFrom(settingsDocumentFrom('plates', legacyProject).preset)).toBeFalse();
    const old = presetFrom('old', DEFAULT_PROJECT);
    Object.assign(old.settings, { blurLicensePlates: true });
    expect('blurLicensePlates' in settingsFrom(old)).toBeFalse();
  });

  it('round-trips independent video flags and defaults older containers to off', () => {
    const a = clip(), b = clip('b'), legacy = clip('legacy');
    a.blurLicensePlates = true; b.blurLicensePlates = false;
    const stored = serializeProject([a, b, legacy], DEFAULT_PROJECT, 4);
    Object.assign(stored.settings, { blurLicensePlates: true });
    delete (stored.clips[2] as any).blurLicensePlates;
    const restored = restoreProject(JSON.parse(JSON.stringify(stored)));
    expect(restored.clips.map(item => clipBlursLicensePlates(item))).toEqual([true, false, false]);
    expect('blurLicensePlates' in restored.project).toBeFalse();
    expect('blurLicensePlates' in buildProjectPlan(restored.clips, restored.project, 'video')).toBeFalse();
    expect(clipBlursLicensePlates(clip())).toBeFalse();
  });

  it('only activates processing at enabled video instants, including either side of joins', () => {
    const p = plan();
    expect(hasLicensePlateBlur(p)).toBeTrue();
    expect(licensePlateBlurAt(p, .5)).toBeTrue();
    expect(licensePlateBlurAt(p, 2.5)).toBeFalse();
    p.transitions = [{ fromIndex: 0, toIndex: 1, start: 1, end: 1.3 } as any];
    expect(licensePlateBlurAt(p, 1.2)).toBeTrue();
    (p.clips[0].clip as MediaClip).blurLicensePlates = false;
    expect(licensePlateBlurAt(p, 1.2)).toBeFalse();
    (p.clips[1].clip as MediaClip).blurLicensePlates = true;
    expect(licensePlateBlurAt(p, 1.2)).toBeTrue();
    (p.clips[1].clip as MediaClip).summary.kind = 'image';
    expect(hasLicensePlateBlur(p)).toBeFalse();
  });

  it('composites otherwise untouched footage and awaits protection before the encoder', async () => {
    const p = plan();
    expect(clipBlursLicensePlates(p.clips[0].clip)).toBeTrue();
    const client = new LicensePlateBlurClient();
    const redact = spyOn(client, 'redact').and.callFake(protect);
    try {
      const process = service.videoProcessor(p, {}, new AbortController().signal, new Set(), () => {}, { ms: 0 }, client);
      for (const time of [.1, .2, .3]) expect(green(await process(rawFrame(time)))).toBe(255);
      expect(redact).toHaveBeenCalledTimes(3);
      const neighbour = rawFrame(2.5);
      expect(await process(neighbour)).toBe(neighbour);
      expect(redact).toHaveBeenCalledTimes(3);
      const noBlur = service.videoProcessor(plan(false), {}, new AbortController().signal, new Set(), () => {});
      const sample = rawFrame();
      expect(await noBlur(sample)).toBe(sample);
    } finally { client.dispose(); }
  });

  it('detects before a fade darkens the picture and then preserves the fade in the output', async () => {
    const p = plan();
    p.fades = [{ start: 0, end: 1, kind: 'in' }];
    const client = new LicensePlateBlurClient();
    spyOn(client, 'redact').and.callFake(c => {
      expect(c.getImageData(10, 10, 1, 1).data[0]).toBe(255);
      return protect(c);
    });
    try {
      const process = service.videoProcessor(p, {}, new AbortController().signal, new Set(), () => {}, { ms: 0 }, client);
      expect(green(await process(rawFrame(.5)))).toBeCloseTo(128, -1);
    } finally { client.dispose(); }
  });

  it('propagates detection failures with their MCP code and never returns the raw frame', async () => {
    const client = new LicensePlateBlurClient(), error = new PlateBlurError('broken model');
    spyOn(client, 'redact').and.rejectWith(error);
    const process = service.videoProcessor(plan(), {}, new AbortController().signal, new Set(), () => {}, { ms: 0 }, client);
    await expectAsync(process(rawFrame())).toBeRejectedWith(error);
    expect(service.describe(error).withClip('a').code).toBe('plate_detection_failed');
    expect(service.describe(service.describe(error).withClip('a')).code).toBe('plate_detection_failed');
    client.dispose();
  });

  it('protects every generated transition frame and refuses to encode on failure', async () => {
    const p = plan();
    (p.clips[1].clip as MediaClip).blurLicensePlates = true;
    const join = { fromIndex: 0, toIndex: 1, start: 1, end: 1.3,
      settings: { kind: 'dissolve', seconds: .3, colour: '#000' } };
    p.transitions = [join as any]; p.frameRate = 10;
    const dispose = jasmine.createSpy('dispose');
    const open = spyOn(service, 'openSide').and.callFake(async () => ({
      frameAt: async () => ({ width: 320, height: 180, draw: rawFrame().draw }), dispose
    }));
    const client = new LicensePlateBlurClient();
    const redact = spyOn(client, 'redact').and.callFake(protect);
    const add = jasmine.createSpy('add').and.callFake(async (sample: any) => expect(sample.green).toBe(255));
    class Sample {
      green: number;
      constructor(canvas: any) { this.green = green(canvas); }
      close() {}
    }
    try {
      await service.writeTransition({ VideoSample: Sample }, join, p.clips[0], p.clips[1], p,
        { add }, new TransitionPainter(), -Infinity, new AbortController().signal, () => {}, {}, client);
      expect(redact).toHaveBeenCalledTimes(6);
      expect(add).toHaveBeenCalledTimes(3);
      redact.and.rejectWith(new PlateBlurError('failed')); add.calls.reset();
      await expectAsync(service.writeTransition({ VideoSample: Sample }, join, p.clips[0], p.clips[1], p,
        { add }, new TransitionPainter(), -Infinity, new AbortController().signal, () => {}, {}, client)).toBeRejectedWithError(PlateBlurError);
      expect(add).not.toHaveBeenCalled();
    } finally { client.dispose(); open.and.callThrough(); }
  });

  it('keeps unchecked transition neighbours untouched in both directions', async () => {
    const open = spyOn(service, 'openSide').and.callFake(async () => ({
      frameAt: async () => ({ width: 320, height: 180, draw: rawFrame().draw }), dispose: () => {}
    }));
    const client = new LicensePlateBlurClient();
    const redact = spyOn(client, 'redact').and.callFake(protect);
    const painter = { draw: (c: FrameContext, kind: any, args: any) => {
      args.outgoing.draw(c, 0, 0, 160, 180);
      args.incoming.draw(c, 160, 0, 160, 180);
    } };
    try {
      for (const flags of [[true, false], [false, true], [false, false]]) {
        const p = plan(flags[0]); (p.clips[1].clip as MediaClip).blurLicensePlates = flags[1];
        const join = { fromIndex: 0, toIndex: 1, start: 1, end: 1.1,
          settings: { kind: 'dissolve', seconds: .1, colour: '#000' } };
        p.transitions = [join as any]; p.frameRate = 10;
        class Sample {
          constructor(canvas: any) {
            const c = canvas.getContext('2d');
            expect(c.getImageData(10, 10, 1, 1).data[1]).toBe(flags[0] ? 255 : 0);
            expect(c.getImageData(310, 10, 1, 1).data[1]).toBe(flags[1] ? 255 : 0);
          }
          close() {}
        }
        redact.calls.reset();
        await service.writeTransition({ VideoSample: Sample }, join, p.clips[0], p.clips[1], p,
          { add: async () => {} }, painter, -Infinity, new AbortController().signal, () => {}, {}, client);
        expect(redact.calls.count()).toBe(flags.filter(Boolean).length);
      }
    } finally { client.dispose(); open.and.callThrough(); }
  });

  it('protects composed MCP frames and fails before returning any image on model failure', async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const c = canvas.getContext('2d')!;
    rawFrame().draw(c);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = event => chunks.push(event.data);
    const recorded = new Promise<Blob>(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });
    recorder.start();
    rawFrame().draw(c);
    await new Promise(resolve => setTimeout(resolve, 150));
    recorder.stop();
    const blob = await recorded;
    stream.getTracks().forEach(track => track.stop());
    const video = clip(); video.file = new File([blob], 'car.webm'); video.blurLicensePlates = true;
    const p = buildProjectPlan([video], DEFAULT_PROJECT, 'video');
    const editor: any = Object.create(EditorDeVideoComponent.prototype);
    Object.defineProperty(editor, 'plan', { value: p });
    Object.assign(editor, { project: { ...DEFAULT_PROJECT },
      agentAssetId: () => 'asset', agentProgress: () => {}, formatTime: String, agentImagePayload: () => ({}) });
    const redact = spyOn(LicensePlateBlurClient.prototype, 'redact').and.callFake(protect);
    const result = await editor.captureComposedFrames(video, [0], 320, .9);
    expect(result.licensePlateBlurApplied).toBeTrue();
    expect(result.frames.length).toBe(1);
    expect(redact).toHaveBeenCalledTimes(1);
    video.blurLicensePlates = false;
    const plain = await editor.captureComposedFrames(video, [0], 320, .9);
    expect(plain.licensePlateBlurApplied).toBeFalse();
    expect(redact).toHaveBeenCalledTimes(1);
    video.blurLicensePlates = true;
    redact.and.rejectWith(new PlateBlurError('broken model'));
    await expectAsync(editor.captureComposedFrames(video, [0], 320, .9)).toBeRejectedWithError(PlateBlurError);
  });
});

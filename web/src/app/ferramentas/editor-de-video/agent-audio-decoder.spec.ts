import { readAgentAudioRange } from './agent-audio-decoder';
import { SourceAudioMeter } from './audio-range-meter';
import { EditorDeVideoComponent } from './editor-de-video.component';

describe('source audio cut inspection', () => {
  function audioFile(): File {
    const meter = new SourceAudioMeter(0, 2, .2, true);
    const values = new Float32Array(2000 * 2);
    for (let index = 0; index < 2000; index++) {
      values[index * 2] = index < 1000 ? .25 : .5;
      values[index * 2 + 1] = -values[index * 2];
    }
    meter.add({ timestamp: 0, sampleRate: 1000, numberOfChannels: 2, numberOfFrames: 2000 }, values);
    return new File([meter.wav()!], 'sound.wav', { type: 'audio/wav' });
  }

  it('decodes a real source interval, with accurate levels and an audible WAV excerpt', async () => {
    const result = await readAgentAudioRange(audioFile(), .6, 1.4, .2, true, new AbortController().signal);
    expect(result.noAudio).toBeFalse();
    expect(result.buckets.length).toBe(4);
    expect(result.buckets[0].rms!).toBeCloseTo(.25, 4);
    expect(result.buckets[3].rms!).toBeCloseTo(.5, 4);
    expect(result.buckets.every(bucket => bucket.coverage > .99)).toBeTrue();
    expect(result.audio!.mimeType).toBe('audio/wav');
    expect(result.audio!.channelCount).toBe(2);
    const wav = Uint8Array.from(atob(result.audio!.data), char => char.charCodeAt(0));
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(800 * 2 * 2);
  });

  it('reads adjacent source context across split bounds without changing the project', async () => {
    const editor = Object.create(EditorDeVideoComponent.prototype) as any;
    const clip = { id: 'second-half', file: audioFile(), inPoint: 1, outPoint: 1.2, summary: { durationSeconds: 2 } };
    editor.agentMediaClip = () => clip;
    editor.agentAssetId = () => 'original';
    editor.agentProgress = () => {};
    const result = await editor.agentAudioLevels({ clipId: clip.id, start: .6, end: 1.4 }, new AbortController().signal);
    expect(result.start).toBe(.6); expect(result.end).toBe(1.4);
    expect(result.assetId).toBe('original'); expect(result.timeSpace).toBe('source');
    expect(result.audio).toBeNull();
    expect(clip.inPoint).toBe(1); expect(clip.outPoint).toBe(1.2);
  });

  it('clamps context at the file end and rejects unavailable or out-of-source audio', async () => {
    const editor = Object.create(EditorDeVideoComponent.prototype) as any;
    editor.agentMediaClip = () => ({ id: 'a', file: audioFile(), summary: { durationSeconds: 2 } });
    editor.agentAssetId = () => 'original'; editor.agentProgress = () => {};
    const result = await editor.agentAudioLevels({ clipId: 'a', start: 1.6, end: 5 }, new AbortController().signal);
    expect(result.end).toBe(2);
    await expectAsync(editor.agentAudioLevels({ start: 3, end: 5 }, new AbortController().signal)).toBeRejected();
    await expectAsync(readAgentAudioRange(new File(['not media'], 'broken.wav'), 0, 1, .2, false, new AbortController().signal)).toBeRejected();
  });

  it('cancels a decode during progress and accepts 200ms frame inspection', async () => {
    const controller = new AbortController();
    await expectAsync(readAgentAudioRange(audioFile(), 0, 1.6, .2, false, controller.signal,
      () => controller.abort())).toBeRejectedWith(jasmine.objectContaining({ code: 'cancelled' }));
    const editor = Object.create(EditorDeVideoComponent.prototype) as any;
    editor.agentMediaClip = () => ({ id: 'a', summary: { durationSeconds: 20 } });
    editor.agentFrames = async (request: any) => request;
    const sheet = await editor.agentContactSheet({ start: 6, end: 14, interval: .2 });
    expect(sheet.timestamps.length).toBe(41);
    expect(sheet.timestamps[1] - sheet.timestamps[0]).toBeCloseTo(.2, 8);
    expect(sheet.timestamps[0]).toBe(6);
    expect(sheet.timestamps.at(-1)).toBeCloseTo(14, 8);
  });
});

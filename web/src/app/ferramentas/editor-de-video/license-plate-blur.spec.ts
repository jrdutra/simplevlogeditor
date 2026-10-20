import { decodePlateBoxes, paddedPlateBox, PlateBoxHistory, plateLetterbox, PLATE_MODEL } from './license-plate-detection';
import { LicensePlateBlurClient, LicensePlateBlurPreview, paintPlateBlur, PlateBlurError } from './license-plate-blur';
import { canvasOfSize, FrameContext } from './frame-source';

const box = { x: .3, y: .4, width: .2, height: .1, score: .9 };
function context(width = 320, height = 180): FrameContext {
  return canvasOfSize(width, height).getContext('2d') as FrameContext;
}

describe('local license plate geometry', () => {
  it('keeps both transition sources protected through an intermittent missed detection', () => {
    const history = new PlateBoxHistory();
    const other = { ...box, x: .7 };
    history.update('outgoing', 1, [box]);
    history.update('incoming', 1, [other]);
    expect(history.update('outgoing', 1.03, [])).toEqual([box]);
    expect(history.update('incoming', 1.03, [])).toEqual([other]);
    expect(history.update('new-cut', 1.04, [])).toEqual([]);
  });

  it('discards the whole source history when seeking backwards within its hold window', () => {
    const history = new PlateBoxHistory();
    history.update('a', 1, [box]);
    history.update('a', 1.06, []);
    expect(history.update('a', 1.04, [])).toEqual([]);
  });

  it('preserves wide and portrait geometry and rejects invalid frames', () => {
    expect(plateLetterbox(1920, 1080)).toEqual({ scale: 1 / 3, width: 640, height: 360, left: 0, top: 140 });
    expect(plateLetterbox(1080, 1920)).toEqual({ scale: 1 / 3, width: 360, height: 640, left: 140, top: 0 });
    expect(() => plateLetterbox(0, 1080)).toThrow();
  });

  it('undoes padding, filters confidence, suppresses duplicates and retains distinct plates', () => {
    const values = new Float32Array(8400 * 6);
    values.set([320, 320, 128, 36, .9, .9], 0);
    values.set([321, 320, 128, 36, .8, .9], 6);
    values.set([64, 200, 64, 36, .9, .9], 12);
    values.set([480, 400, 64, 36, .4, .4], 18);
    values.set([NaN, 400, 64, 36, .9, .9], 24);
    const boxes = decodePlateBoxes(values, [1, 8400, 6], 1920, 1080);
    expect(boxes.length).toBe(2);
    expect(boxes[0].x).toBeCloseTo(.4);
    expect(boxes[0].y).toBeCloseTo(.45);
    expect(boxes[0].width).toBeCloseTo(.2);
    expect(boxes[0].height).toBeCloseTo(.1);
    expect(() => decodePlateBoxes(values, [1, 8400, 7], 1920, 1080)).toThrow();
  });

  it('enlarges detection edges without leaving the image', () => {
    const padded = paddedPlateBox(box, 320, 180);
    expect(padded.x).toBeLessThan(box.x);
    expect(padded.width).toBeGreaterThan(box.width);
    const edge = paddedPlateBox({ ...box, x: 0, y: 0, width: 1, height: 1 }, 320, 180);
    expect([edge.x, edge.y, edge.width, edge.height]).toEqual([0, 0, 1, 1]);
  });

  it('briefly holds missed detections but never carries them over cuts or backwards seeks', () => {
    const history = new PlateBoxHistory();
    history.update('a', 1, [box]);
    expect(history.update('a', 1.03, [])).toEqual([box]);
    expect(history.update('a', 1.06, [])).toEqual([box]);
    expect(history.update('a', 1.1, [])).toEqual([]);
    history.update('a', 2, [box]);
    expect(history.update('b', 2.03, [])).toEqual([]);
    history.update('b', 3, [box]);
    expect(history.update('b', 2.99, [])).toEqual([]);
    history.update('b', 4, [box]);
    expect(history.update('b', 5, [])).toEqual([]);
  });
});

describe('license plate redaction', () => {
  it('removes high-frequency plate lettering, preserves the rest, and restores canvas state', () => {
    const c = context(320, 180);
    c.fillStyle = '#123456'; c.fillRect(0, 0, 320, 180);
    for (let x = 96; x < 160; x++) {
      c.fillStyle = x % 2 ? '#fff' : '#000'; c.fillRect(x, 72, 1, 18);
    }
    const before = c.getImageData(0, 0, 320, 180).data;
    c.globalAlpha = .4; c.filter = 'contrast(2)';
    paintPlateBlur(c, [box]);
    expect(c.globalAlpha).toBeCloseTo(.4);
    expect(c.filter).toBe('contrast(2)');
    const after = c.getImageData(0, 0, 320, 180).data;
    const pixel = (x: number, y: number) => (y * 320 + x) * 4;
    expect([...after.slice(pixel(10, 10), pixel(10, 10) + 4)])
      .toEqual([...before.slice(pixel(10, 10), pixel(10, 10) + 4)]);
    expect(Math.abs(after[pixel(120, 80)] - after[pixel(121, 80)])).toBeLessThan(20);
    expect(before[pixel(121, 80)] - before[pixel(120, 80)]).toBe(255);
  });

  it('never returns an unprotected frame after inference failure or cancellation', async () => {
    const client = new LicensePlateBlurClient();
    spyOn<any>(client, 'detect').and.rejectWith(new Error('unavailable'));
    await expectAsync(client.redact(context(), 'a', 0)).toBeRejectedWithError(PlateBlurError, /unavailable/);
    client.dispose();
    await expectAsync(client.redact(context(), 'a', 1)).toBeRejectedWithError(PlateBlurError);
    const aborted = new AbortController(); aborted.abort();
    const second = new LicensePlateBlurClient();
    await expectAsync(second.redact(context(), 'a', 0, aborted.signal)).toBeRejectedWithError(PlateBlurError);
    second.dispose();
  });

  it('aborts an in-flight worker immediately and releases its frame', async () => {
    const worker = { postMessage: () => {}, terminate: jasmine.createSpy('terminate') };
    spyOn(window, 'Worker').and.returnValue(worker as unknown as Worker);
    const client = new LicensePlateBlurClient(), controller = new AbortController();
    const pending = client.redact(context(), 'a', 0, controller.signal);
    controller.abort();
    await expectAsync(pending).toBeRejectedWithError(PlateBlurError, /cancelled/);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('keeps the visible preview black until a completed protected frame is ready', async () => {
    let finish!: (value: number) => void;
    spyOn(LicensePlateBlurClient.prototype, 'redact').and.callFake(c => new Promise<number>(resolve => {
      finish = value => { c.fillStyle = '#00ff00'; c.fillRect(0, 0, 20, 20); resolve(value); };
    }));
    const preview = new LicensePlateBlurPreview(), target = context(20, 20);
    const scratch = preview.context(20, 20);
    scratch.fillStyle = '#ff0000'; scratch.fillRect(0, 0, 20, 20);
    preview.present(target, 'a', 1, () => {});
    expect([...target.getImageData(2, 2, 1, 1).data]).toEqual([0, 0, 0, 255]);
    finish(1); await new Promise(resolve => setTimeout(resolve, 0));
    preview.present(target, 'a', 1, () => {});
    expect([...target.getImageData(2, 2, 1, 1).data]).toEqual([0, 255, 0, 255]);
    preview.present(target, 'b', 1.03, () => {});
    expect([...target.getImageData(2, 2, 1, 1).data]).toEqual([0, 0, 0, 255]);
    preview.dispose(); finish(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.completedTime).toBe(-1);
  });

  it('keeps the preview black and reports a failed model instead of revealing its scratch frame', async () => {
    spyOn(LicensePlateBlurClient.prototype, 'redact').and.rejectWith(new PlateBlurError('invalid model'));
    const preview = new LicensePlateBlurPreview(), target = context(20, 20);
    const scratch = preview.context(20, 20);
    scratch.fillStyle = '#ff0000'; scratch.fillRect(0, 0, 20, 20);
    preview.present(target, 'a', 1, () => {});
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(preview.present(target, 'a', 1, () => {})).toContain('invalid model');
    expect([...target.getImageData(2, 2, 1, 1).data]).toEqual([0, 0, 0, 255]);
    preview.dispose();
  });

  it('reanalyses late decoded content at the same paused timeline instant', async () => {
    const redact = spyOn(LicensePlateBlurClient.prototype, 'redact').and.callFake(async () => 0);
    const preview = new LicensePlateBlurPreview(), target = context(20, 20);
    const scratch = preview.context(20, 20);
    preview.present(target, 'a', 1, () => {}, 1, 'loading');
    await new Promise(resolve => setTimeout(resolve, 0));
    scratch.fillStyle = '#00ff00'; scratch.fillRect(0, 0, 20, 20);
    preview.present(target, 'a', 1, () => {}, 1, 'decoded');
    await new Promise(resolve => setTimeout(resolve, 0));
    preview.present(target, 'a', 1, () => {}, 1, 'decoded');
    expect(redact).toHaveBeenCalledTimes(2);
    expect([...target.getImageData(2, 2, 1, 1).data]).toEqual([0, 255, 0, 255]);
    preview.dispose();
  });
});

describe('bundled plate detector in a real browser worker', () => {
  it('detects and blurs a real plate using only bundled local inference assets', async () => {
    const image = new Image();
    image.src = '/plate-test/license-plate-sample.png';
    await image.decode();
    const c = context(image.naturalWidth, image.naturalHeight);
    c.drawImage(image, 0, 0);
    const before = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
    const client = new LicensePlateBlurClient();
    const detect = spyOn<any>(client, 'detect').and.callThrough();
    try {
      const count = await client.redact(c, 'real-car', 0);
      expect(count).toBeGreaterThan(0);
      const boxes = await detect.calls.mostRecent().returnValue;
      // The plate sits around x=307..390, y=186..212 in this 518x331 fixture.
      expect(boxes.some((b: any) => b.x < 350 / 518 && b.x + b.width > 350 / 518 &&
        b.y < 200 / 331 && b.y + b.height > 200 / 331)).toBeTrue();
      const after = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
      expect(after.some((value, i) => value !== before[i])).toBeTrue();
      console.info(`Local plate detector: ${count} plate(s), threshold ${PLATE_MODEL.confidence}`);
    } finally { client.dispose(); }
  }, 120000);
});

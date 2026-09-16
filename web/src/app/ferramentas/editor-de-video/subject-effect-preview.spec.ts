import { SubjectEffectPreview } from './subject-effect-preview';
import { FrameSource } from './frame-source';
import { SubjectMask } from './subject-segmentation';

describe('synchronized AI effect preview', () => {
  let preview: SubjectEffectPreview;
  const mask: SubjectMask = { width:1,height:1,alpha:new Uint8ClampedArray([255]),coverage:1 };
  beforeEach(() => preview = new SubjectEffectPreview());
  afterEach(() => preview.dispose());
  const source: FrameSource = { width:16,height:16,draw:(ctx,x,y,w,h)=>{ctx.fillStyle='red';ctx.fillRect(x,y,w,h);} };

  it('keeps a frozen picture with its exact matte while the decoder moves', async () => {
    let finish!: (value: SubjectMask) => void;
    const infer = spyOn(preview.vision,'maskFor').and.returnValue(new Promise(resolve=>finish=resolve));
    const ready = jasmine.createSpy('ready');
    expect(preview.frame(source,16,16,1,false,'a',0,ready)).toBeNull();
    expect(preview.frame(source,16,16,1,false,'a',.1,ready)).toBeNull();
    expect(infer).toHaveBeenCalledTimes(1);
    finish(mask); await Promise.resolve();
    const pair = preview.frame(source,16,16,1,false,'a',.1,ready)!;
    expect(pair.mask).toBe(mask);
    expect(pair.source).not.toBe(source);
    const target = document.createElement('canvas'); target.width=16;target.height=16;
    pair.source.draw(target.getContext('2d')!,0,0,16,16);
    expect(Array.from(target.getContext('2d')!.getImageData(0,0,1,1).data)).toEqual([255,0,0,255]);
    expect(infer).toHaveBeenCalledTimes(2);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('drops results after a seek, clip replacement or disposal', async () => {
    let finish!: (value: SubjectMask) => void;
    const infer = spyOn(preview.vision,'maskFor').and.callFake(()=>new Promise(resolve=>finish=resolve));
    const ready = jasmine.createSpy('ready');
    preview.frame(source,16,16,1,false,'a',1,ready);
    preview.reset(); finish(mask); await Promise.resolve();
    expect(preview.frame(source,16,16,1,false,'b',0,ready)).toBeNull();
    expect(infer).toHaveBeenCalledTimes(2);
    ready.calls.reset(); preview.dispose(); finish(mask); await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
  });

  it('falls back without throwing when a frame cannot be captured', () => {
    const broken = {...source,draw:()=>{throw new Error('decoder failed');}};
    expect(preview.frame(broken,16,16,1,false,'a',0,()=>undefined)).toBeNull();
    expect(preview.vision.state).toBe('unavailable');
  });
});

describe('frozen pair invalidation across discontinuities', () => {
  const mask: SubjectMask = { width:1,height:1,alpha:new Uint8ClampedArray([255]),coverage:1 };
  const source: FrameSource = { width:16,height:16,draw:(ctx,x,y,w,h)=>{ctx.fillStyle='lime';ctx.fillRect(x,y,w,h);} };
  let preview: SubjectEffectPreview;
  beforeEach(() => preview = new SubjectEffectPreview());
  afterEach(() => preview.dispose());

  /** Drives one inference to completion so a frozen pair exists at `time`. */
  async function settleAt(time: number): Promise<void> {
    let finish!: (value: SubjectMask) => void;
    const infer = spyOn(preview.vision,'maskFor').and.returnValue(new Promise(resolve => finish = resolve));
    preview.frame(source,16,16,1,false,'clip-1',time,()=>undefined);
    finish(mask);
    await Promise.resolve();
    infer.and.returnValue(new Promise(()=>undefined));
  }

  it('keeps the pair while playback advances one frame at a time', async () => {
    await settleAt(1);
    expect(preview.frame(source,16,16,1,false,'clip-1',1.016,()=>undefined)).not.toBeNull();
  });

  it('drops the pair across a short cut that skips less than half a second', async () => {
    await settleAt(1);
    // A deleted source range of 300ms used to slip under the old 0.5s threshold
    // and paint the silhouette from before the cut over the frame after it.
    expect(preview.frame(source,16,16,1,false,'clip-1',1.3,()=>undefined)).toBeNull();
  });

  it('drops the pair when the picture geometry changes', async () => {
    await settleAt(1);
    expect(preview.frame(source,32,32,1,false,'clip-1',1.016,()=>undefined)).toBeNull();
  });

  it('drops the pair when the clip or its file identity changes', async () => {
    await settleAt(1);
    expect(preview.frame(source,16,16,1,false,'clip-1@2',1.016,()=>undefined)).toBeNull();
  });
});

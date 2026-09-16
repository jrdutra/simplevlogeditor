import { VIDEO_EFFECTS, effectAnimates, effectDefinition, effectDisplacesPixels, normalizeVideoEffect } from './video-effects';
import { VideoEffectEngine, backgroundFilter, subjectMaskCanvas } from './video-effect-engine';
import { SubjectMask, keepPrincipalRegions } from './subject-segmentation';
import { VideoEffectsGalleryComponent } from './video-effects-gallery.component';
import { ChangeDetectorRef } from '@angular/core';
import { FrameSource } from './frame-source';
import { composeFrame, disposeFrameEffects, needsCompositing } from './frame-compositor';
import { MediaClip, ProjectPlan } from './video-editor.models';
import { DEFAULT_PROJECT, DEFAULT_CAPTION, cloneEdits } from './video-editor-defaults';
import { restoreProject, serializeProject } from './video-editor-project.store';
import { EditorDeVideoComponent } from './editor-de-video.component';
import { TransitionPainter } from './video-transitions';

function clip(id: string): MediaClip {
  return { kind:'media',id,file:new File(['video'],`${id}.mp4`),summary:{
    fileName:`${id}.mp4`,fileSize:5,containerName:'mp4',kind:'video',durationSeconds:5,
    hasVideoTrack:true,hasAudioTrack:true,videoCodec:'avc',audioCodec:'aac',width:1280,height:720,
    frameRate:30,sampleRate:48000,channelCount:2,videoUsable:true,audioUsable:true,warning:null,
    isTimelapse:false,timelapseReason:null
  },info:null,overrides:null,detected:[],manualCuts:[],analysis:null,analyzedWith:null,
    replacementAudio:null,caption:null,thumbUrl:null,previewUrl:null };
}
const source: FrameSource = {width:320,height:180,draw:(ctx,x,y,w,h)=>{
  ctx.fillStyle='#cf5830';ctx.fillRect(x,y,w,h/2);ctx.fillStyle='#287da4';ctx.fillRect(x,y+h/2,w,h/2);
  ctx.fillStyle='#fff';ctx.fillRect(x+w/2,y,w/16,h);
}};
function surface(w=320,h=180) { const c=document.createElement('canvas');c.width=w;c.height=h;return c; }
function planFor(clips: MediaClip[]): ProjectPlan {
  return {clips:clips.map((clip,index)=>({clip,outputStart:index*5,outputDuration:5})),
    fillFrame:false,zooms:[],fades:[],tags:[],captions:[],transitions:[]} as unknown as ProjectPlan;
}

describe('Video Effects rendered pixels',()=>{
  let engine:VideoEffectEngine;
  beforeEach(()=>engine=new VideoEffectEngine());afterEach(()=>engine.dispose());
  function pixels(id:string,intensity=1,time=1.2) {
    const canvas=surface(),ctx=canvas.getContext('2d')!;
    engine.render(source,{id,intensity},320,180,time).draw(ctx,0,0,320,180);
    expect(engine.warning).withContext(id).toBe('');
    return new Uint8ClampedArray([...ctx.getImageData(10,10,1,1).data,...ctx.getImageData(10,170,1,1).data,...ctx.getImageData(159,10,1,1).data]);
  }
  it('preserves original pixels at zero intensity and when removing a preset',()=>{
    const original=pixels('none');
    expect(pixels('neon',0)).toEqual(original);
    pixels('neon');expect(pixels('none')).toEqual(original);
  });
  it('renders every non-AI preset, retains orientation and produces a grayscale result',()=>{
    const original=pixels('none');
    for(const preset of VIDEO_EFFECTS.filter(p=>!p.capabilities.length && p.id!=='none')) {
      expect(pixels(preset.id)).withContext(preset.name).not.toEqual(original);
    }
    const gray=pixels('black-white');
    expect(Math.abs(gray[0]-gray[1])).toBeLessThan(2);
    expect(Math.abs(gray[1]-gray[2])).toBeLessThan(2);
    const cinematic=pixels('cinematic');
    expect(cinematic[0]).toBeGreaterThan(cinematic[2]);
    const bottom=4;expect(cinematic[bottom+2]).toBeGreaterThan(cinematic[bottom]);
  });
  it('has deterministic animated VHS and glitch when seeking or rendering again',()=>{
    for(const id of ['vhs','glitch','light-leak']) {
      const first=pixels(id,1,0.1);pixels(id,1,5);
      expect(pixels(id,1,0.1)).toEqual(first);
      expect(pixels(id,1,3.7)).not.toEqual(first);
    }
  });
  it('preserves subjects and changes only the background with selective color',()=>{
    const canvas=surface(),ctx=canvas.getContext('2d')!;
    const mask={width:320,height:1,coverage:0.5,alpha:Uint8ClampedArray.from({length:320},(_,x)=>x>160?255:0)};
    engine.render(source,{id:'selective-color',intensity:1},320,180,0,1,false,mask).draw(ctx,0,0,320,180);
    const background=ctx.getImageData(10,10,1,1).data, person=ctx.getImageData(250,10,1,1).data;
    expect(Math.abs(background[0]-background[1])).toBeLessThan(2);
    expect(Array.from(person)).toEqual([207,88,48,255]);
    for(const id of ['background-blur','subject-glow','portrait-pop']) {
      engine.render(source,{id,intensity:1},320,180,0,1,false,null).draw(ctx,0,0,320,180);
      expect(ctx.getImageData(250,10,1,1).data).toEqual(person);
    }
    engine.render(source,{id:'selective-color',intensity:1},320,180,0,1,false,null).draw(ctx,0,0,320,180);
    const noSubject=ctx.getImageData(250,10,1,1).data;
    expect(Math.abs(noSubject[0]-noSubject[1])).toBeLessThan(2);
  });
  it('supports landscape, portrait, square, HD and 4K surfaces without changing dimensions',()=>{
    for(const [w,h] of [[1280,720],[1920,1080],[3840,2160],[720,1280],[1080,1080]]) {
      const output=engine.render(source,{id:'cinematic',intensity:0.7},w,h,0);
      expect([output.width,output.height]).toEqual([w,h]);expect(engine.warning).toBe('');
    }
  });
  it('never contaminates a following container or applies grading to captions',()=>{
    const a=clip('a'),b=clip('b');a.videoEffect={id:'neon',intensity:1};
    const plan=planFor([a,b]),canvas=surface(),ctx=canvas.getContext('2d')!;
    expect(needsCompositing(plan,1)).toBeTrue();expect(needsCompositing(plan,6)).toBeFalse();
    composeFrame(ctx,plan,1,320,180,source);
    composeFrame(ctx,plan,6,320,180,source);
    expect(Array.from(ctx.getImageData(10,10,1,1).data)).toEqual([207,88,48,255]);
    a.videoEffect={id:'black-white',intensity:1};
    plan.captions=[{start:0,end:4,caption:{...DEFAULT_CAPTION,text:'RED',textColor:'#ff0000',fontScale:0.12,outlinePercent:0,shadowEnabled:false,fadeIn:false,fadeOut:false}}];
    composeFrame(ctx,plan,1,320,180,source);
    const rgba=ctx.getImageData(0,0,320,180).data;
    let red=0;for(let i=0;i<rgba.length;i+=4)if(rgba[i]>220 && rgba[i+1]<20 && rgba[i+2]<20)red++;
    expect(red).toBeGreaterThan(10);disposeFrameEffects(ctx);
  });
  it('composites only while a timed effect segment is active',()=>{
    const a=clip('a'),plan=planFor([a]);
    plan.videoEffects=[{start:1,end:2,clipId:'a',effect:{id:'cinematic',intensity:1}}];
    expect(needsCompositing(plan,.5)).toBeFalse();
    expect(needsCompositing(plan,1.5)).toBeTrue();
    expect(needsCompositing(plan,2)).toBeFalse();
  });
  it('grades both transition sides independently',()=>{
    const a=clip('a'),b=clip('b');a.videoEffect={id:'black-white',intensity:1};
    const plan=planFor([a,b]),canvas=surface(),ctx=canvas.getContext('2d')!;
    const join={fromIndex:0,toIndex:1,start:4,end:5,settings:{kind:'dissolve',colour:'#000'}} as any;
    const painter=new TransitionPainter();
    composeFrame(ctx,plan,4,320,180,source,{entry:join,incoming:source,painter});
    const start=ctx.getImageData(10,10,1,1).data;expect(Math.abs(start[0]-start[1])).toBeLessThan(3);
    composeFrame(ctx,plan,5,320,180,source,{entry:join,incoming:source,painter});
    expect(Array.from(ctx.getImageData(10,10,1,1).data)).toEqual([207,88,48,255]);disposeFrameEffects(ctx);
  });
});

describe('container Video Effects persistence and history',()=>{
  it('round-trips independent effects and defaults old/unknown settings to Original',()=>{
    const a=clip('a'),b=clip('b');a.videoEffect={id:'neon',intensity:0.42};
    const stored=serializeProject([a,b],DEFAULT_PROJECT,3);
    expect(JSON.stringify(stored.settings)).not.toContain('videoEffect');
    const restored=restoreProject(JSON.parse(JSON.stringify(stored))).clips as MediaClip[];
    expect(restored[0].videoEffect).toEqual(a.videoEffect);
    expect(restored[1].videoEffect).toEqual({id:'none',intensity:0});
    expect(normalizeVideoEffect({id:'unknown'})).toEqual({id:'none',intensity:0});
  });
  it('round-trips timed effects and writes one whole-clip effect in the legacy field',()=>{
    const timed=clip('timed');
    timed.videoEffects=[
      {id:'one',effectId:'film',intensity:.6,startSeconds:1,durationSeconds:2},
      {id:'two',effectId:'vhs',intensity:.8,startSeconds:4,durationSeconds:1}
    ];
    const stored=serializeProject([timed],DEFAULT_PROJECT,3);
    const storedTimed=stored.clips[0] as import('./video-editor-project.store').StoredMediaClip;
    expect(storedTimed.videoEffect).toEqual({id:'none',intensity:0});
    expect(storedTimed.videoEffects).toEqual(timed.videoEffects);
    const restored=restoreProject(JSON.parse(JSON.stringify(stored))).clips[0] as MediaClip;
    expect(restored.videoEffects).toEqual(timed.videoEffects);
    expect(restored.videoEffects).not.toBe(timed.videoEffects);

    timed.videoEffects=[{id:'whole',effectId:'cinematic',intensity:.5}];
    const compatible=serializeProject([timed],DEFAULT_PROJECT,4).clips[0] as import('./video-editor-project.store').StoredMediaClip;
    expect(compatible.videoEffect).toEqual({id:'cinematic',intensity:.5});
    expect(compatible.videoEffects).toBeUndefined();
  });

  it('drops invalid timed effects while restoring a project document',()=>{
    const original=clip('invalid');
    const stored=serializeProject([original],DEFAULT_PROJECT,2);
    const media=stored.clips[0] as import('./video-editor-project.store').StoredMediaClip;
    media.videoEffects=[
      {effectId:'does-not-exist',intensity:1,startSeconds:0,durationSeconds:1},
      {effectId:'film',intensity:1,startSeconds:0,durationSeconds:Number.NaN}
    ];
    expect((restoreProject(stored).clips[0] as MediaClip).videoEffects).toEqual([]);
  });
  it('duplicates independently and restores effect selection/intensity with undo and redo',()=>{
    const editor:any=Object.create(EditorDeVideoComponent.prototype);
    Object.assign(editor,{clips:[clip('a')],project:{...DEFAULT_PROJECT,edits:cloneEdits(DEFAULT_PROJECT.edits)},nextId:2,
      history:[],future:[],lastChangeAt:0,exporting:null,revision:0,player:null,restoring:false,
      snapshotBoard:()=>({}),scheduleSave:()=>{},closeAllDialogs:()=>{},aplicarLayoutBoard:()=>{},cdr:{markForCheck:()=>{}}});
    editor.pending=editor.snapshot();editor.pendingSignature=editor.signature(editor.pending);
    editor.setVideoEffect(editor.clips[0],{id:'vhs',intensity:0.5});
    expect(editor.canUndo).toBeTrue();editor.undo();expect(editor.clips[0].videoEffect.id).toBe('none');
    editor.redo();expect(editor.clips[0].videoEffect).toEqual({id:'vhs',intensity:0.5});
    editor.duplicate(0);expect(editor.clips.length).toBe(2);
    expect(editor.clips[0].videoEffect).not.toBe(editor.clips[1].videoEffect);
    editor.setVideoEffect(editor.clips[1],{id:'cinematic',intensity:0.8});
    expect(editor.clips[0].videoEffect.id).toBe('vhs');
  });
});

describe('spatial effects and the Background Caption occlusion matte', () => {
  const matte: SubjectMask = {
    width: 4, height: 4, coverage: 0.5,
    alpha: Uint8ClampedArray.from({ length: 16 }, (_, index) => index % 4 < 2 ? 0 : 255)
  };

  it('knows which presets move pixels and which only regrade them', () => {
    expect(effectDisplacesPixels(effectDefinition('glitch'))).toBeTrue();
    expect(effectDisplacesPixels(effectDefinition('vhs'))).toBeTrue();
    expect(effectDisplacesPixels(effectDefinition('rgb-split'))).toBeTrue();
    expect(effectDisplacesPixels(effectDefinition('cinematic'))).toBeFalse();
    expect(effectDisplacesPixels(effectDefinition('background-blur'))).toBeFalse();
    expect(effectDisplacesPixels(effectDefinition('none'))).toBeFalse();
    expect(effectDisplacesPixels(null)).toBeFalse();
  });

  it('reuses the plain matte when no effect has been rendered', () => {
    const engine = new VideoEffectEngine();
    expect(engine.occlusionMask(matte)).toBe(subjectMaskCanvas(matte));
    engine.dispose();
  });

  it('reuses the plain matte for a preset that only regrades colour', () => {
    const engine = new VideoEffectEngine();
    const source: FrameSource = { width: 8, height: 8, draw: (ctx, x, y, w, h) => { ctx.fillStyle = '#888'; ctx.fillRect(x, y, w, h); } };
    engine.render(source, { id: 'cinematic', intensity: 1 }, 8, 8, 0);
    expect(engine.occlusionMask(matte)).toBe(subjectMaskCanvas(matte));
    engine.dispose();
  });

  it('never drops the occlusion when the GPU cannot displace the matte', () => {
    const engine = new VideoEffectEngine();
    const source: FrameSource = { width: 8, height: 8, draw: (ctx, x, y, w, h) => { ctx.fillStyle = '#888'; ctx.fillRect(x, y, w, h); } };
    engine.render(source, { id: 'glitch', intensity: 1 }, 8, 8, 0);
    // With or without a working WebGL context the caller must still receive a
    // usable matte: a failed displacement falls back to the undisplaced one and
    // reports a warning rather than exporting the text across the subject.
    const produced = engine.occlusionMask(matte);
    expect(produced.width).toBeGreaterThan(0);
    expect(produced.height).toBeGreaterThan(0);
    engine.dispose();
  });

  it('forgets the last render once the effect is cleared', () => {
    const engine = new VideoEffectEngine();
    const source: FrameSource = { width: 8, height: 8, draw: (ctx, x, y, w, h) => { ctx.fillStyle = '#888'; ctx.fillRect(x, y, w, h); } };
    engine.render(source, { id: 'glitch', intensity: 1 }, 8, 8, 0);
    engine.render(source, { id: 'none', intensity: 0 }, 8, 8, 0);
    expect(engine.occlusionMask(matte)).toBe(subjectMaskCanvas(matte));
    engine.dispose();
  });
});

describe('which presets need a clock of their own', () => {
  it('knows the animated presets from the still ones', () => {
    expect(effectAnimates(effectDefinition('vhs'))).toBeTrue();
    expect(effectAnimates(effectDefinition('glitch'))).toBeTrue();
    expect(effectAnimates(effectDefinition('light-leak'))).toBeTrue();
    expect(effectAnimates(effectDefinition('film'))).toBeTrue();
    expect(effectAnimates(effectDefinition('black-white'))).toBeFalse();
    expect(effectAnimates(effectDefinition('background-blur'))).toBeFalse();
    expect(effectAnimates(effectDefinition('none'))).toBeFalse();
    expect(effectAnimates(null)).toBeFalse();
  });

  it('drives the engine from the clip-local clock it was handed', () => {
    const engine = new VideoEffectEngine();
    const source: FrameSource = { width: 8, height: 8, draw: (ctx, x, y, w, h) => { ctx.fillStyle = '#777'; ctx.fillRect(x, y, w, h); } };
    // Preview and export both pass `time - clip.outputStart`, so the same
    // edited instant has to reach the engine as the same number regardless of
    // where the clip sits on the timeline.
    const engineTime = (outputTime: number, outputStart: number) => Math.max(0, outputTime - outputStart);
    expect(engineTime(5, 3)).toBe(engineTime(12, 10));
    engine.render(source, { id: 'glitch', intensity: 1 }, 8, 8, engineTime(5, 3));
    engine.dispose();
  });
});

describe('effect gallery previews', () => {
  const definitions = VIDEO_EFFECTS.filter(preset => preset.id !== 'none');

  it('renders every catalogue card at full strength, not at the default intensity', () => {
    // The card answers "what does this preset do"; the slider answers "how much
    // of it do I want". At the 0.75 default several graded presets were hard to
    // tell apart from the untouched frame.
    for (const preset of definitions) {
      expect(normalizeVideoEffect({ id: preset.id, intensity: 1 }).intensity).toBe(1);
    }
    expect(normalizeVideoEffect({ id: 'cinematic' }).intensity).toBe(0.75);
    expect(normalizeVideoEffect({ id: 'none', intensity: 1 }).intensity).toBe(0);
  });

  it('marks the presets whose card needs more than one sampled instant', () => {
    const animated = definitions.filter(preset => effectAnimates(preset)).map(preset => preset.id);
    expect(animated).toContain('glitch');
    expect(animated).toContain('vhs');
    expect(animated).toContain('light-leak');
    // Grain reads the clock too, so Film, Vintage and Noir belong with them.
    expect(animated).toContain('noir');
    // A still preset is rendered once; sampling it repeatedly would be waste.
    expect(animated).not.toContain('cinematic-warm');
    expect(animated).not.toContain('black-white');
    expect(animated).not.toContain('rgb-split');
  });
});

describe('Background Blur separates the background from the person', () => {
  it('does not blur the subject into the background around her', () => {
    const size = 200, edge = size / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const context = canvas.getContext('2d')!;
    // A pure red subject on a pure blue background: any red found in the
    // background afterwards arrived by being smeared there.
    const source: FrameSource = { width: size, height: size, draw: (target, x, y, width, height) => {
      target.fillStyle = '#ff0000'; target.fillRect(x, y, width / 2, height);
      target.fillStyle = '#0000ff'; target.fillRect(x + width / 2, y, width / 2, height);
    } };
    const mask: SubjectMask = {
      width: size, height: size, coverage: 0.5,
      alpha: Uint8ClampedArray.from({ length: size * size }, (_, index) => (index % size) < edge ? 255 : 0)
    };
    const engine = new VideoEffectEngine();
    engine.render(source, { id: 'background-blur', intensity: 1 }, size, size, 0, 1, false, mask)
      .draw(context, 0, 0, size, size);
    engine.dispose();

    // Three pixels into the background, well inside the blur radius that used
    // to carry the subject's colour outwards as a halo.
    const [red,, blue] = context.getImageData(edge + 3, edge, 1, 1).data;
    expect(red).toBeLessThan(40);
    expect(blue).toBeGreaterThan(100);
  });
});

describe('the gallery always offers a way back to Original', () => {
  const gallery = () => new VideoEffectsGalleryComponent(
    { markForCheck: () => undefined } as unknown as ChangeDetectorRef
  );

  it('keeps Original in every category', () => {
    for (const category of ['All','Classic','Creator','Creative']) {
      const view = gallery();
      view.filter = category;
      expect(view.visible.some(preset => preset.id === 'none')).toBeTrue();
    }
  });

  it('never offers Original twice', () => {
    const view = gallery();
    view.filter = 'All';
    expect(view.visible.filter(preset => preset.id === 'none').length).toBe(1);
  });

  it('names the chosen preset when its card is not on screen, and can fetch it', () => {
    const view = gallery();
    view.filter = 'Classic';
    view.effect = { id: 'neon-outline', intensity: 1 };
    expect(view.currentVisible).toBeFalse();
    expect(view.currentName).toBe('Neon Outline');
    view.revealCurrent();
    expect(view.currentVisible).toBeTrue();
    expect(view.filter).toBe('Creator');
  });

  it('copies a decoded video frame before releasing its temporary decoder', async () => {
    const view = gallery();
    const create = document.createElement.bind(document);
    const video = create('video');
    let width = 640, height = 360;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, get: () => width },
      videoHeight: { configurable: true, get: () => height },
      duration: { configurable: true, get: () => 0 }
    });
    spyOn(video, 'removeAttribute').and.callFake(() => { width = height = 0; });
    spyOn(video, 'load').and.stub();
    spyOn(document, 'createElement').and.callFake(((tag: string) =>
      tag === 'video' ? video : create(tag)) as typeof document.createElement);
    spyOn(CanvasRenderingContext2D.prototype, 'drawImage').and.stub();

    const pending = (view as unknown as {
      grabFrame(url: string, still: boolean): Promise<FrameSource>;
    }).grabFrame('blob:decoded-container', false);
    video.onloadeddata?.(new Event('loadeddata'));
    const frame = await pending;

    expect(frame.width).toBe(640);
    expect(frame.height).toBe(360);
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
  });
});

describe('the subject of a shot is people, and everything else is background', () => {
  const W = 200, H = 200;
  const blank = () => new Uint8ClampedArray(W * H);
  const box = (alpha: Uint8ClampedArray, x0: number, y0: number, w: number, h: number, value = 255) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) alpha[y * W + x] = value;
  };
  const covered = (alpha: Uint8ClampedArray) => alpha.reduce((total, value) => total + (value >= 40 ? 1 : 0), 0);

  it('keeps one person exactly as the model matted her', () => {
    const alpha = blank();
    box(alpha, 60, 40, 80, 140);
    const before = covered(alpha);
    expect(keepPrincipalRegions(alpha, W, H)).toBe(1);
    expect(covered(alpha)).toBe(before);
  });

  it('keeps more than one person', () => {
    const alpha = blank();
    box(alpha, 20, 40, 60, 140);
    box(alpha, 120, 40, 60, 140);
    const before = covered(alpha);
    expect(keepPrincipalRegions(alpha, W, H)).toBe(2);
    expect(covered(alpha)).toBe(before);
  });

  it('drops the speckle that flickers in and out between frames', () => {
    const alpha = blank();
    box(alpha, 60, 40, 80, 140);
    box(alpha, 10, 10, 6, 6);
    box(alpha, 180, 180, 5, 5);
    expect(keepPrincipalRegions(alpha, W, H)).toBe(1);
    expect(covered(alpha)).toBe(80 * 140);
  });

  it('drops a small object the matte picked up, so it is blurred with the rest', () => {
    const alpha = blank();
    box(alpha, 60, 40, 80, 140);
    box(alpha, 10, 150, 26, 26);
    expect(keepPrincipalRegions(alpha, W, H)).toBe(1);
    expect(covered(alpha)).toBe(80 * 140);
  });

  it('leaves a soft-edged matte and an empty frame alone', () => {
    const soft = blank();
    box(soft, 60, 40, 80, 140, 90);
    expect(keepPrincipalRegions(soft, W, H)).toBe(1);
    expect(covered(soft)).toBe(80 * 140);
    expect(keepPrincipalRegions(blank(), W, H)).toBe(0);
  });

  it('treats a frame with nobody in it as entirely background', () => {
    // Blur, Pop, Darken and Selective Color describe what happens to the
    // background, so with no person the whole picture gets it.
    expect(backgroundFilter('blur', 1000)).toBe('blur(16px)');
    expect(backgroundFilter('darken', 1000)).toBe('brightness(0.58)');
    expect(backgroundFilter('selective', 1000)).toBe('grayscale(1)');
    expect(backgroundFilter('pop', 1000)).toContain('blur(4px)');
    // Glow and Outline put light around a subject: without one there is nothing
    // for them to do, and the picture is left alone.
    expect(backgroundFilter('glow', 1000)).toBe('none');
    expect(backgroundFilter('outline', 1000)).toBe('none');
  });
});

describe('no preset draws an outline around the subject unless that is its purpose', () => {
  const SIZE = 200, EDGE = 80, SUBJECT_LEFT = 120, SUBJECT_RIGHT = 170;

  /** Dark on the left, bright on the right, with the subject in the bright part.
   *  The mean colour of the whole frame is therefore much darker than the
   *  background immediately around her — which is what used to be painted into
   *  the ring the grown matte leaves, and read as a shadow. */
  const source: FrameSource = { width: SIZE, height: SIZE, draw: (target, x, y, width, height) => {
    target.fillStyle = '#000000';
    target.fillRect(x, y, width * (EDGE / SIZE), height);
    target.fillStyle = '#c8c8c8';
    target.fillRect(x + width * (EDGE / SIZE), y, width * (1 - EDGE / SIZE), height);
  } };

  const mask: SubjectMask = {
    width: SIZE, height: SIZE, coverage: 0.1,
    alpha: Uint8ClampedArray.from({ length: SIZE * SIZE }, (_, index) => {
      const x = index % SIZE, y = (index - x) / SIZE;
      return x >= SUBJECT_LEFT && x < SUBJECT_RIGHT && y >= 40 && y < 160 ? 255 : 0;
    })
  };

  it('leaves the background beside the subject at its own brightness', () => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE; canvas.height = SIZE;
    const context = canvas.getContext('2d')!;
    const engine = new VideoEffectEngine();
    engine.render(source, { id: 'background-blur', intensity: 1 }, SIZE, SIZE, 0, 1, false, mask)
      .draw(context, 0, 0, SIZE, SIZE);
    engine.dispose();

    // Just outside the silhouette, inside the ring the grown matte removed.
    for (let x = SUBJECT_RIGHT + 4; x < SUBJECT_RIGHT + 14; x++) {
      const [red, green, blue] = context.getImageData(x, 100, 1, 1).data;
      const luminance = (red + green + blue) / 3;
      expect(luminance)
        .withContext(`ring pixel at x=${x} should keep the bright background, not the frame's mean`)
        .toBeGreaterThan(170);
    }
    engine.dispose();
  });
});

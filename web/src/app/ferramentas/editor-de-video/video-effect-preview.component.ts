import { Component, Input, Output, EventEmitter, ViewChild, ElementRef, AfterViewInit, OnChanges, OnDestroy, NgZone, ChangeDetectorRef } from '@angular/core';
import { VideoEffect, effectAnimates, effectDefinition, normalizeVideoEffect, effectNeedsSubject } from './video-effects';
import { VideoEffectEngine } from './video-effect-engine';
import { SubjectEffectPreview } from './subject-effect-preview';
import { subjectFailureMessage } from './subject-segmentation';
import { FrameSource } from './frame-source';

/**
 * Container's existing source player with a composited visual surface. Native
 * controls retain audio/seek.
 *
 * **Which clock this is.** This surface previews the *source file*, so its
 * animated effects run on the source clock — the position the reader scrubbed
 * to in the original recording. The timeline preview and the export both run
 * on the clip's output clock (`time - clip.outputStart`, after trims, deleted
 * ranges and speed), and those two agree with each other frame for frame. The
 * two clocks are deliberately different readings of the same footage, so the
 * caption below says which one is on screen rather than pretending they match.
 *
 * A still image has no clock at all, which used to freeze every animated preset
 * at t=0 here. It now gets a looping playhead across the container's own output
 * duration, so a moving preset can actually be judged before it is applied.
 */
@Component({selector:'app-video-effect-preview',standalone:true,
  template:`<div class="preview">
    <video #video [src]="image ? null : src" [hidden]="image" controls playsinline
      controlsList="nofullscreen nodownload noremoteplayback" disablePictureInPicture disableRemotePlayback
      (seeking)="resetFrame()"
      (loadeddata)="onMediaLoaded()" (seeked)="draw()" (play)="start()" (pause)="draw()" (timeupdate)="timeChange.emit(video.currentTime)"></video>
    @if(image){<img #still [src]="src" alt="Container preview" (load)="onMediaLoaded()">}
    <canvas #canvas [class.still]="image" aria-label="Video effect preview"></canvas>
  </div>
  <p role="status">{{status}}@if(canRetry){<button type="button" class="retry" (click)="retry()">Retry</button>}</p>
  <p class="scope">{{scope}}</p>`,
  styles:[`:host{display:block}.preview{position:relative;background:#000;line-height:0;isolation:isolate}video,img{width:100%;max-height:380px;display:block;object-fit:contain}video[hidden]{display:none}canvas{position:absolute;inset:0;width:100%;height:calc(100% - 48px);object-fit:contain;pointer-events:none;background:#000}canvas.still{height:100%}video{padding-bottom:48px;box-sizing:content-box}p{font-size:12px;line-height:1.4;margin:6px 0;min-height:1em}p.scope{font-size:11px;opacity:.65;margin:2px 0 0;min-height:0}button.retry{font:inherit;margin-left:8px;padding:1px 8px;cursor:pointer}`]
})
export class VideoEffectPreviewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() src = ''; @Input() image = false; @Input() effect?: VideoEffect; @Input() clipId = '';
  /** Output duration of this container, used as the span of the still playhead. */
  @Input() durationSeconds = 0;
  @Output() timeChange = new EventEmitter<number>();
  @ViewChild('video') video?: ElementRef<HTMLVideoElement>;
  @ViewChild('still') still?: ElementRef<HTMLImageElement>;
  @ViewChild('canvas') canvas?: ElementRef<HTMLCanvasElement>;
  status = ''; scope = ''; canRetry = false;
  private raf = 0; private destroyed = false;
  /** The src the currently decoded picture belongs to. A newly bound src leaves
   * the previous image decoded in the element, and analysing that frame would
   * attribute one file's subject to another. */
  private loadedSrc = '';
  private stillStart = 0;
  private engine = new VideoEffectEngine(); private frames = new SubjectEffectPreview();
  constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}
  ngAfterViewInit(): void { this.draw(); }
  ngOnChanges(changes: import('@angular/core').SimpleChanges): void {
    if(changes['src']) {
      this.loadedSrc = '';
      this.stillStart = 0;
      this.frames.dispose(); this.frames = new SubjectEffectPreview();
    }
    this.draw();
  }
  onMediaLoaded(): void { this.loadedSrc = this.src; this.frames.reset(); this.draw(); this.start(); }
  resetFrame(): void { this.frames.reset(); }
  retry(): void {
    if (!this.frames.retry()) return;
    this.canRetry = false; this.status = '';
    this.draw();
  }
  start(): void {
    cancelAnimationFrame(this.raf);
    this.zone.runOutsideAngular(() => {
      const running = () => this.image ? this.animatedStill() : !this.video?.nativeElement.paused;
      const tick=()=>{this.draw();if(!this.destroyed && running())this.raf=requestAnimationFrame(tick);}; tick();
    });
  }
  /** A still only needs a running clock while the chosen preset actually moves. */
  private animatedStill(): boolean {
    return this.image && effectAnimates(effectDefinition(normalizeVideoEffect(this.effect).id)) &&
      normalizeVideoEffect(this.effect).intensity > 0;
  }
  /** The source clock for video; a looping container-duration clock for a still. */
  private sourcePreviewClock(): number {
    if (!this.image) return this.video?.nativeElement.currentTime ?? 0;
    if (!this.animatedStill()) return 0;
    if (!this.stillStart) this.stillStart = performance.now();
    const span = Math.max(0.5, this.durationSeconds || 5);
    return ((performance.now() - this.stillStart) / 1000) % span;
  }
  draw(): void {
    if(this.destroyed) return;
    const canvas=this.canvas?.nativeElement, video=this.video?.nativeElement, img=this.still?.nativeElement;
    if(!canvas || (this.image ? !img?.naturalWidth : !video || video.readyState<2 || video.seeking)) return;
    // Never compose, and above all never analyse, a picture left over from the
    // file this container was showing a moment ago.
    if(this.loadedSrc !== this.src) return;
    const media=this.image ? img! : video!;
    const sw=this.image?img!.naturalWidth:video!.videoWidth, sh=this.image?img!.naturalHeight:video!.videoHeight;
    if(!sw || !sh) return;
    const ratio=Math.min(1,640/Math.max(sw,sh)), w=Math.round(sw*ratio),h=Math.round(sh*ratio);
    if(canvas.width!==w)canvas.width=w;if(canvas.height!==h)canvas.height=h;
    const source:FrameSource={width:sw,height:sh,draw:(ctx,x,y,w,h)=>ctx.drawImage(media,x,y,w,h)};
    const effect=normalizeVideoEffect(this.effect), time=this.sourcePreviewClock();
    const pair=effectNeedsSubject(effect)?this.frames.frame(source,w,h,1,false,this.clipId,time,()=>this.draw()):null;
    this.engine.render(pair?.source ?? source,effect,w,h,time,1,false,pair?.mask ?? null).draw(canvas.getContext('2d')!,0,0,w,h);
    this.publishStatus(effect, pair);
  }
  /** Loading, no person, and each kind of technical failure read differently. */
  private publishStatus(effect: VideoEffect, pair: { mask: unknown } | null): void {
    const vision = this.frames.vision;
    const failure = vision.failure;
    let status: string;
    let retry = false;
    if (this.engine.warning) status = 'GPU effect unavailable. Original video is shown.';
    else if (!effectNeedsSubject(effect)) status = '';
    else if (failure) { status = subjectFailureMessage(failure, 'effect'); retry = failure.retryable; }
    else if (vision.state === 'loading' || !pair) {
      status = vision.status().reduced ? 'Preparing AI Effect… (reduced preview)' : 'Preparing AI Effect…';
    }
    else if (!pair.mask) status = 'No person detected. Original video is shown.';
    else {
      const reading = vision.status();
      status = reading.reduced
        ? `Reduced preview: analysing at ${reading.analysisEdge}px to keep up. The export is unaffected.`
        : '';
    }
    const scope = this.image
      ? (this.animatedStill() ? 'Source preview · animated preset shown on a looping container-duration clock' : 'Source preview')
      : 'Source preview · source clock. The timeline preview and the export use the edited clip clock.';
    if(status!==this.status || retry!==this.canRetry || scope!==this.scope) {
      this.zone.run(()=>{this.status=status;this.canRetry=retry;this.scope=scope;this.cdr.markForCheck();});
    }
  }
  ngOnDestroy(): void {this.destroyed=true;cancelAnimationFrame(this.raf);this.frames.dispose();this.engine.dispose();}
}

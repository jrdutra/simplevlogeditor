import { Component, Input, Output, EventEmitter, OnChanges, OnDestroy, ChangeDetectorRef } from '@angular/core';
import {
  VideoEffect, VideoEffectDefinition, VIDEO_EFFECTS, effectAnimates, effectDefinition, normalizeVideoEffect, effectNeedsSubject
} from './video-effects';
import { VideoEffectEngine } from './video-effect-engine';
import { SubjectSegmentationClient, SubjectMask, subjectFailureMessage } from './subject-segmentation';
import { FrameSource } from './frame-source';

/** Instants tried for a preset whose picture changes with time. */
const ANIMATED_SAMPLES = [0.35, 1.5, 2.9] as const;
/** Every Nth pixel is compared when judging which sample shows the most. */
const DIFFERENCE_STRIDE = 16;
/** Longest wait for a frame of the container before falling back to the list thumbnail. */
const FRAME_TIMEOUT_MS = 4000;
/** Widest edge a preview is rendered at. */
const PREVIEW_EDGE = 480;

@Component({
  selector: 'app-video-effects-gallery', standalone: true,
  template: `
    <div class="categories" aria-label="Effect categories">
      @for (category of categories; track category) {
        <button type="button" [class.selected]="filter === category" [attr.aria-pressed]="filter === category"
          (click)="changeFilter(category)">{{ category }}</button>
      }
    </div>
    <div class="gallery" role="group" aria-label="Video Effects">
      @for (preset of visible; track preset.id) {
        <button type="button" class="effect" [class.selected]="current.id === preset.id" [disabled]="disabled"
          [attr.aria-pressed]="current.id === preset.id" (click)="choose(preset.id)" [title]="preset.name">
          <div class="picture">
            @if (preset.id === 'none') {
              @if (thumbnail) { <img [src]="thumbnail" alt="" loading="lazy"> }
              @else { <span class="placeholder">Preview unavailable</span> }
            } @else if (thumbnails[preset.id]) {
              <img [src]="thumbnails[preset.id]" alt="" loading="lazy">
            } @else if (!thumbnail) {
              <span class="placeholder">Preview unavailable</span>
            } @else {
              <!-- The source frame, plainly marked as not yet the effect. It is
                   never presented as a computed preview of this preset. -->
              <img [src]="thumbnail" alt="" class="raw" loading="lazy">
              <span class="state">{{ needsPreparation(preset) ? 'AI preview not prepared' : 'Rendering preview…' }}</span>
            }
            @if (preset.capabilities.length) { <span class="ai">AI</span> }
            @if (current.id === preset.id) { <span class="check">✓</span> }
          </div>
          <span class="name">{{ preset.name }}</span>
        </button>
      }
    </div>
    @if (!currentVisible) {
      <p class="active">Active effect: <strong>{{ currentName }}</strong>
        <button type="button" class="more" (click)="revealCurrent()">Show its card</button></p>
    }
    @if (limit < filtered.length) { <button type="button" class="more" (click)="showMore()">Show more effects</button> }
    @if (!aiThumbnails) { <button type="button" class="more" (click)="enableAIThumbnails()">Prepare AI previews</button> }
    @if (retryable) { <button type="button" class="more" (click)="retryAIThumbnails()">Retry AI previews</button> }
    @if (current.id !== 'none') {
      <label class="intensity">Intensity <span>{{ (current.intensity * 100).toFixed(0) }}%</span>
        <input type="range" min="0" max="100" step="1" [value]="current.intensity * 100" [disabled]="disabled"
          (input)="effectChange.emit({ id: current.id, intensity: +$any($event.target).value / 100 })">
      </label>
    }
    <p class="note" role="status">{{ status || defaultNote }}</p>
  `,
  styles: [`
    :host{display:block;color:inherit}.categories{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}
    button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line-soft);background:var(--panel-well);border-radius:8px}
    button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.5;cursor:default}
    .categories button,.more{padding:7px 12px;font-size:12px}.selected{border-color:var(--accent)!important;background:var(--panel-raised);box-shadow:0 0 0 1px var(--accent)}
    .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:10px}.effect{padding:0;overflow:hidden;text-align:left}
    .picture{position:relative;aspect-ratio:16/10;background:#101827}.picture img{width:100%;height:100%;object-fit:cover;display:block}
    .picture img.raw{opacity:.3}
    .state{position:absolute;inset:auto 0 0 0;padding:4px 6px;font-size:10px;line-height:1.3;text-align:center;background:rgba(16,24,39,.88);color:var(--text-muted)}
    .name{display:block;padding:8px;font-size:12px;font-weight:500}.check,.ai{position:absolute;top:5px;background:var(--panel-well);color:#fff;border-radius:4px;padding:2px 5px;font-size:10px}.check{right:5px;background:var(--neon-deep)}.ai{left:5px}.placeholder{font-size:11px;padding:12px;display:block;color:var(--text-muted)}
    .active{font-size:12px;line-height:1.5;margin:12px 0 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .more{margin:12px 6px 0 0}.active .more{margin:0}.intensity{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;font-size:13px}.intensity span{margin-left:auto;font-variant-numeric:tabular-nums}.intensity input{width:100%;accent-color:var(--accent)}.note{font-size:12px;line-height:1.5;opacity:.75;margin-bottom:0}
  `]
})
export class VideoEffectsGalleryComponent implements OnChanges, OnDestroy {
  @Input() effect?: VideoEffect;
  @Input() thumbnail: string | null = null;
  /** The container's own media. Preferred over the list thumbnail, which is a
   *  160x90 JPEG: grain, channel split and glitch offsets are all measured
   *  against the frame, so judging a preset on a picture that small judges it
   *  on something the finished video will never look like. */
  @Input() sourceUrl: string | null = null;
  /**
   * Where in the source to take the preview frame, in seconds.
   *
   * The middle of the section the reader is configuring, so every card shows
   * the preset acting on the picture it will actually act on — not on an
   * arbitrary frame half a second in, which for a section late in a clip is a
   * different shot entirely.
   */
  @Input() previewTime = 0;
  @Input() image = false;
  @Input() clipId = '';
  @Input() disabled = false;
  @Output() effectChange = new EventEmitter<VideoEffect>();
  readonly categories = ['All','Classic','Creator','Creative'];
  readonly defaultNote =
    'Previews are this container’s own frame at full strength, so each preset is legible. ' +
    'The Intensity slider sets how much of it is applied. Only this container; choose Original to remove the effect.';
  filter = 'All'; limit = 8; status = ''; aiThumbnails = false; retryable = false;
  /** Until the reader picks a category themselves, the gallery follows the choice. */
  private categoryChosenByReader = false;
  private grabbedAt = Number.NaN;
  thumbnails: Record<string,string> = {};
  private engine = new VideoEffectEngine();
  private vision = new SubjectSegmentationClient();
  private source: FrameSource | null = null;
  private mask: SubjectMask | null = null;
  private analyzed = false;
  private generation = 0;
  private loading: HTMLImageElement | null = null;
  private disposed = false;
  constructor(private readonly cdr: ChangeDetectorRef) {}
  get current(): VideoEffect { return normalizeVideoEffect(this.effect); }
  get filtered() { return VIDEO_EFFECTS.filter(preset => this.filter === 'All' || preset.category === this.filter); }
  get visible(): readonly VideoEffectDefinition[] {
    const shown = this.filtered.slice(0,this.limit);
    // Removing the effect is never one category away: Original is offered
    // wherever the reader happens to be looking.
    if (shown.some(preset => preset.id === 'none')) return shown;
    const original = VIDEO_EFFECTS.find(preset => preset.id === 'none');
    return original ? [original, ...shown] : shown;
  }
  /** The chosen preset can sit outside the filter or past the visible slice. */
  get currentVisible(): boolean { return this.visible.some(preset => preset.id === this.current.id); }
  get currentName(): string { return effectDefinition(this.current.id)?.name ?? 'Original'; }
  /** Shows the category the applied preset lives in, with its card in view. */
  private followCurrent(): void {
    const definition = effectDefinition(this.current.id);
    if (!definition || definition.id === 'none') return;
    this.filter = definition.category;
    const index = this.filtered.findIndex(preset => preset.id === definition.id);
    this.limit = Math.max(8, Math.ceil((index + 1) / 8) * 8);
  }

  /** Brings the chosen preset's card into view without disturbing anything else. */
  revealCurrent(): void {
    const definition = effectDefinition(this.current.id);
    if (!definition) return;
    this.filter = definition.category;
    const index = this.filtered.findIndex(preset => preset.id === definition.id);
    this.limit = Math.max(8, Math.ceil((index + 1) / 8) * 8);
    void this.renderThumbnails();
  }
  /** A portrait preset whose much slower analysis has not been asked for yet. */
  needsPreparation(preset: VideoEffectDefinition): boolean {
    return !this.aiThumbnails && effectNeedsSubject({ id: preset.id, intensity: 1 });
  }
  ngOnChanges(changes: import('@angular/core').SimpleChanges): void {
    // Opening on "All" hid the preset that is actually applied whenever it sat
    // in another category, so the reader had to go looking for their own
    // choice. The gallery follows the selection until they pick a category.
    if (changes['effect'] && !this.categoryChosenByReader) this.followCurrent();
    // A new instant means new pictures, but typing in the time fields must not
    // re-decode on every keystroke: a quarter of a second is the smallest move
    // worth a new frame.
    const movedInTime = changes['previewTime'] &&
      (!Number.isFinite(this.grabbedAt) || Math.abs(this.previewTime - this.grabbedAt) > 0.25);
    if (changes['thumbnail'] || changes['clipId'] || changes['sourceUrl'] || movedInTime) {
      ++this.generation; this.source = null; this.mask = null; this.analyzed = false; this.thumbnails = {};
      this.status = ''; this.retryable = false;
      this.vision.dispose(); this.vision = new SubjectSegmentationClient();
      if (this.loading) this.loading.onload = this.loading.onerror = null;
      if (!this.thumbnail && !this.sourceUrl) return;
      const generation = this.generation;
      this.grabbedAt = this.previewTime;
      void this.loadSource(generation).then(source => {
        if (generation !== this.generation || this.disposed) return;
        if (!source) { this.status = 'The container picture could not be read.'; this.cdr.markForCheck(); return; }
        this.source = source;
        void this.renderThumbnails();
      });
    }
  }

  /** A real frame of this container, with the list thumbnail as the fallback. */
  private async loadSource(generation: number): Promise<FrameSource | null> {
    if (this.sourceUrl) {
      const frame = await this.grabFrame(this.sourceUrl, this.image).catch(() => null);
      if (generation !== this.generation || this.disposed) return null;
      if (frame) return frame;
    }
    return this.thumbnail ? this.loadImageSource(this.thumbnail).catch(() => null) : null;
  }

  private loadImageSource(url: string): Promise<FrameSource> {
    return new Promise((resolve, reject) => {
      const image = this.loading = new Image();
      image.onload = () => resolve({
        width: image.naturalWidth, height: image.naturalHeight,
        draw: (ctx,x,y,w,h) => ctx.drawImage(image,x,y,w,h)
      });
      image.onerror = () => reject(new Error('The container picture could not be loaded.'));
      image.src = url;
    });
  }

  /**
   * One frame of a video container, decoded off-screen.
   *
   * Half a second in rather than at zero, because a recording that opens on a
   * black frame would otherwise have every preset previewed on black. Any
   * failure here is not an error the reader needs to see: the list thumbnail
   * still gives a usable, if smaller, picture.
   */
  private grabFrame(url: string, still: boolean): Promise<FrameSource> {
    if (still) return this.loadImageSource(url);
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true; video.preload = 'auto'; video.playsInline = true;
      let settled = false;
      const cleanup = () => {
        video.onloadeddata = video.onseeked = video.onerror = null;
        video.removeAttribute('src');
        try { video.load(); } catch { /* detached element */ }
      };
      // The successful branch still needs videoWidth/videoHeight and the decoded
      // pixels. Removing `src` before `run` makes Chromium reset both dimensions
      // to zero, so the gallery silently fell back to the small list thumbnail.
      // Read/copy the frame first and release the detached decoder afterwards.
      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { run(); } finally { cleanup(); }
      };
      const timer = setTimeout(() => finish(() => reject(new Error('The container frame timed out.'))), FRAME_TIMEOUT_MS);
      const draw = () => finish(() => {
        const width = video.videoWidth, height = video.videoHeight;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, width); canvas.height = Math.max(1, height);
        const context = canvas.getContext('2d');
        if (!width || !height || !context) { reject(new Error('The container frame could not be read.')); return; }
        context.drawImage(video, 0, 0, width, height);
        resolve({ width, height, draw: (ctx,x,y,w,h) => ctx.drawImage(canvas,x,y,w,h) });
      });
      video.onloadeddata = () => {
        const duration = video.duration;
        // The instant the reader is working on, kept inside the file.
        const wanted = Number.isFinite(this.previewTime) && this.previewTime > 0 ? this.previewTime : 0.5;
        const target = Number.isFinite(duration) && duration > 0
          ? Math.max(0, Math.min(wanted, Math.max(0, duration - 0.05)))
          : 0;
        if (target > 0) { video.onseeked = draw; video.currentTime = target; } else draw();
      };
      video.onerror = () => finish(() => reject(new Error('The container could not be decoded.')));
      video.src = url;
    });
  }
  choose(id: string): void {
    if (this.disabled) return;
    this.effectChange.emit(normalizeVideoEffect({id}));
    if (effectNeedsSubject({id,intensity:1})) this.enableAIThumbnails();
  }
  enableAIThumbnails(): void { this.aiThumbnails = true; void this.renderThumbnails(); }
  retryAIThumbnails(): void {
    if (!this.vision.retry()) return;
    this.analyzed = false; this.mask = null; this.retryable = false; this.status = '';
    for (const preset of VIDEO_EFFECTS) if (preset.capabilities.length) delete this.thumbnails[preset.id];
    void this.renderThumbnails();
  }
  changeFilter(category: string): void {
    this.categoryChosenByReader = true;
    this.filter = category; this.limit = 8; void this.renderThumbnails();
  }
  showMore(): void { this.limit += 8; void this.renderThumbnails(); }
  private async renderThumbnails(): Promise<void> {
    const source = this.source;
    if (!source || this.disposed) return;
    const generation = ++this.generation;
    const ratio = Math.min(1,PREVIEW_EDGE/Math.max(source.width,source.height));
    const width = Math.max(1,Math.round(source.width*ratio)), height = Math.max(1,Math.round(source.height*ratio));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!;
    // The untouched frame, kept to judge how much of itself a sampled instant
    // of an animated preset actually changes.
    context.clearRect(0,0,width,height);
    source.draw(context,0,0,width,height);
    const original = context.getImageData(0,0,width,height).data;
    // Classical previews never wait for the much more expensive portrait model.
    for (const preset of [...this.visible].sort((a,b) => a.capabilities.length-b.capabilities.length)) {
      if (generation !== this.generation || this.disposed) return;
      if (preset.id === 'none' || this.thumbnails[preset.id]) continue;
      // Full strength on purpose: the card is a catalogue entry, and at the
      // default 75% several graded presets are hard to tell from the original.
      // How much of it is applied stays with the Intensity slider.
      const effect = normalizeVideoEffect({id:preset.id,intensity:1});
      if (effectNeedsSubject(effect) && !this.aiThumbnails) continue;
      if (effectNeedsSubject(effect) && !this.analyzed) {
        this.status = 'Preparing AI Effect…'; this.cdr.markForCheck();
        const mask = await this.vision.maskFor(source,width,height,1,false,this.clipId,0);
        if (generation !== this.generation || this.disposed) return;
        this.mask = mask;
        this.analyzed = true;
        const failure = this.vision.failure;
        this.retryable = !!failure?.retryable;
        this.status = failure
          ? subjectFailureMessage(failure, 'effect')
          : this.mask ? '' : 'No person detected in this thumbnail. Portrait effects keep the original image.';
        // A model that failed has produced nothing to show: leaving the card in
        // its marked "not the effect" state is honest, a rendered original is not.
        if (failure) { this.cdr.markForCheck(); return; }
      }
      this.renderBestSample(preset,effect,source,context,width,height,original);
      this.thumbnails[preset.id] = canvas.toDataURL('image/jpeg',0.8);
      if (this.engine.warning) this.status = 'GPU effects unavailable. Original image is shown.';
      this.cdr.markForCheck();
      await new Promise<void>(resolve => setTimeout(resolve,0));
    }
  }
  /**
   * Leaves the canvas holding the most representative frame of this preset.
   *
   * A still preset has one picture. An animated one — tape wobble, a glitch
   * burst, a drifting light leak — has a different picture every instant, and a
   * single fixed moment can easily land between bursts, which used to produce a
   * Glitch card indistinguishable from the untouched frame. Rather than trying
   * to predict the shader's own noise from here, each candidate instant is
   * rendered and the one that changes the frame most is the one kept.
   */
  private renderBestSample(
    preset: VideoEffectDefinition, effect: VideoEffect, source: FrameSource,
    context: CanvasRenderingContext2D, width: number, height: number, original: Uint8ClampedArray
  ): void {
    const draw = (time: number) => {
      context.clearRect(0,0,width,height);
      this.engine.render(source,effect,width,height,time,1,false,this.mask).draw(context,0,0,width,height);
    };
    if (!effectAnimates(preset)) { draw(1.5); return; }
    let bestTime: number = ANIMATED_SAMPLES[0], bestScore = -1;
    for (const time of ANIMATED_SAMPLES) {
      draw(time);
      const score = this.difference(context.getImageData(0,0,width,height).data,original);
      if (score > bestScore) { bestScore = score; bestTime = time; }
    }
    draw(bestTime);
  }
  private difference(rendered: Uint8ClampedArray, original: Uint8ClampedArray): number {
    let total = 0, counted = 0;
    for (let index = 0; index < rendered.length; index += 4 * DIFFERENCE_STRIDE) {
      total += Math.abs(rendered[index] - original[index]) +
        Math.abs(rendered[index+1] - original[index+1]) +
        Math.abs(rendered[index+2] - original[index+2]);
      counted++;
    }
    return counted ? total / counted : 0;
  }
  ngOnDestroy(): void {
    this.disposed = true; ++this.generation;
    if (this.loading) this.loading.onload = this.loading.onerror = null;
    this.engine.dispose(); this.vision.dispose(); this.thumbnails = {}; this.source = null;
  }
}

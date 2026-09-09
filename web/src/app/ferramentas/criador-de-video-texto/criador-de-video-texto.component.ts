import { CommonModule, isPlatformBrowser } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Inject,
  NgZone,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  ViewChild
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { DataService } from '../../data.service';
import { TextVideoService } from './text-video.service';
import { drawFrame, SceneContext } from './text-scene-renderer';
import {
  ANIMATIONS,
  FONTS,
  FRAME_RATES,
  IMAGE_FORMATS,
  LEGIBILITY_OPTIONS,
  LIMITS,
  RESOLUTIONS,
  VIDEO_FORMATS,
  WEIGHTS,
  fontStack,
  imageFormat,
  resolution,
  suggestedReveal,
  videoFormat
} from './text-video-presets';
import {
  HorizontalAlign,
  Legibility,
  RenderCanceledError,
  RenderError,
  RenderProgress,
  RenderResult,
  TextAnimation,
  TextScene,
  VerticalAlign,
  sceneDuration,
  stillTime
} from './text-video.models';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';

/** The sliders and number fields that share one clamped setter. */
type NumericField =
  | 'holdSeconds'
  | 'fadeSeconds'
  | 'fontScale'
  | 'margin'
  | 'lineHeight'
  | 'letterSpacing'
  | 'imageQuality';

const STAGE_LABEL: Record<RenderProgress['stage'], string> = {
  preparing: 'Preparing',
  drawing: 'Drawing frames',
  audio: 'Adding the sound',
  muxing: 'Assembling',
  finishing: 'Finishing'
};

/** Longest side of the preview canvas, before the browser scales it down. */
const PREVIEW_LONG_SIDE = 960;

/** How often the time readout under the preview is refreshed, in ms. */
/** A background video that has not loaded by now is one that will not. */
const VIDEO_LOAD_TIMEOUT = 8000;

/** How far the background video may wander from the preview before it is pulled back. */
const VIDEO_DRIFT = 0.35;

const READOUT_INTERVAL = 200;

/**
 * Text Video & Image Maker.
 *
 * The component owns the settings and the preview loop, and nothing else: every
 * frame on screen is drawn by the same renderer that will later draw the file,
 * from the same scene object. That is the design decision the whole tool rests
 * on — there is no second implementation of "what it will look like" to drift
 * away from the first.
 */
@Component({
  selector: 'app-criador-de-video-texto',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule
  ,
    HelpPanelComponent],
  templateUrl: './criador-de-video-texto.component.html',
  styleUrl: './criador-de-video-texto.component.css'
})
export class CriadorDeVideoTextoComponent implements OnInit, AfterViewInit, OnDestroy {
  text = 'Your headline here\nand a second line';

  backgroundColor = '#0b2344';
  backgroundFile: File | null = null;
  private backgroundImage: ImageBitmap | null = null;
  backgroundName = '';

  /**
   * A moving background.
   *
   * Kept as a media element rather than as decoded frames because the preview
   * needs sixty of them a second and an element is the only thing that can
   * supply them without a decoder of our own. The export cannot use it — seeking
   * a `<video>` per frame is neither exact nor fast — so the file is handed to
   * the renderer as well, which drives the decoder directly.
   */
  backgroundVideoFile: File | null = null;
  backgroundVideoDuration = 0;
  private backgroundVideo: HTMLVideoElement | null = null;
  private backgroundVideoUrl: string | null = null;

  fontId: string = FONTS[0].id;
  fontScale: number = LIMITS.fontScale.default;
  fontWeight = 700;
  color = '#ffffff';
  letterSpacing: number = LIMITS.letterSpacing.default;
  lineHeight: number = LIMITS.lineHeight.default;

  align: HorizontalAlign = 'center';
  vertical: VerticalAlign = 'middle';
  margin: number = LIMITS.margin.default;
  legibility: Legibility = 'shadow';

  animation: TextAnimation = 'typewriter';
  revealSeconds = suggestedReveal('Your headline here\nand a second line', 'typewriter');
  holdSeconds: number = LIMITS.hold.default;
  /** Cleared once the reader edits the reveal time themselves. */
  private revealAuto = true;

  fadeIn = false;
  fadeOut = false;
  fadeSeconds: number = LIMITS.fade.default;

  resolutionId: string = RESOLUTIONS[0].id;
  frameRate = 30;
  videoFormatId = VIDEO_FORMATS[0].id;
  imageFormatId = IMAGE_FORMATS[0].id;
  imageQuality: number = LIMITS.quality.default;
  matte = '#000000';

  audioFile: File | null = null;
  audioName = '';

  rendering: 'video' | 'image' | null = null;
  progress: RenderProgress | null = null;
  result: RenderResult | null = null;
  message = '';
  errorMessage = '';
  errorHint = '';

  playing = true;
  previewTime = 0;

  @ViewChild('preview') private previewRef?: ElementRef<HTMLCanvasElement>;

  private previewContext: SceneContext | null = null;
  private frameHandle = 0;
  private lastTick = 0;
  private lastReadout = 0;
  private controller: AbortController | null = null;

  readonly fonts = FONTS;
  readonly weights = WEIGHTS;
  readonly animations = ANIMATIONS;
  readonly legibilityOptions = LEGIBILITY_OPTIONS;
  readonly resolutions = RESOLUTIONS;
  readonly frameRates = FRAME_RATES;
  readonly videoFormats = VIDEO_FORMATS;
  readonly imageFormats = IMAGE_FORMATS;
  readonly limits = LIMITS;

  constructor(
    private readonly dataService: DataService,
    private readonly renderer: TextVideoService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Text Video & Image Maker');
  }

  ngAfterViewInit(): void {
    const canvas = this.previewRef?.nativeElement;
    if (!canvas || !isPlatformBrowser(this.platformId)) return;

    // Kept transparent on purpose: a background image with an alpha channel
    // must show through to the chequerboard behind the canvas, the same way it
    // will survive into a PNG export.
    this.previewContext = canvas.getContext('2d') as SceneContext | null;
    this.resizePreview();

    // The preview redraws every frame; running it inside Angular would schedule
    // change detection sixty times a second for a canvas Angular cannot see.
    this.zone.runOutsideAngular(() => this.tick());
  }

  ngOnDestroy(): void {
    this.controller?.abort();
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.releaseBackgroundVideo();
    this.backgroundImage?.close();
  }

  // --------------------------------------------------------------- preview

  /**
   * The scene as it stands, at the preview's own size.
   *
   * Sized for the preview rather than the output because every distance in a
   * scene is a fraction of its height: the same object at 4K produces the same
   * composition, which is exactly what makes the preview honest.
   */
  private sceneFor(width: number, height: number): TextScene {
    return {
      width,
      height,
      background: this.backgroundVideo?.videoWidth
        ? {
            kind: 'image',
            image: this.backgroundVideo,
            width: this.backgroundVideo.videoWidth,
            height: this.backgroundVideo.videoHeight
          }
        : this.backgroundImage
          ? {
              kind: 'image',
              image: this.backgroundImage,
              width: this.backgroundImage.width,
              height: this.backgroundImage.height
            }
          : { kind: 'color', color: this.backgroundColor },
      text: this.text,
      fontFamily: fontStack(this.fontId),
      fontScale: this.fontScale,
      fontWeight: this.fontWeight,
      color: this.color,
      letterSpacing: this.letterSpacing,
      lineHeight: this.lineHeight,
      align: this.align,
      vertical: this.vertical,
      margin: this.margin,
      legibility: this.legibility,
      animation: this.animation,
      revealSeconds: this.revealSeconds,
      holdSeconds: this.holdSeconds,
      fadeIn: this.fadeIn,
      fadeOut: this.fadeOut,
      fadeSeconds: this.fadeSeconds
    };
  }

  get outputSize(): { width: number; height: number } {
    const chosen = resolution(this.resolutionId);
    return { width: chosen.width, height: chosen.height };
  }

  get duration(): number {
    return sceneDuration({ revealSeconds: this.revealSeconds, holdSeconds: this.holdSeconds });
  }

  /**
   * Sizes the preview surface to the output's shape.
   *
   * Scaled by the *longest* side rather than the width: a 9:16 clip previewed
   * at a fixed width would be a canvas nearly two thousand pixels tall,
   * redrawn sixty times a second for no visible gain.
   */
  private resizePreview(): void {
    const canvas = this.previewRef?.nativeElement;
    if (!canvas) return;

    const { width, height } = this.outputSize;
    const scale = PREVIEW_LONG_SIDE / Math.max(width, height);
    canvas.width = Math.max(2, Math.round(width * scale));
    canvas.height = Math.max(2, Math.round(height * scale));
  }

  private tick(): void {
    if (typeof requestAnimationFrame === 'undefined') return;

    const step = (now: number) => {
      const canvas = this.previewRef?.nativeElement;
      const context = this.previewContext;

      if (canvas && context) {
        if (this.playing) {
          const elapsed = this.lastTick ? (now - this.lastTick) / 1000 : 0;
          this.previewTime = (this.previewTime + elapsed) % this.duration;

          // The loop runs outside Angular, so the clock and the scrubber would
          // sit frozen at whatever they read when playback started. They are
          // pushed back in a few times a second — often enough to look live,
          // rarely enough not to cost a change detection pass per frame.
          if (now - this.lastReadout > READOUT_INTERVAL) {
            this.lastReadout = now;
            this.zone.run(() => this.cdr.markForCheck());
          }
        }
        this.lastTick = now;

        this.syncBackgroundVideo();
        drawFrame(context, this.sceneFor(canvas.width, canvas.height), this.previewTime);
      }

      this.frameHandle = requestAnimationFrame(step);
    };

    this.frameHandle = requestAnimationFrame(step);
  }

  togglePlay(): void {
    this.playing = !this.playing;
    this.lastTick = 0;
  }

  restart(): void {
    this.previewTime = 0;
    this.lastTick = 0;
    this.playing = true;
  }

  onScrub(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.playing = false;
    this.previewTime = Math.max(0, Math.min(this.duration, parsed));
    this.lastTick = 0;
  }

  // ---------------------------------------------------------------- inputs

  onText(value: string): void {
    this.text = value;
    if (this.revealAuto) this.revealSeconds = suggestedReveal(value, this.animation);
    this.result = null;
  }

  onAnimation(value: string): void {
    this.animation = value as TextAnimation;
    if (this.revealAuto) this.revealSeconds = suggestedReveal(this.text, this.animation);
    this.restart();
    this.result = null;
  }

  onReveal(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    // Touching the field takes it off the automatic suggestion for good: a
    // number the reader chose must not be quietly rewritten when they go back
    // and fix a typo in the text.
    this.revealAuto = false;
    this.revealSeconds = this.clamp(parsed, LIMITS.reveal.min, LIMITS.reveal.max);
    this.result = null;
  }

  /**
   * Applies one of the numeric sliders, clamped to its own bounds.
   *
   * Written as a switch rather than an indexed write so each field keeps its
   * own type: a lookup table would collapse them into a single write target
   * and hand the compiler nothing to check.
   */
  onNumber(field: NumericField, value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;

    switch (field) {
      case 'holdSeconds':
        this.holdSeconds = this.clamp(parsed, LIMITS.hold.min, LIMITS.hold.max);
        break;
      case 'fadeSeconds':
        this.fadeSeconds = this.clamp(parsed, LIMITS.fade.min, LIMITS.fade.max);
        break;
      case 'fontScale':
        this.fontScale = this.clamp(parsed, LIMITS.fontScale.min, LIMITS.fontScale.max);
        break;
      case 'margin':
        this.margin = this.clamp(parsed, LIMITS.margin.min, LIMITS.margin.max);
        break;
      case 'lineHeight':
        this.lineHeight = this.clamp(parsed, LIMITS.lineHeight.min, LIMITS.lineHeight.max);
        break;
      case 'letterSpacing':
        this.letterSpacing = this.clamp(parsed, LIMITS.letterSpacing.min, LIMITS.letterSpacing.max);
        break;
      case 'imageQuality':
        this.imageQuality = this.clamp(parsed, LIMITS.quality.min, LIMITS.quality.max);
        break;
    }

    this.result = null;
  }

  onResolution(value: string): void {
    this.resolutionId = value;
    this.resizePreview();
    this.result = null;
  }

  setAlign(value: HorizontalAlign): void {
    this.align = value;
    this.result = null;
  }

  setVertical(value: VerticalAlign): void {
    this.vertical = value;
    this.result = null;
  }

  /**
   * Loads whatever was chosen as the background.
   *
   * A video is recognised by its type and taken down a different path — it is
   * the one background that changes while the clip plays, and everything about
   * how it is held, previewed and exported differs because of that.
   */
  async onBackgroundFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.errorMessage = '';
    this.errorHint = '';

    if (file.type.startsWith('video/')) {
      await this.loadBackgroundVideo(file);
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      this.releaseBackgroundVideo();
      this.backgroundImage?.close();
      this.backgroundImage = bitmap;
      this.backgroundFile = file;
      this.backgroundName = file.name;
      this.result = null;
    } catch {
      this.errorMessage = `"${file.name}" is not an image your browser can open.`;
      this.errorHint = 'Try PNG, JPEG, WebP, GIF, AVIF or BMP.';
    } finally {
      this.cdr.markForCheck();
    }
  }

  /**
   * Loads a moving background and takes the clip's length from it.
   *
   * Choosing a ten-second video almost always means wanting ten seconds of
   * clip, so the hold is set to whatever is left after the text has arrived.
   * It stays editable afterwards; what it prevents is a five-second default
   * silently throwing away half of what was chosen.
   */
  private async loadBackgroundVideo(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';

    const ready = await new Promise<boolean>((resolve) => {
      const settle = (value: boolean) => {
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onerror = null;
        resolve(value);
      };
      const timer = setTimeout(() => settle(false), VIDEO_LOAD_TIMEOUT);
      video.onloadeddata = () => settle(true);
      video.onerror = () => settle(false);
    });

    if (!ready || !video.videoWidth) {
      URL.revokeObjectURL(url);
      this.errorMessage = `"${file.name}" is not a video your browser can open.`;
      this.errorHint = 'Try MP4 (H.264), WebM or MOV.';
      this.cdr.markForCheck();
      return;
    }

    this.releaseBackgroundVideo();
    this.backgroundImage?.close();
    this.backgroundImage = null;
    this.backgroundFile = null;

    this.backgroundVideo = video;
    this.backgroundVideoUrl = url;
    this.backgroundVideoFile = file;
    this.backgroundName = file.name;
    this.backgroundVideoDuration = Number.isFinite(video.duration) ? video.duration : 0;

    if (this.backgroundVideoDuration > 0) {
      const hold = this.backgroundVideoDuration - this.revealSeconds;
      this.holdSeconds = Math.min(LIMITS.hold.max, Math.max(LIMITS.hold.min, Math.round(hold * 10) / 10));
    }

    this.previewTime = 0;
    this.result = null;
    void video.play().catch(() => undefined);
    this.cdr.markForCheck();
  }

  /**
   * Keeps the background video on the instant the preview is showing.
   *
   * While it plays the element is left to run and is only pulled back when it
   * has drifted or the preview has looped; paused, it is put exactly where the
   * scrubber says. Seeking on every frame would be smooth for neither.
   */
  private syncBackgroundVideo(): void {
    const video = this.backgroundVideo;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;

    const wanted = Math.max(0, Math.min(this.previewTime, video.duration - 0.05));

    if (this.playing) {
      if (video.paused) void video.play().catch(() => undefined);
      if (Math.abs(video.currentTime - wanted) > VIDEO_DRIFT) video.currentTime = wanted;
      return;
    }

    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - wanted) > 0.02) video.currentTime = wanted;
  }

  private releaseBackgroundVideo(): void {
    this.backgroundVideo?.pause();
    if (this.backgroundVideoUrl) URL.revokeObjectURL(this.backgroundVideoUrl);
    this.backgroundVideo = null;
    this.backgroundVideoUrl = null;
    this.backgroundVideoFile = null;
    this.backgroundVideoDuration = 0;
  }

  clearBackground(): void {
    this.releaseBackgroundVideo();
    this.backgroundImage?.close();
    this.backgroundImage = null;
    this.backgroundFile = null;
    this.backgroundName = '';
    this.result = null;
  }

  onAudioFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.audioFile = file;
    this.audioName = file.name;
    this.result = null;
  }

  clearAudio(): void {
    this.audioFile = null;
    this.audioName = '';
    this.result = null;
  }

  // -------------------------------------------------------------- rendering

  async renderVideo(): Promise<void> {
    if (this.rendering || !isPlatformBrowser(this.platformId)) return;

    this.rendering = 'video';
    this.startRun();

    const { width, height } = this.outputSize;

    try {
      const result = await this.zone.runOutsideAngular(() =>
        this.renderer.renderVideo({
          scene: this.sceneFor(width, height),
          format: videoFormat(this.videoFormatId),
          frameRate: this.frameRate,
          // With no soundtrack of its own, a clip built on a video keeps that
          // video's sound — which is what someone dropping a clip in and
          // pressing render plainly meant.
          audio: this.audioFile ?? this.backgroundVideoFile,
          backgroundVideo: this.backgroundVideoFile,
          signal: (this.controller as AbortController).signal,
          onProgress: (report) => {
            this.zone.run(() => {
              this.progress = report;
              this.cdr.markForCheck();
            });
          }
        })
      );

      this.finish(result);
    } catch (error) {
      this.fail(error);
    }
  }

  async renderImage(): Promise<void> {
    if (this.rendering || !isPlatformBrowser(this.platformId)) return;

    this.rendering = 'image';
    this.startRun();

    const { width, height } = this.outputSize;

    try {
      const result = await this.renderer.renderImage({
        scene: this.sceneFor(width, height),
        format: imageFormat(this.imageFormatId),
        quality: this.imageQuality,
        matte: this.matte,
        backgroundVideo: this.backgroundVideoFile
      });

      this.finish(result);
    } catch (error) {
      this.fail(error);
    }
  }

  cancel(): void {
    this.controller?.abort();
  }

  download(result: RenderResult | null = this.result): void {
    if (!result || typeof document === 'undefined') return;

    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = result.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private startRun(): void {
    this.controller = new AbortController();
    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.result = null;
    this.progress = { stage: 'preparing', ratio: 0 };
  }

  private finish(result: RenderResult): void {
    this.result = result;
    this.message = `${result.fileName} is ready.`;
    this.download(result);
    this.rendering = null;
    this.progress = null;
    this.controller = null;
    this.cdr.markForCheck();
  }

  private fail(error: unknown): void {
    if (error instanceof RenderCanceledError) {
      this.message = 'The render was canceled.';
    } else if (error instanceof RenderError) {
      this.errorMessage = error.message;
      this.errorHint = error.hint ?? '';
    } else {
      console.error(error);
      this.errorMessage = 'The file could not be generated.';
      this.errorHint = 'Check your settings and try again.';
    }

    this.rendering = null;
    this.progress = null;
    this.controller = null;
    this.cdr.markForCheck();
  }

  // ----------------------------------------------------------- presentation

  get stageLabel(): string {
    return this.progress ? STAGE_LABEL[this.progress.stage] : '';
  }

  get stillLabel(): string {
    return `The image is taken at ${this.formatSeconds(stillTime({ revealSeconds: this.revealSeconds }))}, the moment the text finishes arriving.`;
  }

  get animationNote(): string {
    return ANIMATIONS.find((option) => option.id === this.animation)?.note ?? '';
  }

  get videoNote(): string {
    return videoFormat(this.videoFormatId).note;
  }

  get imageNote(): string {
    return imageFormat(this.imageFormatId).note;
  }

  get imageKeepsAlpha(): boolean {
    return imageFormat(this.imageFormatId).keepsAlpha;
  }

  get frameCount(): number {
    return Math.max(1, Math.ceil(this.duration * this.frameRate));
  }

  formatSeconds(seconds: number): string {
    return `${Math.round(seconds * 10) / 10}s`;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }
}

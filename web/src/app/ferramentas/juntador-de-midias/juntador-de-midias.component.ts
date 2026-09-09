import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, Inject, NgZone, OnDestroy, OnInit, PLATFORM_ID } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { DataService } from '../../data.service';
import { MediaMergeService } from './media-merge.service';
import { MediaProbeService } from './media-probe.service';
import {
  AUDIO_FORMATS,
  FADE_SECONDS,
  IMAGE_SECONDS,
  RESOLUTIONS,
  VIDEO_FORMATS,
  audioFormat,
  videoFormat
} from './media-merger-formats';
import {
  MergeCanceledError,
  MergeError,
  MergeProgress,
  MergeResult,
  MergeSettings,
  QueuedMedia,
  ResolutionPreset
} from './media-merger.models';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';

/** Extensions offered in the file dialog. The real check is the parsed header. */
const ACCEPTED =
  '.mp4,.mov,.m4v,.webm,.mkv,.avi,.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.flac,' +
  '.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,video/*,audio/*,image/*';

/** What may be attached to a still image. A video is accepted for its sound. */
const ACCEPTED_AUDIO = '.m4a,.mp3,.wav,.aac,.ogg,.oga,.opus,.flac,.mp4,.mov,.webm,.mkv,audio/*,video/*';

/** Above this the browser is likely to run out of room before finishing. */
const LARGE_TOTAL_BYTES = 2_000_000_000;

const STAGE_LABEL: Record<MergeProgress['stage'], string> = {
  preparing: 'Preparing',
  encoding: 'Encoding',
  muxing: 'Assembling',
  finishing: 'Finishing'
};

/**
 * Video & Audio Merger.
 *
 * The component owns the queue and nothing else: probing and encoding both live
 * in services, and the single rule it enforces is that the list on screen is
 * the timeline. Order is the whole interface — what the reader drags into
 * position is exactly what plays, in that order, with no gaps.
 *
 * Nothing leaves the browser. The files are read locally and the merged result
 * is written locally, which is also why the work is visible: a long merge
 * reports the clip it is on rather than spinning silently.
 */
@Component({
  selector: 'app-juntador-de-midias',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DragDropModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule
  ,
    HelpPanelComponent],
  templateUrl: './juntador-de-midias.component.html',
  styleUrl: './juntador-de-midias.component.css'
})
export class JuntadorDeMidiasComponent implements OnInit, OnDestroy {
  items: QueuedMedia[] = [];

  settings: MergeSettings = {
    videoFormatId: VIDEO_FORMATS[0].id,
    audioFormatId: AUDIO_FORMATS[0].id,
    resolution: 'auto',
    fadeSeconds: FADE_SECONDS.default
  };

  /**
   * What a newly added clip inherits.
   *
   * The header checkboxes read their state from the queue, so with an empty
   * queue there would be nothing for them to show — and a reader who ticks
   * "fade in" for everything and then drags in one more file plainly means it
   * to arrive faded too. These two remember that intent.
   */
  private defaultFadeIn = false;
  private defaultFadeOut = false;

  /** Which download is running, or null when idle. */
  merging: 'video' | 'audio' | null = null;
  reading = false;
  dragging = false;
  progress: MergeProgress | null = null;
  result: MergeResult | null = null;

  message = '';
  errorMessage = '';
  errorHint = '';
  notice = '';

  preview: QueuedMedia | null = null;

  private controller: AbortController | null = null;
  private nextId = 0;

  readonly videoFormats = VIDEO_FORMATS;
  readonly audioFormats = AUDIO_FORMATS;
  readonly resolutions = RESOLUTIONS;
  readonly fadeLimits = FADE_SECONDS;
  readonly imageLimits = IMAGE_SECONDS;
  readonly accepted = ACCEPTED;
  readonly acceptedAudio = ACCEPTED_AUDIO;

  constructor(
    private readonly dataService: DataService,
    private readonly probe: MediaProbeService,
    private readonly merger: MediaMergeService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Video & Audio Merger');
  }

  ngOnDestroy(): void {
    this.controller?.abort();
    this.closePreview();
    for (const item of this.items) this.release(item);
  }

  // ------------------------------------------------------------- the queue

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging = false;
    await this.add(Array.from(event.dataTransfer?.files ?? []));
  }

  async onFileInput(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;

    // Copied out before the input is cleared, not after: a `FileList` is a live
    // view of the element, so resetting `value` empties the very list being
    // read from. Clearing it is what lets the same file be chosen twice in a
    // row, so the order of these two lines is the whole behaviour.
    const files = Array.from(input.files ?? []);
    input.value = '';

    await this.add(files);
  }

  /**
   * Probes every dropped file and appends the ones that can be used.
   *
   * A file that cannot be read is reported by name and skipped rather than
   * failing the whole batch: dropping a folder of twenty clips and losing all
   * of them because one is a text file would be its own kind of bug.
   */
  async add(files: readonly File[]): Promise<void> {
    if (!files.length || !isPlatformBrowser(this.platformId)) return;

    this.reading = true;
    this.errorMessage = '';
    this.errorHint = '';
    this.message = '';
    this.result = null;
    const rejected: string[] = [];

    try {
      for (const file of files) {
        try {
          const summary = await this.probe.probe(file);
          this.items.push({
            id: `media-${this.nextId++}`,
            file,
            summary,
            fadeIn: this.defaultFadeIn,
            fadeOut: this.defaultFadeOut,
            attachedAudio: null,
            previewUrl: null
          });
        } catch (error) {
          rejected.push(error instanceof MergeError ? error.message : `"${file.name}" could not be read.`);
        }
        this.cdr.markForCheck();
      }
    } finally {
      this.reading = false;
    }

    if (rejected.length) {
      this.errorMessage = rejected[0];
      this.errorHint = rejected.length > 1 ? `${rejected.length - 1} more file(s) were skipped for the same reason.` : '';
    }

    this.notice = this.totalBytes > LARGE_TOTAL_BYTES
      ? 'This is a lot of media. Choose a save location when asked so the result is written straight to disk instead of being held in memory.'
      : '';
  }

  reorder(event: CdkDragDrop<QueuedMedia[]>): void {
    moveItemInArray(this.items, event.previousIndex, event.currentIndex);
    this.result = null;
  }

  /** Keyboard-reachable reordering, since dragging is not available to everyone. */
  move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this.items.length) return;
    moveItemInArray(this.items, index, target);
    this.result = null;
  }

  remove(index: number): void {
    const [removed] = this.items.splice(index, 1);
    if (removed) {
      if (this.preview === removed) this.closePreview();
      this.release(removed);
    }
    this.result = null;
  }

  clear(): void {
    this.closePreview();
    for (const item of this.items) this.release(item);
    this.items = [];
    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.notice = '';
    this.result = null;
  }

  // ---------------------------------------------------------- still images

  /**
   * Changes how long a still image stays on screen.
   *
   * This is the only duration in the queue the reader owns; every other one
   * was measured from a file. It is clamped rather than rejected so that
   * clearing the field mid-edit does not blank the timeline.
   */
  onImageSeconds(item: QueuedMedia, value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    item.summary.durationSeconds = Math.min(IMAGE_SECONDS.max, Math.max(IMAGE_SECONDS.min, parsed));
    this.result = null;
  }

  /**
   * Attaches a soundtrack to a still image.
   *
   * The image takes the length of the sound, which is almost always what was
   * meant — someone attaching a thirty-second clip to a photo wants thirty
   * seconds of photo, not five. The duration stays editable afterwards.
   */
  async attachAudio(item: QueuedMedia, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.errorMessage = '';
    this.errorHint = '';

    try {
      const summary = await this.probe.probeAudioOnly(file);
      item.attachedAudio = { file, summary };
      item.summary.durationSeconds = Math.min(
        IMAGE_SECONDS.max,
        Math.max(IMAGE_SECONDS.min, summary.durationSeconds)
      );
      this.result = null;
    } catch (error) {
      this.errorMessage = error instanceof MergeError ? error.message : `"${file.name}" could not be read.`;
      this.errorHint = error instanceof MergeError ? error.hint ?? '' : '';
    } finally {
      this.cdr.markForCheck();
    }
  }

  detachAudio(item: QueuedMedia): void {
    item.attachedAudio = null;
    this.result = null;
  }

  get imageCount(): number {
    return this.items.filter((item) => item.summary.kind === 'image').length;
  }

  openPreview(item: QueuedMedia): void {
    if (!isPlatformBrowser(this.platformId)) return;
    item.previewUrl ??= URL.createObjectURL(item.file);
    this.preview = item;
  }

  closePreview(): void {
    this.preview = null;
  }

  private release(item: QueuedMedia): void {
    if (!item.previewUrl) return;
    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = null;
  }

  // --------------------------------------------------------------- merging

  /**
   * Merges the queue and hands the result over.
   *
   * The save dialog is opened first, before anything is awaited: it needs the
   * user activation from this very click, and asking for it after the encode
   * would leave a reader who wanted the file on disk with a download instead.
   */
  async merge(kind: 'video' | 'audio'): Promise<void> {
    if (this.merging || !this.items.length || !isPlatformBrowser(this.platformId)) return;

    // Claimed before the save dialog is awaited: while that dialog is open the
    // buttons are still on screen, and a second click would start a second
    // merge writing into the same file.
    this.merging = kind;

    const format = kind === 'video' ? this.videoFormat : this.audioFormat;
    const destination = await this.merger.pickDestination(kind, format);

    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.result = null;
    this.controller = new AbortController();
    this.progress = {
      stage: 'preparing',
      ratio: 0,
      itemIndex: 0,
      itemCount: this.items.length,
      itemName: ''
    };

    try {
      const result = await this.zone.runOutsideAngular(() =>
        this.merger.merge({
          items: [...this.items],
          kind,
          format,
          resolution: this.settings.resolution,
          fadeSeconds: this.settings.fadeSeconds,
          destination,
          signal: (this.controller as AbortController).signal,
          onProgress: (report) => {
            this.zone.run(() => {
              this.progress = report;
              this.cdr.markForCheck();
            });
          }
        })
      );

      this.result = result;
      this.message = result.savedToDisk
        ? `Saved as ${result.fileName}.`
        : `${result.fileName} is ready.`;

      if (!result.savedToDisk) this.download(result);
    } catch (error) {
      if (error instanceof MergeCanceledError) {
        this.message = 'The merge was canceled.';
      } else if (error instanceof MergeError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint ?? '';
      } else {
        console.error(error);
        this.errorMessage = 'The merged file could not be generated.';
        this.errorHint = 'Check that every file in the queue is valid and try again.';
      }
    } finally {
      this.merging = null;
      this.progress = null;
      this.controller = null;
      this.cdr.markForCheck();
    }
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Downloads the finished file when it was not streamed straight to disk. */
  download(result: MergeResult | null = this.result): void {
    if (!result?.blob || typeof document === 'undefined') return;

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

  // ---------------------------------------------------------- presentation

  get videoFormat() {
    return videoFormat(this.settings.videoFormatId);
  }

  get audioFormat() {
    return audioFormat(this.settings.audioFormatId);
  }

  get totalDuration(): number {
    return this.items.reduce((total, item) => total + item.summary.durationSeconds, 0);
  }

  get totalBytes(): number {
    return this.items.reduce((total, item) => total + item.file.size, 0);
  }

  get videoCount(): number {
    return this.items.filter((item) => item.summary.videoUsable).length;
  }

  get silentCount(): number {
    return this.items.filter((item) => !item.summary.audioUsable).length;
  }

  get canMergeVideo(): boolean {
    return this.items.length > 0 && this.videoCount > 0 && !this.merging && !this.reading;
  }

  get canMergeAudio(): boolean {
    return this.items.length > 0 && !this.merging && !this.reading;
  }

  get stageLabel(): string {
    return this.progress ? STAGE_LABEL[this.progress.stage] : '';
  }

  /** The one thing the reader most needs told before they press a button. */
  get planWarning(): string {
    if (!this.items.length) return '';
    if (!this.videoCount) return 'No file in the queue has a picture, so only the audio download is available.';

    const audioOnly = this.items.length - this.videoCount;
    if (audioOnly > 0) {
      return `${audioOnly} file(s) carry no picture and will play over a black screen in the video download.`;
    }
    return '';
  }

  // ----------------------------------------------------------------- fades

  get allFadeIn(): boolean {
    return this.items.length ? this.items.every((item) => item.fadeIn) : this.defaultFadeIn;
  }

  get allFadeOut(): boolean {
    return this.items.length ? this.items.every((item) => item.fadeOut) : this.defaultFadeOut;
  }

  /** True when only part of the queue is faded, so the header box is neither. */
  get someFadeIn(): boolean {
    return this.items.some((item) => item.fadeIn) && !this.allFadeIn;
  }

  get someFadeOut(): boolean {
    return this.items.some((item) => item.fadeOut) && !this.allFadeOut;
  }

  setAllFades(edge: 'in' | 'out', checked: boolean): void {
    for (const item of this.items) {
      if (edge === 'in') item.fadeIn = checked;
      else item.fadeOut = checked;
    }

    if (edge === 'in') this.defaultFadeIn = checked;
    else this.defaultFadeOut = checked;

    this.result = null;
  }

  setFade(item: QueuedMedia, edge: 'in' | 'out', checked: boolean): void {
    if (edge === 'in') item.fadeIn = checked;
    else item.fadeOut = checked;

    // Ticking every row by hand means the same thing as ticking the header, so
    // a file added afterwards should arrive faded either way.
    if (edge === 'in') this.defaultFadeIn = this.allFadeIn;
    else this.defaultFadeOut = this.allFadeOut;

    this.result = null;
  }

  onFadeSeconds(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.settings = {
      ...this.settings,
      fadeSeconds: Math.min(FADE_SECONDS.max, Math.max(FADE_SECONDS.min, parsed))
    };
    this.result = null;
  }

  get fadedCount(): number {
    return this.items.filter((item) => item.fadeIn || item.fadeOut).length;
  }

  onResolution(value: string): void {
    this.settings = { ...this.settings, resolution: value as ResolutionPreset };
    this.result = null;
  }

  onVideoFormat(value: string): void {
    this.settings = { ...this.settings, videoFormatId: value };
    this.result = null;
  }

  onAudioFormat(value: string): void {
    this.settings = { ...this.settings, audioFormatId: value };
    this.result = null;
  }

  trackById(_index: number, item: QueuedMedia): string {
    return item.id;
  }

  formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    const padded = `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
    return hours ? `${hours}:${padded}` : padded;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
  }

  /** `1920 × 1080 · 30 fps`, with whatever parts are actually known. */
  describeTracks(item: QueuedMedia): string {
    const parts: string[] = [];
    const { summary } = item;

    if (summary.width && summary.height) parts.push(`${summary.width} × ${summary.height}`);
    if (summary.frameRate) parts.push(`${summary.frameRate} fps`);
    if (summary.videoCodec) parts.push(summary.videoCodec.toUpperCase());
    if (summary.audioCodec) parts.push(summary.audioCodec.toUpperCase());
    if (summary.channelCount) parts.push(summary.channelCount === 1 ? 'mono' : `${summary.channelCount} ch`);

    return parts.join(' · ');
  }
}

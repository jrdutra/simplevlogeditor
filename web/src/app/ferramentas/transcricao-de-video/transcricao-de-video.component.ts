import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, Inject, OnDestroy, OnInit, PLATFORM_ID, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { DataService } from '../../data.service';
import { groupWords } from './recognition-timing';
import { MeetingRecorder } from './meeting-recorder';
import {
  MAX_MINUTES,
  TranscriptionCanceled,
  TranscriptionError,
  readSpeechAudio,
  transcribe
} from './speech-recognizer';
import {
  SPEECH_LANGUAGES,
  SPEECH_MODELS,
  TranscriptionProgress,
  TranscriptionStage
} from './transcription.models';
import {
  Cue,
  captionText,
  cueWarnings,
  CueShape,
  DEFAULT_SHAPE,
  SHAPE_LIMITS,
  SUBTITLE_FORMATS,
  SubtitleFormat,
  readableTime,
  shapeCues,
  spokenSeconds,
  wordCount,
  writeSubtitles
} from './subtitle-formats';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';

/** The sliders that share one clamped setter. */
type ShapeField = keyof typeof SHAPE_LIMITS;

const STAGE_LABEL: Record<TranscriptionStage, string> = {
  reading: 'Reading the sound',
  downloading: 'Fetching the speech model',
  listening: 'Listening',
  done: 'Done'
};

/**
 * Video Transcription.
 *
 * The tool is one long job with four outputs, and the shape of the component
 * follows from a single decision: recognition happens once, and everything the
 * reader can change afterwards — line width, how long a caption stays, which
 * file to download — is recomputed from the cues that came back, in memory,
 * instantly. Moving a slider must never mean listening to the recording again.
 *
 * So there are two levels of state. `heard` is what the model said and is
 * replaced only by a new run. `cues` is `heard` put through the shaping rules
 * and is rebuilt whenever a rule changes. The preview, the counts and all four
 * files are written from `cues`.
 */
@Component({
  selector: 'app-transcricao-de-video',
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
  templateUrl: './transcricao-de-video.component.html',
  styleUrl: './transcricao-de-video.component.css'
})
export class TranscricaoDeVideoComponent implements OnInit, OnDestroy {
  @ViewChild('player') player?: ElementRef<HTMLVideoElement>;
  mediaUrl = '';
  /** True once the loaded recording turns out to carry no picture. */
  audioOnly = false;
  mediaDuration = Infinity;
  playbackTime = 0;
  page = 0;
  readonly pageSize = 50;
  private edited: Cue[] | null = null;
  private destroyed = false;
  private previewCues: Cue[] | null = null;
  private previewFormat: SubtitleFormat | null = null;
  private previewText = '';
  capturing = false;
  captureStarting = false;
  includeMicrophone = false;
  captureSeconds = 0;
  private meeting?: MeetingRecorder;
  private captureTimer?: ReturnType<typeof setInterval>;
  get captureSupported(): boolean { return MeetingRecorder.supported(); }
  get sourceBusy(): boolean { return this.working || this.capturing || this.captureStarting; }
  file: File | null = null;
  fileName = '';
  fileSize = 0;

  modelId: string = SPEECH_MODELS[0].id;
  language = '';

  shape: CueShape = { ...DEFAULT_SHAPE };
  formatId: SubtitleFormat = 'srt';

  /** Raw recogniser output. Replaced only by a new run. */
  private heard: Cue[] = [];
  /** `heard` after the shaping rules. What every file is written from. */
  cues: Cue[] = [];

  working = false;
  progress: TranscriptionProgress | null = null;
  errorMessage = '';
  errorHint = '';
  message = '';

  private controller: AbortController | null = null;
  private downloadUrl: string | null = null;

  readonly models = SPEECH_MODELS;
  readonly languages = SPEECH_LANGUAGES;
  readonly formats = SUBTITLE_FORMATS;
  readonly limits = SHAPE_LIMITS;
  readonly maxMinutes = MAX_MINUTES;

  constructor(
    private readonly dataService: DataService,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Video Transcription');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.controller?.abort();
    this.meeting?.dispose();
    clearInterval(this.captureTimer);
    this.revokeDownload();
    this.revokeMedia();
  }

  /* ------------------------------------------------------------- the file */

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    input.value = '';
    if (!chosen || this.sourceBusy) return;
    this.useFile(chosen);
  }

  private useFile(chosen: File): void {

    this.revokeMedia();
    this.revokeDownload();
    this.mediaUrl = URL.createObjectURL(chosen);
    this.audioOnly = false;
    this.mediaDuration = Infinity;
    this.edited = null;
    this.page = 0;

    this.file = chosen;
    this.fileName = chosen.name;
    this.fileSize = chosen.size;

    // A new recording invalidates the old transcript. Keeping it on screen
    // beside a different file name is the one way this page could lie.
    this.heard = [];
    this.cues = [];
    this.errorMessage = '';
    this.errorHint = '';
    this.message = '';
    this.progress = null;
  }

  /** The element reports its picture size only once the metadata has arrived. */
  onMediaLoaded(): void {
    const player = this.player?.nativeElement;
    if (!player) return;
    this.audioOnly = !player.videoWidth || !player.videoHeight;
    this.cdr.markForCheck();
  }

  clearFile(): void {
    if (this.sourceBusy) return;
    this.revokeMedia();
    this.revokeDownload();
    this.edited = null;
    this.file = null;
    this.fileName = '';
    this.fileSize = 0;
    this.heard = [];
    this.cues = [];
    this.progress = null;
    this.message = '';
  }

  async startMeeting(): Promise<void> {
    if (this.sourceBusy || !isPlatformBrowser(this.platformId) || this.destroyed) return;
    this.captureStarting = true;
    this.errorMessage = '';
    this.errorHint = '';
    this.message = '';
    this.player?.nativeElement.pause();
    const finish = () => {
      clearInterval(this.captureTimer);
      this.capturing = false;
      this.captureStarting = false;
    };
    const meeting = new MeetingRecorder(file => {
      finish();
      if (this.destroyed) return;
      this.useFile(file);
      this.message = 'Meeting captured. Transcribing the recording…';
      void this.run();
    }, message => {
      finish();
      if (this.destroyed) return;
      this.errorMessage = message;
      this.cdr.markForCheck();
    });
    this.meeting = meeting;
    try {
      await meeting.start(this.includeMicrophone, MAX_MINUTES);
      if (this.destroyed) { meeting.dispose(); return; }
      this.captureStarting = false;
      this.capturing = true;
      this.captureSeconds = 0;
      const started = Date.now();
      this.captureTimer = setInterval(() => {
        this.captureSeconds = Math.floor((Date.now() - started) / 1000);
        this.cdr.markForCheck();
      }, 1000);
    } catch (error) {
      finish();
      if (this.destroyed) return;
      this.errorMessage = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Audio sharing was canceled or permission was denied. You can try again or import a recording.'
        : error instanceof Error ? error.message : String(error);
    }
    if (!this.destroyed) this.cdr.markForCheck();
  }

  stopMeeting(): void { this.meeting?.stop(); }

  /* ------------------------------------------------------------- the job */

  async run(): Promise<void> {
    if (!this.file || this.sourceBusy || this.languageWarning || !isPlatformBrowser(this.platformId)) return;

    this.working = true;
    this.errorMessage = '';
    this.errorHint = '';
    this.message = '';
    this.heard = [];
    this.cues = [];
    this.edited = null;
    this.page = 0;
    this.progress = { stage: 'reading', ratio: 0, detail: this.fileName };

    const controller = new AbortController();
    this.controller = controller;

    const report = (update: TranscriptionProgress) => {
      if (this.destroyed || controller.signal.aborted) return;
      this.progress = update;
      this.cdr.markForCheck();
    };

    try {
      const samples = await readSpeechAudio(this.file, report, controller.signal);
      this.mediaDuration = samples.length / 16000;
      if (controller.signal.aborted) throw new TranscriptionCanceled();

      const heard = await transcribe(
        samples,
        { model: this.modelId, language: this.language },
        report,
        controller.signal,
        words => {
          if (this.destroyed || controller.signal.aborted) return;
          this.heard = words;
          this.reshape();
          this.cdr.markForCheck();
        }
      );

      this.heard = heard;
      this.reshape();

      this.message = heard.length
        ? `Transcribed ${this.cues.length} caption${this.cues.length === 1 ? '' : 's'}.`
        : 'The model heard no speech in this recording.';
    } catch (error) {
      if (this.destroyed) return;
      this.progress = null;

      if (error instanceof TranscriptionCanceled) {
        this.message = this.cues.length ? 'Stopped. Completed captions are available for review and download.' : 'Stopped.';
      } else if (error instanceof TranscriptionError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint;
      } else {
        this.errorMessage = 'The transcription failed.';
        this.errorHint = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.working = false;
      this.controller = null;
      if (!this.destroyed) this.cdr.markForCheck();
    }
  }

  stop(): void {
    this.controller?.abort();
  }

  /* ---------------------------------------------------------- the shaping */

  onShape(field: ShapeField, raw: string): void {
    const limit = this.limits[field];
    const value = Number(raw);
    if (!Number.isFinite(value)) return;

    this.shape = { ...this.shape, [field]: Math.min(limit.max, Math.max(limit.min, value)) };
    if (this.shape.minSeconds > this.shape.maxSeconds) {
      if (field === 'minSeconds') this.shape.maxSeconds = this.shape.minSeconds;
      else this.shape.minSeconds = this.shape.maxSeconds;
    }
    this.reshape();
  }

  private reshape(): void {
    this.cues = shapeCues(this.edited ?? groupWords(this.heard, this.shape.lineLength, this.shape.maxLines, this.shape.maxSeconds), this.shape, this.mediaDuration);
    this.page = Math.min(this.page, Math.max(0, this.pages - 1));
    this.revokeDownload();
  }

  /* --------------------------------------------------------- the download */

  get format() {
    return this.formats.find((entry) => entry.id === this.formatId) ?? this.formats[0];
  }

  get preview(): string {
    if (this.previewCues !== this.cues || this.previewFormat !== this.formatId) {
      this.previewText = this.cues.length ? writeSubtitles(this.cues, this.formatId) : '';
      this.previewCues = this.cues;
      this.previewFormat = this.formatId;
    }
    return this.previewText;
  }

  /** What the file is called: the recording's own name, with a new extension. */
  get downloadName(): string {
    const stem = this.fileName.replace(/\.[^.]+$/, '') || 'transcript';
    const suffix = this.formatId === 'txt-plain' ? '-text' : this.formatId === 'txt-timed' ? '-transcript' : '';
    return `${stem}${suffix}.${this.format.extension}`;
  }

  download(): void {
    if (!this.cues.length || !isPlatformBrowser(this.platformId)) return;

    // A BOM in front of the text. Without it Windows Notepad and a few caption
    // uploaders read a UTF-8 file as the local codepage, and every accented
    // word in the transcript arrives broken.
    const blob = new Blob(['﻿', this.preview], { type: `${this.format.mimeType};charset=utf-8` });

    this.revokeDownload();
    this.downloadUrl = URL.createObjectURL(blob);

    const link = document.createElement('a');
    link.href = this.downloadUrl;
    link.download = this.downloadName;
    link.click();
  }

  async copy(): Promise<void> {
    if (!this.cues.length || !isPlatformBrowser(this.platformId)) return;

    try {
      await navigator.clipboard.writeText(this.preview);
      this.message = 'Copied to the clipboard.';
    } catch {
      this.message = 'The browser refused clipboard access — select the text and copy it by hand.';
    }
    this.cdr.markForCheck();
  }

  private revokeDownload(): void {
    if (!this.downloadUrl) return;
    URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = null;
  }

  private revokeMedia(): void {
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.mediaUrl = '';
  }

  get visibleCues(): Cue[] { return this.cues.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize); }
  get pages(): number { return Math.ceil(this.cues.length / this.pageSize); }
  get activeCaption(): string {
    const cue = this.cues.find(cue => cue.start <= this.playbackTime && cue.end > this.playbackTime);
    return cue ? captionText(cue) : '';
  }
  warnings(cue: Cue): string { return cueWarnings(cue, this.shape).join(' · '); }

  seek(cue: Cue): void {
    const player = this.player?.nativeElement;
    if (!player) return;
    player.currentTime = cue.start;
    void player.play().catch(() => { this.message = 'Use the player controls to start playback.'; });
  }

  editCue(index: number, field: 'start' | 'end' | 'text' | 'speaker', value: string): void {
    if (this.working) return;
    const position = this.page * this.pageSize + index;
    const cue = this.cues[position];
    if (!cue) return;
    const updated = { ...cue };
    if (field === 'speaker') {
      updated.speaker = value.replace(/\s+/g, ' ').trim().slice(0, 80);
    } else if (field === 'text') {
      if (!value.trim()) { this.message = 'Caption text cannot be empty.'; return; }
      updated.text = value;
    } else {
      if (!value.trim() || !Number.isFinite(Number(value))) return;
      updated[field] = Math.round(Number(value) * 1000) / 1000;
      const before = this.cues[position - 1];
      const after = this.cues[position + 1];
      if (updated.start < 0 || updated.end <= updated.start || updated.end > this.mediaDuration ||
        (before && updated.start < before.end) || (after && updated.end > after.start)) {
        this.message = 'Use a positive duration within the recording, without overlapping adjacent captions.';
        return;
      }
    }
    this.cues = this.cues.map((item, at) => at === position ? updated : item);
    this.edited = this.cues.map(item => ({ ...item }));
    this.message = 'Caption updated. Downloads include your edits.';
    this.revokeDownload();
  }

  /* ---------------------------------------------------------- the readout */

  get stageLabel(): string {
    return this.progress ? STAGE_LABEL[this.progress.stage] : '';
  }

  get percent(): number {
    const ratio = this.progress?.ratio;
    return ratio === null || ratio === undefined ? 0 : Math.round(ratio * 100);
  }

  get indeterminate(): boolean {
    return this.progress?.ratio === null || this.progress?.ratio === undefined;
  }

  get words(): number {
    return wordCount(this.cues);
  }

  get spoken(): string {
    return readableTime(spokenSeconds(this.cues));
  }

  get covered(): string {
    return this.cues.length ? readableTime(this.cues[this.cues.length - 1].end) : '0:00';
  }

  get chosenModel() {
    return this.models.find((model) => model.id === this.modelId) ?? this.models[0];
  }

  /**
   * Whether the chosen pair can work at all.
   *
   * An English-only model given a Portuguese recording does not fail — it
   * translates, badly, and the reader is left wondering why the transcript is
   * in the wrong language. Better to say so before the download starts.
   */
  get languageWarning(): string {
    const model = this.chosenModel;
    if (model.multilingual) return '';
    if (!this.language || this.language === 'english') return '';
    return `${model.label} only knows English. Choose a multilingual model for anything else.`;
  }

  time(seconds: number): string {
    return readableTime(seconds);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

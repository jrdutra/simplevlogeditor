import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, Inject, OnDestroy, OnInit, PLATFORM_ID, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';

import { DataService } from '../../data.service';
import {
  DEFAULT_LOUDNESS,
  LOUDNESS_LIMITS,
  LoudnessMode,
  LoudnessSettings,
  clampLoudness
} from '../../shared/media/loudness';
import { DecodedAudio, readAudio, writeAudio } from './media-audio';
import { SuppressionCanceled, SuppressionError, suppress } from './noise-suppression-client';
import { LevellingReport } from './noise-suppression-protocol';
import { GainField } from './spectral-gain';
import { AnalysisSettings, DEFAULT_ANALYSIS_SETTINGS, NoiseReport, validateAnalysis } from './noise-analysis';
import { analyseNoise } from './noise-analysis-client';
import {
  AUDIO_FORMATS,
  AudioFormat,
  ENGINES,
  EngineId,
  MAX_MINUTES,
  OutputKind,
  ProcessingDevice,
  STRENGTHS,
  SuppressionProgress,
  SuppressionStage
} from './noise-suppression.models';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';

const STAGE_LABEL: Record<SuppressionStage, string> = {
  reading: 'Reading the recording',
  loading: 'Starting the engine',
  listening: 'Separating the voice',
  writing: 'Writing the audio',
  levelling: 'Evening out the volume',
  analysing: 'Analysing the background',
  done: 'Done'
};

/**
 * Background Noise Remover.
 *
 * The tool holds two things at once and the whole design follows from that: the
 * recording as it arrived, and the recording with the noise taken out. Both stay
 * available, both are playable at the same instant, and the download is produced
 * from the second only when the reader has heard it and asked for it.
 *
 * Nothing is uploaded. The engine, the model and the muxer all run in this tab.
 */
@Component({
  selector: 'app-supressao-de-ruido',
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
  templateUrl: './supressao-de-ruido.component.html',
  styleUrl: './supressao-de-ruido.component.css'
})
export class SupressaoDeRuidoComponent implements OnInit, OnDestroy {
  @ViewChild('before') private beforeRef?: ElementRef<HTMLVideoElement>;
  @ViewChild('after') private afterRef?: ElementRef<HTMLAudioElement>;

  file: File | null = null;
  fileName = '';
  fileSize = 0;
  /** True once the loaded recording turns out to carry no picture. */
  audioOnly = false;

  engineId: EngineId = ENGINES[0].id;
  device: ProcessingDevice = 'cpu';
  get effectiveDevice(): ProcessingDevice { return this.engineId === 'gtcrn' ? this.device : 'cpu'; }
  get webgpuAvailable(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
  }
  strengthIndex = 1;
  /** Leave everything above the engine's reach exactly as it was. */
  preserveHighs = false;

  /**
   * The settings the result on screen was actually made with.
   *
   * Kept apart from the controls, because the controls can be moved after a run
   * and a summary that read off the controls would describe a file nobody has.
   * It is also what tells the reader the button is worth pressing again.
   */
  applied: { engine: EngineId; device?: ProcessingDevice; strength: number; preserveHighs: boolean; loudness?: LoudnessSettings } | null = null;

  /**
   * Levelling, from the same module the video editor uses.
   *
   * Off by default, like everywhere else it appears: a recording that was
   * already at a sensible level should not have its dynamics touched because a
   * tool it was passed through happened to offer it.
   */
  loudness: LoudnessSettings = { ...DEFAULT_LOUDNESS };
  loudnessOpen = false;
  levelling: LevellingReport | null = null;
  outputKind: OutputKind = 'media';
  formatId = AUDIO_FORMATS[0].id;

  working = false;
  analysing = false;
  noiseReport: NoiseReport | null = null;
  analysisContent: AnalysisSettings['content'] = DEFAULT_ANALYSIS_SETTINGS.content;
  analysisSensitivity: AnalysisSettings['sensitivity'] = DEFAULT_ANALYSIS_SETTINGS.sensitivity;
  useBackgroundReference = false;
  backgroundStart = 0;
  backgroundEnd = 1;
  useVoiceReference = false;
  voiceStart = 0;
  voiceEnd = 3;
  exporting = false;
  progress: SuppressionProgress | null = null;
  message = '';
  errorMessage = '';
  errorHint = '';

  /** What the file sounded like, and what it sounds like now. */
  originalUrl = '';
  cleanedUrl = '';
  compare: 'before' | 'after' = 'after';
  playing = false;
  position = 0;
  duration = 0;
  reduction = 0;

  private decoded: DecodedAudio | null = null;
  /**
   * What the engine heard, kept for as long as this recording is loaded.
   *
   * Strength, brightness and levelling all act on this rather than on the
   * audio, so changing one and pressing the button again is a second of
   * arithmetic instead of another pass of the model.
   */
  private field: GainField | null = null;
  private fieldEngine: EngineId | null = null;
  private fieldDevice: ProcessingDevice | null = null;
  private previewBlob: Blob | null = null;
  private cleaned: { channels: Float32Array[]; rate: number } | null = null;
  private controller: AbortController | null = null;
  private downloadUrl: string | null = null;
  private destroyed = false;

  readonly loudnessLimits = LOUDNESS_LIMITS;
  readonly engines = ENGINES;
  readonly strengths = STRENGTHS;
  readonly formats = AUDIO_FORMATS;
  readonly maxMinutes = MAX_MINUTES;

  constructor(
    private readonly dataService: DataService,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Background Noise Remover');
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.controller?.abort();
    this.release();
  }

  /* ------------------------------------------------------------- the file */

  onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const chosen = input.files?.[0] ?? null;
    input.value = '';
    if (!chosen || this.busy) return;

    this.release();
    this.file = chosen;
    this.fileName = chosen.name;
    this.fileSize = chosen.size;
    this.originalUrl = URL.createObjectURL(chosen);
    this.audioOnly = false;
    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.progress = null;
  }

  clearFile(): void {
    if (this.busy) return;
    this.release();
    this.file = null;
    this.fileName = '';
    this.fileSize = 0;
    this.message = '';
    this.progress = null;
  }

  /** The element reports its picture size only once the metadata has arrived. */
  onMediaLoaded(): void {
    const player = this.beforeRef?.nativeElement;
    if (!player) return;
    this.audioOnly = !player.videoWidth || !player.videoHeight;
    if (Number.isFinite(player.duration)) this.duration = player.duration;
    this.cdr.markForCheck();
  }

  get busy(): boolean {
    return this.working || this.exporting || this.analysing;
  }

  get analysisSettings(): AnalysisSettings {
    return { content: this.analysisContent, sensitivity: this.analysisSensitivity,
      background: this.useBackgroundReference ? { start: this.backgroundStart, end: this.backgroundEnd } : null,
      cleanVoice: this.useVoiceReference ? { start: this.voiceStart, end: this.voiceEnd } : null };
  }

  get analysisChanged(): boolean {
    return !!this.noiseReport && JSON.stringify(this.noiseReport.settings) !== JSON.stringify(this.analysisSettings);
  }

  resetAnalysisSettings(): void {
    if (this.busy) return;
    this.analysisContent = DEFAULT_ANALYSIS_SETTINGS.content;
    this.analysisSensitivity = DEFAULT_ANALYSIS_SETTINGS.sensitivity;
    this.useBackgroundReference = this.useVoiceReference = false;
    this.backgroundStart = this.voiceStart = 0;
    this.backgroundEnd = 1;
    this.voiceEnd = 3;
  }

  async analyse(): Promise<void> {
    if (!this.file || this.busy || !isPlatformBrowser(this.platformId)) return;
    this.analysing = true;
    this.pause();
    this.errorMessage = this.errorHint = this.message = '';
    const controller = new AbortController();
    this.controller = controller;
    const file = this.file, settings = this.analysisSettings;
    const check = () => { if (this.destroyed || controller.signal.aborted) throw new SuppressionCanceled(); };
    const progress = (update: SuppressionProgress) => {
      if (!this.destroyed && !controller.signal.aborted) { this.progress = update; this.cdr.markForCheck(); }
    };
    progress({ stage: 'reading', ratio: 0, detail: file.name });
    try {
      const decoded = this.decoded ?? await readAudio(file, progress, controller.signal);
      check();
      this.decoded = decoded;
      this.duration = decoded.seconds;
      validateAnalysis(settings, decoded.seconds);
      const report = await analyseNoise(decoded.channels.map(channel => channel.slice()), decoded.rate, settings,
        (ratio, detail) => progress({ stage: 'analysing', ratio, detail }), controller.signal);
      check();
      this.noiseReport = report;
      this.message = 'Background analysis complete. Your audio has not been changed.';
    } catch (error) {
      if (this.destroyed) return;
      if (error instanceof SuppressionCanceled) this.message = 'Analysis stopped. Previous results were kept.';
      else {
        this.errorMessage = 'The background could not be analysed.';
        this.errorHint = error instanceof SuppressionError ? error.hint : error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.analysing = false;
      this.controller = null;
      this.progress = null;
      if (!this.destroyed) this.cdr.markForCheck();
    }
  }

  listenToAnalysis(start: number): void {
    if (this.busy) return;
    this.choose('before');
    const player = this.beforeRef?.nativeElement;
    if (player) { player.currentTime = start; this.position = start; void player.play().catch(() => {}); }
  }

  get appliedEngine(): string {
    return this.engines.find((entry) => entry.id === this.applied?.engine)?.label ?? '';
  }

  get appliedStrength(): string {
    return this.applied ? this.strengths[this.applied.strength]?.label ?? '' : '';
  }

  /** True when the controls no longer describe the result on screen. */
  get settingsChanged(): boolean {
    if (!this.applied) return false;
    if (this.applied.engine !== this.engineId) return true;
    if ((this.applied.device ?? 'cpu') !== this.effectiveDevice) return true;
    if (this.applied.strength !== this.strengthIndex) return true;
    if (this.applied.preserveHighs !== this.preserveHighs) return true;

    const was = this.applied.loudness;
    if (!was) return this.loudness.enabled;
    return (Object.keys(was) as (keyof LoudnessSettings)[]).some((key) => was[key] !== this.loudness[key]);
  }

  /**
   * Whether pressing the button again means listening to the recording again.
   *
   * Only the engine costs real time, and only the engine's own choice changes
   * what it hears. Everything else is arithmetic over what it already said.
   */
  get needsEngine(): boolean {
    return !this.field || this.fieldEngine !== this.engineId || this.fieldDevice !== this.effectiveDevice;
  }

  /* --------------------------------------------------------- the levelling */

  patchLoudness(change: Partial<LoudnessSettings>): void {
    this.loudness = clampLoudness({ ...this.loudness, ...change });
  }

  onLoudnessNumber(field: 'targetDb' | 'maxBoostDb' | 'maxCutDb' | 'smoothingSeconds' | 'noiseFloorDb', raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    this.patchLoudness({ [field]: value } as Partial<LoudnessSettings>);
  }

  onLoudnessMode(mode: string): void {
    this.patchLoudness({ mode: mode === 'match' ? 'match' : ('level' as LoudnessMode) });
  }

  /** What levelling actually did, once it has done it. */
  get levellingNote(): string {
    if (this.ready && !this.applied?.loudness?.enabled) return 'Volume levelling has not been applied to this result.';
    if (!this.loudness.enabled) return '';
    if (!this.levelling) {
      return this.ready
        ? 'Nothing above the noise floor was found to measure, so the volume was left as it was.'
        : 'Measured after the noise is removed, so the level read is the voice rather than the voice plus the background.';
    }

    const direction = this.levelling.staticGainDb >= 0 ? 'up' : 'down';
    const amount = Math.abs(Math.round(this.levelling.staticGainDb * 10) / 10);
    const measured = Math.round(this.levelling.measuredDb * 10) / 10;
    const held = this.levelling.clipped ? ', held back by the lift and hold limits' : '';
    return `Speech measured at ${measured} dBFS and brought ${direction} by ${amount} dB${held}.`;
  }

  /* -------------------------------------------------------------- the job */

  async run(): Promise<void> {
    if (!this.file || this.busy || !isPlatformBrowser(this.platformId)) return;

    this.working = true;
    this.message = '';
    this.errorMessage = '';
    this.errorHint = '';
    this.pause();
    this.progress = { stage: 'reading', ratio: 0, detail: this.fileName };

    const controller = new AbortController();
    this.controller = controller;
    const file = this.file;
    const settings = { engine: this.engineId, device: this.effectiveDevice, strength: this.strengthIndex,
      preserveHighs: this.preserveHighs, loudness: { ...this.loudness } };
    const checkActive = () => {
      if (this.destroyed || controller.signal.aborted) throw new SuppressionCanceled();
    };

    const report = (update: SuppressionProgress) => {
      if (this.destroyed || controller.signal.aborted) return;
      this.progress = update;
      this.cdr.markForCheck();
    };

    try {
      // Decoded once per file. A second run at a different strength reads the
      // samples that are already here rather than the container again.
      const decoded = this.decoded ?? (await readAudio(file, report, controller.signal));
      checkActive();
      this.decoded = decoded;
      this.duration = decoded.seconds;
      if (!decoded.hasVideo) this.outputKind = 'audio';

      const cachedField = this.fieldEngine === settings.engine && this.fieldDevice === settings.device
        ? this.field ?? undefined : undefined;
      // Transfer ownership. A cancelled worker may discard the analysis, but
      // the previously completed audio and preview remain available.
      this.field = null;
      const result = await suppress(
        {
          channels: decoded.channels.map((channel) => Float32Array.from(channel)),
          rate: decoded.rate,
          engine: settings.engine,
          device: settings.device,
          attenuationDb: this.strengths[settings.strength].attenuationDb,
          preserveHighs: settings.preserveHighs,
          loudness: settings.loudness,
          cachedField
        },
        report,
        controller.signal
      );

      checkActive();
      this.field = result.field ?? null;
      this.fieldEngine = settings.engine;
      this.fieldDevice = settings.device;

      // A plain WAV of the result, so the comparison can be heard immediately
      // without waiting for the encoder the download will use.
      report({ stage: 'writing', ratio: null, detail: 'preview' });
      const preview = await writeAudio(
        { file, channels: result.channels, rate: decoded.rate, format: AUDIO_FORMATS[0] },
        report,
        controller.signal
      );
      checkActive();
      const url = URL.createObjectURL(preview.blob);
      this.dropCleaned();
      this.revokeDownload();
      this.cleaned = { channels: result.channels, rate: decoded.rate };
      this.reduction = result.reduction;
      this.levelling = result.levelling;
      this.applied = settings;
      this.previewBlob = preview.blob;
      this.cleanedUrl = url;
      this.compare = 'after';
      const change = this.reduction < 0 ? 'lower' : this.reduction > 0 ? 'higher' : 'unchanged';
      this.message = `Done. Quiet-region level is ${Math.abs(this.reduction).toFixed(1)} dB ${change} before volume levelling. Compare both versions to judge the voice.`;
    } catch (error) {
      if (this.destroyed) return;
      this.progress = null;
      if (error instanceof SuppressionCanceled) {
        this.message = 'Stopped.';
      } else if (error instanceof SuppressionError) {
        this.errorMessage = error.message;
        this.errorHint = error.hint;
      } else {
        this.errorMessage = 'The noise suppression failed.';
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

  /* ---------------------------------------------------------- the listening */

  get ready(): boolean {
    return Boolean(this.cleanedUrl);
  }

  private get active(): HTMLMediaElement | null {
    return this.compare === 'before'
      ? this.beforeRef?.nativeElement ?? null
      : this.afterRef?.nativeElement ?? null;
  }

  /** Switching sides keeps the instant: the same moment, cleaned or not. */
  choose(side: 'before' | 'after'): void {
    if (this.compare === side) return;
    const current = this.active;
    const at = current?.currentTime ?? this.position;
    const wasPlaying = this.playing;

    current?.pause();
    this.beforeRef?.nativeElement.pause();
    this.compare = side;

    // The picture is muted only while the cleaned soundtrack is the one being
    // heard; on the original side it is the soundtrack.
    const picture = this.beforeRef?.nativeElement;
    if (picture) {
      picture.muted = side === 'after';
      picture.currentTime = at;
    }

    const next = this.active;
    if (next) {
      next.currentTime = at;
      if (wasPlaying) void next.play().catch(() => { this.playing = false; });
    }
  }

  toggle(): void {
    const player = this.active;
    if (!player) return;
    if (this.playing) {
      player.pause();
      return;
    }
    void player.play().catch(() => {
      this.message = 'Use the player controls to start playback.';
      this.cdr.markForCheck();
    });
  }

  /**
   * The picture follows the cleaned side.
   *
   * The cleaned audio is a separate element with no video in it, so on its own
   * the "Cleaned" side of a video would be sound over a frozen frame. The
   * original element is muted and driven from the audio's own clock instead,
   * which gives the picture back without either soundtrack being heard twice.
   */
  onPlay(side: 'before' | 'after'): void {
    if (this.compare !== side) return;
    this.playing = true;

    if (side === 'after') {
      const picture = this.beforeRef?.nativeElement;
      const sound = this.afterRef?.nativeElement;
      if (picture && sound) {
        picture.muted = true;
        picture.currentTime = sound.currentTime;
        void picture.play().catch(() => undefined);
      }
    }

    this.cdr.markForCheck();
  }

  onPause(side: 'before' | 'after'): void {
    if (this.compare !== side) return;
    this.playing = false;
    if (side === 'after') this.beforeRef?.nativeElement.pause();
    this.cdr.markForCheck();
  }

  onTime(side: 'before' | 'after'): void {
    if (this.compare !== side) return;
    this.position = this.active?.currentTime ?? 0;
    this.followPicture();
  }

  seek(raw: string): void {
    const at = Number(raw);
    if (!Number.isFinite(at)) return;
    this.position = at;
    const player = this.active;
    if (player) player.currentTime = at;
    if (this.compare === 'after' && this.beforeRef) this.beforeRef.nativeElement.currentTime = at;
  }

  private pause(): void {
    this.beforeRef?.nativeElement.pause();
    this.afterRef?.nativeElement.pause();
    this.playing = false;
  }

  /**
   * The picture drifts from the sound over a long take.
   *
   * Two media elements playing from two clocks do not stay locked for ten
   * minutes, so the picture is nudged back whenever it has wandered further
   * than a listener would forgive. A quarter of a second is well past the
   * threshold where lip sync is noticed, and small enough that the correction
   * is a jump of a frame or two rather than a visible seek.
   */
  private followPicture(): void {
    if (this.compare !== 'after' || !this.playing) return;

    const picture = this.beforeRef?.nativeElement;
    const sound = this.afterRef?.nativeElement;
    if (!picture || !sound || picture.paused) return;

    if (Math.abs(picture.currentTime - sound.currentTime) > 0.25) {
      picture.currentTime = sound.currentTime;
    }
  }

  /* --------------------------------------------------------- the download */

  get format(): AudioFormat {
    return this.formats.find((entry) => entry.id === this.formatId) ?? this.formats[0];
  }

  get canKeepPicture(): boolean {
    return Boolean(this.decoded?.hasVideo);
  }

  get downloadName(): string {
    const stem = this.fileName.replace(/\.[^.]+$/, '') || 'recording';
    const extension = this.outputKind === 'media' && this.canKeepPicture
      ? this.fileName.split('.').pop() ?? 'mp4'
      : this.format.extension;
    return `${stem}-clean.${extension}`;
  }

  async download(): Promise<void> {
    if (!this.cleaned || !this.file || this.busy || !isPlatformBrowser(this.platformId)) return;

    this.exporting = true;
    this.errorMessage = '';
    this.message = '';
    const controller = new AbortController();
    this.controller = controller;

    try {
      const preview = this.outputKind === 'audio' && this.format.id === 'wav' ? this.previewBlob : null;
      const written = preview ? { blob: preview, extension: 'wav' } : await writeAudio(
        {
          file: this.file,
          channels: this.cleaned.channels,
          rate: this.cleaned.rate,
          format: this.outputKind === 'media' && this.canKeepPicture ? null : this.format
        },
        (update) => {
          if (this.destroyed) return;
          this.progress = update;
          this.cdr.markForCheck();
        },
        controller.signal
      );

      if (this.destroyed || controller.signal.aborted) throw new SuppressionCanceled();
      this.revokeDownload();
      this.downloadUrl = URL.createObjectURL(written.blob);

      const stem = this.fileName.replace(/\.[^.]+$/, '') || 'recording';
      const link = document.createElement('a');
      link.href = this.downloadUrl;
      link.download = `${stem}-clean.${written.extension}`;
      link.click();

      this.message = `Saved as ${link.download}.`;
    } catch (error) {
      if (this.destroyed) return;
      if (error instanceof SuppressionCanceled) {
        this.message = 'Stopped.';
      } else {
        this.errorMessage = 'The file could not be written.';
        this.errorHint = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.exporting = false;
      this.progress = null;
      this.controller = null;
      if (!this.destroyed) this.cdr.markForCheck();
    }
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

  get engine() {
    return this.engines.find((entry) => entry.id === this.engineId) ?? this.engines[0];
  }

  get strength() {
    return this.strengths[this.strengthIndex] ?? this.strengths[1];
  }

  time(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /* ------------------------------------------------------------- clean-up */

  private dropCleaned(): void {
    if (this.cleanedUrl) URL.revokeObjectURL(this.cleanedUrl);
    this.cleanedUrl = '';
    this.cleaned = null;
    this.previewBlob = null;
    this.applied = null;
    this.levelling = null;
    this.reduction = 0;
    this.compare = 'before';
  }

  private revokeDownload(): void {
    if (!this.downloadUrl) return;
    URL.revokeObjectURL(this.downloadUrl);
    this.downloadUrl = null;
  }

  private release(): void {
    this.noiseReport = null;
    this.useBackgroundReference = this.useVoiceReference = false;
    this.pause();
    this.dropCleaned();
    this.field = null;
    this.fieldEngine = null;
    this.fieldDevice = null;
    this.applied = null;
    this.revokeDownload();
    if (this.originalUrl) URL.revokeObjectURL(this.originalUrl);
    this.originalUrl = '';
    this.decoded = null;
    this.duration = 0;
    this.position = 0;
  }
}

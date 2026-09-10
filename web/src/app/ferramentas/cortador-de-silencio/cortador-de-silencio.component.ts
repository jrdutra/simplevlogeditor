import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ChangeDetectorRef, Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, PLATFORM_ID, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';

import { DataService } from '../../data.service';
import { AutoZoomControlComponent } from '../../shared/media/auto-zoom-control.component';
import { AutoZoomSettings, describeZoomPlan, planAutoZooms } from '../../shared/media/auto-zoom';
import { AudioAnalysisService } from './audio-analysis.service';
import { MediaCapabilitiesService, BrowserCapabilities } from './media-capabilities.service';
import { MediaInspectorService } from './media-inspector.service';
import { MediaRenderService, RenderDestination } from './media-render.service';
import { ProcessingEngineSelectorService } from './processing-engine-selector.service';
import { describeError, silenceLog } from './silence-cutter-log';
import { keepRangesFor, mergeEditableRanges, totalDuration } from './silence-detector';
import { RangeResize, SilenceWaveformComponent, formatDuration } from './waveform.component';
import {
  CROSSFADE_OPTIONS,
  DETECTION_WINDOWS,
  PresetId,
  SETTING_LIMITS,
  SILENCE_PRESETS,
  clampSettings,
  loadStoredSettings,
  presetFor,
  storeSettings
} from './silence-cutter-presets';
import {
  AnalysisStage,
  ChannelMode,
  EditableRange,
  MediaInfo,
  MediaToolError,
  OperationCanceledError,
  OptimizationPreference,
  ProcessingStrategy,
  RenderResult,
  RenderStage,
  SilenceAnalysis,
  SilenceCutterState,
  SilenceSettings,
  TimeRange,
  detectionSettingsChanged
} from './silence-cutter.models';
import { HelpPanelComponent } from '../../shared/ui/help-panel.component';

/** Extensions offered in the file dialog. The real check is the parsed header. */
const ACCEPTED = '.mp4,.mov,.m4v,.webm,.mkv,.m4a,.mp3,.wav,.aac,.ogg,.oga,.flac,video/*,audio/*';

/** Above this, a phone or tablet is likely to run out of room before finishing. */
const LARGE_FILE_BYTES = 1_500_000_000;

/** Share of the media that, once marked as silence, is worth questioning. */
const MOSTLY_SILENT_RATIO = 0.9;

const ANALYSIS_STAGE_LABEL: Record<AnalysisStage, string> = {
  reading: 'Reading media',
  decoding: 'Decoding audio',
  waveform: 'Building waveform',
  detecting: 'Detecting silence',
  preparing: 'Preparing preview'
};

const RENDER_STAGE_LABEL: Record<RenderStage, string> = {
  preparing: 'Preparing',
  decoding: 'Decoding',
  cutting: 'Cutting',
  encoding: 'Encoding',
  muxing: 'Muxing',
  saving: 'Saving',
  finishing: 'Finishing'
};

/**
 * Free Silence Cutter.
 *
 * The component owns the state machine and nothing else: every byte of media is
 * handled by the services, and the one rule it enforces itself is the important
 * one — a cut may only ever be rendered from an analysis that matches the
 * settings currently on screen. The moment a detection setting changes, the
 * waveform, the cut regions and the summary are dropped rather than left on
 * screen looking authoritative, and the only way back is to reanalyze.
 */
@Component({
  selector: 'app-cortador-de-silencio',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
    MatFormFieldModule,
    AutoZoomControlComponent,
    SilenceWaveformComponent
  ,
    HelpPanelComponent],
  templateUrl: './cortador-de-silencio.component.html',
  styleUrl: './cortador-de-silencio.component.css'
})
export class CortadorDeSilencioComponent implements OnInit, OnDestroy {
  state: SilenceCutterState = 'idle';

  file: File | null = null;
  info: MediaInfo | null = null;
  analysis: SilenceAnalysis | null = null;
  strategy: ProcessingStrategy | null = null;
  capabilities: BrowserCapabilities | null = null;
  result: RenderResult | null = null;

  settings: SilenceSettings = loadStoredSettings();
  preset: PresetId = presetFor(this.settings);
  optimization: OptimizationPreference = 'automatic';

  advancedOpen = false;
  detailsOpen = false;
  confirming = false;
  dragging = false;

  stageLabel = '';
  progressRatio: number | null = null;

  errorMessage = '';
  errorHint = '';
  /** Raw failure text, shown next to the friendly message for bug reports. */
  errorDetail = '';
  notice = '';
  diagnosticsCopied = false;

  previewUrl: string | null = null;
  currentTime = 0;
  skipSilence = false;

  /** Settings the current analysis was produced with, for the invalidation check. */
  private analysedWith: SilenceSettings | null = null;
  private controller: AbortController | null = null;
  private timeTracker = 0;

  readonly presets = SILENCE_PRESETS;
  readonly limits = SETTING_LIMITS;
  readonly detectionWindows = DETECTION_WINDOWS;
  readonly crossfades = CROSSFADE_OPTIONS;
  readonly accepted = ACCEPTED;
  readonly channelModes: { value: ChannelMode; label: string; hint: string }[] = [
    { value: 'combined', label: 'Combined', hint: 'Measures every channel together. The safe default.' },
    { value: 'any', label: 'Any channel', hint: 'A moment counts as silence as soon as one channel falls quiet.' },
    { value: 'all', label: 'All channels', hint: 'Every channel has to fall quiet before a moment counts as silence.' }
  ];

  @ViewChild('player') private player?: ElementRef<HTMLMediaElement>;

  constructor(
    private readonly dataService: DataService,
    private readonly inspector: MediaInspectorService,
    private readonly analyser: AudioAnalysisService,
    private readonly renderer: MediaRenderService,
    private readonly selector: ProcessingEngineSelectorService,
    private readonly capabilityService: MediaCapabilitiesService,
    private readonly zone: NgZone,
    private readonly cdr: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnInit(): void {
    this.dataService.setTituloAplicacao('Free Silence Cutter');
    if (!isPlatformBrowser(this.platformId)) return;

    void this.capabilityService.detect().then((capabilities) => {
      this.capabilities = capabilities;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy(): void {
    this.controller?.abort();
    this.releasePreview();
    if (this.timeTracker) cancelAnimationFrame(this.timeTracker);
  }

  // -------------------------------------------------------------- selection

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
    const file = event.dataTransfer?.files?.[0];
    if (file) await this.select(file);
  }

  async onFileInput(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await this.select(file);
  }

  /**
   * Accepts a new file and throws away everything about the previous one.
   *
   * Anything still running is aborted first: a half-finished analysis of the
   * file the reader just replaced has no value and would keep decoding in the
   * background while they wait for the new one.
   */
  async select(file: File): Promise<void> {
    if (!isPlatformBrowser(this.platformId)) return;

    this.controller?.abort();
    this.resetAnalysis();
    this.releasePreview();

    silenceLog.reset(`file selected (${file.size} bytes)`);

    this.file = file;
    this.info = null;
    this.result = null;
    this.errorMessage = '';
    this.errorHint = '';
    this.errorDetail = '';
    this.notice = '';
    this.state = 'analyzing';
    this.stageLabel = 'Reading media';
    this.progressRatio = null;

    try {
      const info = await this.inspector.inspect(file);
      this.info = info;
      this.state = 'file-selected';
      silenceLog.info('ui', 'file accepted', {
        kind: info.kind,
        container: info.containerName,
        duration: info.durationSeconds
      });

      if (!info.hasAudioTrack) {
        this.fail(
          new MediaToolError(
            'No audio track was found in this video.',
            'Silence detection requires an audio track.'
          )
        );
        return;
      }

      this.previewUrl = URL.createObjectURL(file);
      this.strategy = await this.selector.select(info, this.optimization, { hasCuts: true });

      if (file.size > LARGE_FILE_BYTES) {
        this.notice =
          'This is a large file. Analysis streams it in small pieces, but exporting it needs a current desktop browser and free disk space.';
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.cdr.markForCheck();
    }
  }

  clear(): void {
    this.controller?.abort();
    this.releasePreview();
    this.resetAnalysis();
    this.file = null;
    this.info = null;
    this.result = null;
    this.strategy = null;
    this.errorMessage = '';
    this.errorHint = '';
    this.errorDetail = '';
    this.notice = '';
    this.state = 'idle';
  }

  // --------------------------------------------------------------- settings

  applyPreset(id: PresetId): void {
    const preset = this.presets.find((candidate) => candidate.id === id);
    if (!preset) return;
    // The crossfade and the automatic zoom belong to rendering, so a preset —
    // which only ever describes how eagerly to detect — never overwrites them.
    this.updateSettings({
      ...preset.settings,
      crossfadeMs: this.settings.crossfadeMs,
      autoZoom: this.settings.autoZoom
    });
  }

  /**
   * Applies a change and, when it affects detection, invalidates the analysis.
   *
   * This is the one behaviour the whole tool is built around: sliders never
   * trigger a new analysis by themselves — that would burn battery and lock up
   * the controls — but a finished analysis can never survive a change to what
   * it measured.
   */
  updateSettings(next: Partial<SilenceSettings>): void {
    const merged = clampSettings({ ...this.settings, ...next });
    const affectsDetection = detectionSettingsChanged(this.settings, merged);

    this.settings = merged;
    this.preset = presetFor(merged);
    storeSettings(merged);

    if (!affectsDetection) return;
    if (this.state === 'analysis-ready' || this.state === 'completed') {
      this.resetAnalysis();
      this.state = 'analysis-invalid';
    }
  }

  onNumber(key: keyof SilenceSettings, value: string | number): void {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return;
    this.updateSettings({ [key]: parsed } as Partial<SilenceSettings>);
  }

  onAutoZoom(autoZoom: AutoZoomSettings): void {
    this.updateSettings({ autoZoom });
  }

  /**
   * What the current zoom settings would actually do to this recording.
   *
   * Recomputed from the finished analysis on every read, which is cheap — the
   * planner walks two short lists — and is the only way the line can stay
   * truthful while the reader is still moving the numbers around.
   */
  get zoomPlanNote(): string {
    if (!this.settings.autoZoom.enabled) {
      return 'Hides the jump where a long pause was removed by pushing in slightly on what follows it.';
    }
    if (!this.analysis || !this.file) return 'Analyze the file to see how many zooms it would get.';
    if (!this.info?.width) return 'This file has no picture, so nothing would be zoomed.';

    return describeZoomPlan(
      planAutoZooms(
        this.analysis.silenceRanges.filter((range) => range.enabled),
        this.analysis.keepRanges,
        this.settings.autoZoom,
        `${this.file.name}:${this.file.size}`
      )
    );
  }

  onChannelMode(mode: ChannelMode): void {
    this.updateSettings({ channelMode: mode });
  }

  async onOptimizationChange(preference: OptimizationPreference): Promise<void> {
    this.optimization = preference;
    if (!this.info) return;
    this.strategy = await this.selector.select(this.info, preference, { hasCuts: true });
    this.cdr.markForCheck();
  }

  // --------------------------------------------------------------- analysis

  async analyze(): Promise<void> {
    if (!this.file || !this.info || !this.strategy) return;
    if (this.state === 'analyzing' || this.state === 'processing') return;

    this.controller = new AbortController();
    this.state = 'analyzing';
    this.errorMessage = '';
    this.errorHint = '';
    this.result = null;
    this.confirming = false;
    this.progressRatio = null;
    this.stageLabel = ANALYSIS_STAGE_LABEL.reading;

    const settings = { ...this.settings };
    silenceLog.info('ui', 'analysis requested', { ...settings, optimization: this.optimization });

    try {
      const analysis = await this.zone.runOutsideAngular(() =>
        this.analyser.analyze(this.file as File, this.info as MediaInfo, {
          settings,
          strategy: this.strategy as ProcessingStrategy,
          signal: (this.controller as AbortController).signal,
          onProgress: (report) => {
            this.zone.run(() => {
              this.stageLabel = ANALYSIS_STAGE_LABEL[report.stage];
              this.progressRatio = report.ratio;
              this.cdr.markForCheck();
            });
          }
        })
      );

      this.analysis = analysis;
      this.analysedWith = settings;
      this.state = 'analysis-ready';
      this.notice = this.reviewNotice(analysis);

      // Now that the cut count is known, the strategy can take the cheap path
      // when there is in fact nothing to cut.
      this.strategy = await this.selector.select(this.info, this.optimization, {
        hasCuts: analysis.silenceRanges.length > 0
      });
    } catch (error) {
      if (error instanceof OperationCanceledError) {
        silenceLog.info('ui', 'analysis canceled by the reader');
        this.state = this.analysis ? 'analysis-ready' : 'file-selected';
      } else {
        this.fail(error);
      }
    } finally {
      this.controller = null;
      this.progressRatio = null;
      this.cdr.markForCheck();
    }
  }

  cancel(): void {
    silenceLog.info('ui', 'cancel requested', { state: this.state });
    this.controller?.abort();
  }

  // -------------------------------------------------------------- rendering

  askConfirmation(): void {
    if (this.state !== 'analysis-ready') return;
    this.confirming = true;
  }

  dismissConfirmation(): void {
    this.confirming = false;
  }

  /**
   * Renders the cut file.
   *
   * The destination is chosen first, before anything is awaited that could
   * outlive the click: the save dialog needs user activation, and asking for it
   * later would leave a reader who wanted the file on disk with a download
   * instead.
   */
  async removeSilence(): Promise<void> {
    if (this.state !== 'analysis-ready' || !this.file || !this.info || !this.analysis || !this.strategy) return;
    if (this.analysedWith && detectionSettingsChanged(this.analysedWith, this.settings)) return;

    this.confirming = false;
    silenceLog.info('ui', 'export requested', {
      cuts: this.analysis.silenceRanges.length,
      outputDuration: this.analysis.outputDuration,
      crossfadeMs: this.settings.crossfadeMs
    });

    let destination: RenderDestination;
    try {
      destination = await this.renderer.pickDestination(this.info, this.strategy);
    } catch (error) {
      this.fail(error);
      return;
    }

    this.controller = new AbortController();
    this.state = 'processing';
    this.errorMessage = '';
    this.errorHint = '';
    this.progressRatio = 0;
    this.stageLabel = RENDER_STAGE_LABEL.preparing;

    try {
      const result = await this.zone.runOutsideAngular(() =>
        this.renderer.render(this.file as File, this.info as MediaInfo, {
          analysis: this.analysis as SilenceAnalysis,
          settings: this.settings,
          strategy: this.strategy as ProcessingStrategy,
          destination,
          signal: (this.controller as AbortController).signal,
          onProgress: (report) => {
            this.zone.run(() => {
              this.stageLabel = RENDER_STAGE_LABEL[report.stage];
              this.progressRatio = report.ratio;
              this.cdr.markForCheck();
            });
          }
        })
      );

      this.result = result;
      this.state = 'completed';
      silenceLog.info('ui', 'export finished', {
        fileName: result.fileName,
        savedToDisk: result.savedToDisk,
        bytes: result.blob?.size ?? null
      });
    } catch (error) {
      if (error instanceof OperationCanceledError) {
        silenceLog.info('ui', 'export canceled by the reader');
        this.state = 'analysis-ready';
      } else {
        this.fail(error);
      }
    } finally {
      this.controller = null;
      this.progressRatio = null;
      this.cdr.markForCheck();
    }
  }

  /** Downloads the finished file when it was not streamed straight to disk. */
  save(): void {
    const result = this.result;
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

  // ----------------------------------------------------------- manual edits

  /**
   * Adds a region the reader drew on the waveform.
   *
   * A hand-drawn region is a cut like any other: it goes through the same
   * merge as the detected ones, so overlapping a detected pause widens that
   * pause instead of stacking a second block on top of it.
   */
  addCutRange(range: TimeRange): void {
    const analysis = this.analysis;
    if (!analysis || range.end <= range.start) return;

    const added: EditableRange = {
      start: range.start,
      end: range.end,
      source: 'manual',
      enabled: true
    };

    silenceLog.info('ui', 'manual cut added', {
      start: Math.round(range.start * 100) / 100,
      end: Math.round(range.end * 100) / 100
    });

    this.applyRanges(mergeEditableRanges([...analysis.silenceRanges, added], analysis.originalDuration));
  }

  /** Deletes one region, whether it was detected or drawn by hand. */
  removeCutRange(range: EditableRange): void {
    const analysis = this.analysis;
    if (!analysis) return;

    const next = analysis.silenceRanges.filter((candidate) => candidate !== range);
    if (next.length === analysis.silenceRanges.length) return;

    silenceLog.info('ui', 'cut region deleted', {
      source: range.source,
      start: Math.round(range.start * 100) / 100,
      end: Math.round(range.end * 100) / 100
    });

    this.applyRanges(next);
  }

  /** Applies a boundary dragged on a cut without changing its origin. */
  resizeCutRange(change: RangeResize): void {
    const analysis = this.analysis;
    if (!analysis || !analysis.silenceRanges.includes(change.range)) return;

    this.applyRanges(analysis.silenceRanges.map((range) => range === change.range
      ? { ...range, start: change.start, end: change.end }
      : range));
  }

  /**
   * Rewrites the analysis around a new list of cut regions.
   *
   * Everything downstream reads the kept ranges and the durations rather than
   * the cut list, so they are recomputed here and nowhere else. A finished
   * export is dropped at the same time: the file on disk no longer matches
   * what the waveform now promises.
   */
  private applyRanges(ranges: EditableRange[]): void {
    const analysis = this.analysis;
    if (!analysis) return;

    const duration = analysis.originalDuration;
    const removedDuration = totalDuration(ranges.filter((range) => range.enabled));

    this.analysis = {
      ...analysis,
      silenceRanges: ranges,
      keepRanges: keepRangesFor(ranges, duration),
      removedDuration,
      outputDuration: Math.max(0, duration - removedDuration)
    };

    if (this.state === 'completed') {
      this.result = null;
      this.state = 'analysis-ready';
    }

    this.confirming = false;
    this.notice = this.reviewNotice(this.analysis);
    this.cdr.markForCheck();

    void this.refreshStrategy(ranges.length > 0);
  }

  /** Re-picks the pipeline once the number of cuts changes. */
  private async refreshStrategy(hasCuts: boolean): Promise<void> {
    if (!this.info) return;
    this.strategy = await this.selector.select(this.info, this.optimization, { hasCuts });
    this.cdr.markForCheck();
  }

  // ---------------------------------------------------------------- preview

  onPlayerReady(): void {
    this.trackTime();
  }

  seekTo(time: number): void {
    const player = this.player?.nativeElement;
    if (!player) return;
    player.currentTime = Math.max(0, Math.min(time, this.info?.durationSeconds ?? time));
    this.currentTime = player.currentTime;
  }

  toggleSkipSilence(): void {
    this.skipSilence = !this.skipSilence;
  }

  /**
   * Follows the player and, in preview mode, jumps over the cut regions.
   *
   * This is what "preview cuts" means here: the original file plays and the
   * removed ranges are skipped live, so the reader hears the edit without
   * waiting for anything to be rendered.
   */
  private trackTime(): void {
    if (typeof requestAnimationFrame === 'undefined') return;

    this.zone.runOutsideAngular(() => {
      const tick = () => {
        const player = this.player?.nativeElement;
        if (player) {
          let time = player.currentTime;

          if (this.skipSilence && this.analysis && !player.paused) {
            const range = this.analysis.silenceRanges.find(
              (candidate) => candidate.enabled && time >= candidate.start && time < candidate.end - 0.02
            );
            if (range) {
              player.currentTime = range.end;
              time = range.end;
            }
          }

          if (Math.abs(time - this.currentTime) > 0.02) {
            this.currentTime = time;
            this.zone.run(() => this.cdr.markForCheck());
          }
        }
        this.timeTracker = requestAnimationFrame(tick);
      };

      this.timeTracker = requestAnimationFrame(tick);
    });
  }

  // ----------------------------------------------------------- presentation

  get canAnalyze(): boolean {
    return Boolean(this.file && this.info?.hasAudioTrack) && this.state !== 'analyzing' && this.state !== 'processing';
  }

  get canRender(): boolean {
    return this.state === 'analysis-ready' && Boolean(this.analysis?.silenceRanges.length);
  }

  get busy(): boolean {
    return this.state === 'analyzing' || this.state === 'processing';
  }

  get analyzeLabel(): string {
    return this.state === 'analysis-invalid' ? 'Reanalyze Media' : 'Analyze Media';
  }

  get showWaveform(): boolean {
    return this.state === 'analysis-ready' || this.state === 'processing' || this.state === 'completed';
  }

  get reductionPercent(): number {
    const analysis = this.analysis;
    if (!analysis?.originalDuration) return 0;
    return Math.round((analysis.removedDuration / analysis.originalDuration) * 1000) / 10;
  }

  get thresholdWarning(): string {
    const analysis = this.analysis;
    if (!analysis) {
      // Before any analysis the peak is unknown, so only obviously risky
      // combinations are flagged.
      return this.settings.thresholdDb > -25 && this.settings.minimumSilenceMs < 300
        ? 'A high threshold combined with a very short minimum duration can mark quiet speech as silence.'
        : '';
    }

    if (analysis.originalDuration > 0 && analysis.removedDuration / analysis.originalDuration > MOSTLY_SILENT_RATIO) {
      return 'Almost the entire media was detected as silence. Review your settings before continuing.';
    }
    return '';
  }

  formatTime(seconds: number): string {
    return formatDuration(seconds);
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

  /** Human label for the audio pipeline, without claiming a specific device. */
  get accelerationLabel(): string {
    if (!this.strategy) return '';
    return this.strategy.hardwareAccelerationPreferred
      ? 'Hardware acceleration preferred for the selected pipeline'
      : 'Software-compatible pipeline selected';
  }

  private reviewNotice(analysis: SilenceAnalysis): string {
    if (!analysis.silenceRanges.length) {
      return 'No region is marked for removal. Draw one on the waveform, or adjust the settings and reanalyze.';
    }
    if (analysis.peakDb < this.settings.thresholdDb + 6) {
      return 'The loudest moment of this media is close to the silence threshold. Lower the threshold for a safer result.';
    }
    return '';
  }

  /** Drops every product of the previous analysis, waveform included. */
  private resetAnalysis(): void {
    this.analysis = null;
    this.analysedWith = null;
    this.confirming = false;
    this.result = null;
  }

  private releasePreview(): void {
    if (!this.previewUrl) return;
    URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  /**
   * Copies the whole diagnostic trail.
   *
   * A reader reporting a problem should not have to scrape the console: the
   * ordered record of what the tool decided, and where it stopped, is one
   * click away from the error card.
   */
  async copyDiagnostics(): Promise<void> {
    const text = silenceLog.transcript();

    try {
      await navigator.clipboard.writeText(text);
      this.diagnosticsCopied = true;
      setTimeout(() => {
        this.diagnosticsCopied = false;
        this.cdr.markForCheck();
      }, 2500);
    } catch {
      // Clipboard access can be refused; printing it is still useful.
      console.info(text);
      this.notice = 'The diagnostic log was printed to the browser console.';
    }
    this.cdr.markForCheck();
  }

  get diagnosticsCount(): number {
    return silenceLog.size;
  }

  private fail(error: unknown): void {
    const details = describeError(error);
    silenceLog.error('ui', 'reporting failure to the reader', details);

    if (error instanceof MediaToolError) {
      this.errorMessage = error.message;
      this.errorHint = error.hint ?? '';
      this.errorDetail = '';
    } else {
      console.error(error);
      this.errorMessage = 'The media could not be processed.';
      this.errorHint = 'Check that the file is a valid video or audio file and try again.';
      this.errorDetail = `${details['name'] ?? 'Error'}: ${details['message'] ?? String(error)}`;
    }
    this.state = 'error';
  }
}

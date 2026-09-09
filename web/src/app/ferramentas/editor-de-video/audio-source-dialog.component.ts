import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Inject,
  Input,
  NgZone,
  OnDestroy,
  Output,
  PLATFORM_ID
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';
import { SILENCE_PRESETS } from '../cortador-de-silencio/silence-cutter-presets';
import type { PresetId } from '../cortador-de-silencio/silence-cutter-presets';
import { ACCEPTED_AUDIO } from './video-editor-defaults';
import { AudioCleanupError, CleanupReport, CleanupSettings, cleanName, cleanUpAudio } from './audio-cleanup';
import { NarrationRecorder, RecorderError } from './narration-recorder';
import { StoredHandle, pickFilesWithHandles } from './file-handle-store';

/** Which of the dialog's three faces is showing. */
type Stage = 'choose' | 'recording' | 'review';

/**
 * One way to put a sound into the project, wherever the sound is going.
 *
 * Before this, every place that wanted audio opened a file picker, which quietly
 * assumed the sound already existed somewhere. For a soundtrack that is true; for
 * narration over a photograph it is exactly backwards — the reader is at the
 * machine that has the microphone, and the file they would be browsing for is the
 * one they have not made yet.
 *
 * So the picker became a room with two doors, and both lead to the same place:
 * a piece of sound, sitting in front of the reader, that can have the room taken
 * out of it and the pauses taken out of it before it is used. The project's
 * default soundtrack goes through here too — a downloaded track opening with two
 * seconds of nothing is the same problem as a recording that does.
 *
 * A recording is written to disk as soon as it is finished, without being asked
 * for. Sound captured in a browser tab exists in exactly one place, and that
 * place is gone the moment the tab is; a reader who has just narrated four
 * minutes should not be able to lose them by clicking Cancel.
 */
@Component({
  selector: 'app-audio-source-dialog',
  standalone: true,
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, BodyPortalDirective],
  templateUrl: './audio-source-dialog.component.html',
  styleUrls: ['./audio-source-dialog.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AudioSourceDialogComponent implements OnDestroy {
  /** What this sound is for, said in the title bar. */
  @Input() heading = 'Choose a sound';
  /** One line under the title. Empty hides it. */
  @Input() subheading = '';
  /** Stem for a recording's file name, so a download is recognisable later. */
  @Input() suggestedName = 'narration';

  @Output() readonly chosen = new EventEmitter<File>();

  /**
   * The durable reference to the file behind the sound, when there is one.
   *
   * Emitted only for a sound used exactly as it was found. A cleaned-up
   * recording is a *different* file from the one on disk, and a handle pointing
   * at the original would reopen the raw take — the noise back in, the pauses
   * back in — which is worse than asking for the file again.
   */
  @Output() readonly chosenSource = new EventEmitter<StoredHandle>();
  @Output() readonly cancelled = new EventEmitter<void>();

  /** The reference to the file the reader picked, when the browser gave one. */
  private sourceHandle: StoredHandle | null = null;

  readonly accepted = ACCEPTED_AUDIO;
  readonly presets = SILENCE_PRESETS;
  readonly canRecord = NarrationRecorder.supported;

  stage: Stage = 'choose';

  /** What is being recorded right now. */
  elapsed = 0;
  level = 0;
  paused = false;

  /** The sound under review: what came in, and what came out of the cleanup. */
  sourceBlob: Blob | null = null;
  sourceName = '';
  /** True when the reader recorded it rather than picking it. */
  recorded = false;
  report: CleanupReport | null = null;
  previewUrl: string | null = null;
  downloaded = false;

  /**
   * Noise removal and silence cutting both start on for a recording and off for
   * a file. A voice captured at a desk almost always wants both; a piece of
   * music the reader chose almost never wants either, and quietly rewriting it
   * would be the tool taking a decision that was not asked of it.
   */
  settings: CleanupSettings = { removeNoise: true, cutSilence: true, preset: 'aggressive' };

  working = false;
  workRatio = 0;
  errorMessage = '';
  errorHint = '';

  private recorder: NarrationRecorder | null = null;
  private starting = false;
  private destroyed = false;

  constructor(
    private readonly cdr: ChangeDetectorRef,
    private readonly zone: NgZone,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {}

  ngOnDestroy(): void {
    this.destroyed = true;
    this.recorder?.cancel();
    this.revokePreview();
  }

  /**
   * Redraws this dialog, and only this dialog.
   *
   * `detectChanges` rather than `markForCheck` because almost everything here
   * finishes outside Angular's zone — the recorder's meter, the cleanup's
   * progress, the promise that resolves when the recorder has handed over its
   * last chunk. Marking a view dirty outside the zone schedules nothing, so the
   * result is a dialog that has finished its work and does not say so.
   *
   * The guard is not defensive programming: the meter ticks twenty times a
   * second, and a view checked after it has been destroyed throws.
   */
  private refresh(): void {
    if (this.destroyed) return;
    this.cdr.detectChanges();
  }

  // --------------------------------------------------------------- choosing --

  /**
   * Opens the picker that remembers, falling back to the plain input.
   *
   * Same two doors as the media buttons: `showOpenFilePicker` hands back a
   * handle with the file, `<input type="file">` hands back bytes and nothing
   * else. A soundtrack chosen through the first can be reopened by a settings
   * file later; one chosen through the second has to be found again by hand.
   */
  async choose(input: HTMLInputElement): Promise<void> {
    const picked = await pickFilesWithHandles(false);
    if (!picked) {
      input.click();
      return;
    }

    const file = picked.files[0];
    if (!file) return;

    this.sourceHandle = picked.handles.get(`${file.name}:${file.size}`) ?? null;
    this.take(file);
  }

  /** Takes the file the hidden input collected and moves straight to review. */
  async onFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    this.sourceHandle = null;
    this.take(file);
  }

  /** Everything both doors do once a file is in hand. */
  private take(file: File): void {
    this.sourceBlob = file;
    this.sourceName = file.name;
    this.recorded = false;
    this.settings = { removeNoise: false, cutSilence: false, preset: 'aggressive' };
    this.report = null;
    this.downloaded = false;
    this.showPreview(file);
    this.stage = 'review';
    this.refresh();
  }

  // -------------------------------------------------------------- recording --

  async startRecording(): Promise<void> {
    // The permission prompt can sit open for a minute, and the button behind it
    // stays live. A second press would open a second microphone and overwrite
    // the only reference to the first, leaving it running for the life of the
    // tab with nothing able to stop it.
    if (this.starting || this.recorder) return;

    this.starting = true;
    this.clearError();

    const recorder = new NarrationRecorder((tick) => {
      // Deliberately not `zone.run`: this fires twenty times a second, and
      // asking Angular to check the whole page that often to move a meter would
      // cost more than the recording does. Only this component needs redrawing.
      this.elapsed = tick.elapsed;
      this.level = tick.level;
      this.refresh();
    });

    // Held before it is started, not after. `start` blocks on the browser's
    // permission prompt, which can sit there for a minute; a dialog closed in
    // that window would run `ngOnDestroy` against a field still holding null,
    // and the microphone that opened afterwards would never be given back.
    this.recorder = recorder;

    try {
      await this.zone.runOutsideAngular(() => recorder.start());

      // Permission may have been granted long after it was asked for, and the
      // reader may have given up and uploaded a file in the meantime. Taking
      // over the screen then would throw away what they chose.
      if (this.destroyed || this.stage !== 'choose') {
        recorder.cancel();
        this.recorder = null;
        return;
      }

      this.elapsed = 0;
      this.level = 0;
      this.paused = false;
      this.stage = 'recording';
    } catch (error) {
      this.recorder = null;
      this.showError(error);
    } finally {
      this.starting = false;
      this.refresh();
    }
  }

  togglePause(): void {
    if (!this.recorder) return;
    if (this.recorder.paused) this.recorder.resume();
    else this.recorder.pause();
    this.paused = this.recorder.paused;
    this.refresh();
  }

  /** Ends the recording, cleans it up, and puts it on the reader's disk. */
  async stopRecording(): Promise<void> {
    const recorder = this.recorder;
    if (!recorder) return;

    let blob: Blob;
    try {
      blob = await recorder.stop();
    } catch (error) {
      this.showError(error);
      this.refresh();
      return;
    } finally {
      this.recorder = null;
    }

    // Wrapped as a `File` rather than left a `Blob`: `use()` falls back to the
    // source when no cleanup was run, and everything downstream takes a file
    // with a name. A recording handed on as a nameless blob would be dropped.
    this.sourceBlob = new File([blob], `${this.suggestedName}.webm`, { type: blob.type });
    this.sourceName = `${this.suggestedName}.wav`;
    this.recorded = true;
    this.settings = { removeNoise: true, cutSilence: true, preset: 'aggressive' };
    this.downloaded = false;
    this.stage = 'review';
    this.refresh();

    // Straight into the cleanup, which is also what produces the file that gets
    // saved. Nothing is asked first: the reader has just finished talking, and
    // the one thing they want at that moment is for it not to be lost.
    await this.apply(true);
  }

  discardRecording(): void {
    this.recorder?.cancel();
    this.recorder = null;
    this.stage = 'choose';
    this.clearError();
    this.refresh();
  }

  // ----------------------------------------------------------------- review --

  onRemoveNoise(on: boolean): void {
    this.settings = { ...this.settings, removeNoise: on };
    this.forgetResult();
  }

  onCutSilence(on: boolean): void {
    this.settings = { ...this.settings, cutSilence: on };
    this.forgetResult();
  }

  onPreset(id: string): void {
    this.settings = { ...this.settings, preset: id as Exclude<PresetId, 'custom'> };
    this.forgetResult();
  }

  /**
   * Throws away the finished result once the switches no longer describe it.
   *
   * The preview goes back to the untouched sound at the same moment, because
   * the player and the button have to be talking about the same thing: leaving
   * the cleaned-up version audible while "Use this sound" would hand over the
   * original is how someone auditions one file and imports another.
   */
  private forgetResult(): void {
    this.report = null;
    if (this.sourceBlob) this.showPreview(this.sourceBlob);
    this.refresh();
  }

  /** True once the switches have moved away from what the current result used. */
  get needsApply(): boolean {
    return !this.report && (this.settings.removeNoise || this.settings.cutSilence || this.recorded);
  }

  /**
   * Runs the cleanup over the sound and, the first time round for a recording,
   * saves the result.
   */
  async apply(save = false): Promise<void> {
    if (!this.sourceBlob || this.working) return;

    this.working = true;
    this.workRatio = 0;
    this.clearError();
    this.refresh();

    try {
      const report = await this.zone.runOutsideAngular(() =>
        cleanUpAudio(this.sourceBlob as Blob, this.sourceName || this.suggestedName, this.settings, (ratio) => {
          this.workRatio = ratio;
          this.refresh();
        })
      );

      // The save happens whether or not the dialog is still on screen. It is
      // the promise this component makes about a recording — sound captured in
      // a tab exists in one place and dies with it — and a page navigated away
      // from mid-cleanup is exactly the moment that promise matters.
      if (save && !this.downloaded) this.saveToDisk(report.file);

      // The rest is screen state, and there is no screen. Publishing a preview
      // URL that nothing will ever revoke would pin the whole recording in
      // memory until the tab closes.
      if (this.destroyed) return;

      this.report = report;
      this.showPreview(report.file);
    } catch (error) {
      this.showError(error);
    } finally {
      this.working = false;
      this.refresh();
    }
  }

  /** Writes the sound as it currently stands to the reader's downloads. */
  download(): void {
    const file = this.report?.file;
    if (file) this.saveToDisk(file);
  }

  /**
   * Hands one file to the browser's downloader.
   *
   * Separate from {@link download} because it must work with no view left to
   * update: the auto-save after a recording calls it directly, and marking a
   * destroyed component dirty would throw.
   */
  private saveToDisk(file: File): void {
    if (!isPlatformBrowser(this.platformId)) return;

    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Long enough for the browser to have taken the bytes. Revoking immediately
    // races the download and produces an empty file on some of them.
    window.setTimeout(() => URL.revokeObjectURL(url), 20000);
    this.downloaded = true;
    if (!this.destroyed) this.refresh();
  }

  /** Hands the finished sound back to whoever opened the dialog. */
  use(): void {
    const file = this.report?.file ?? (this.sourceBlob instanceof File ? this.sourceBlob : null);
    if (!file) return;

    // Untouched: the file on disk and the file being handed over are the same
    // bytes, so the reference is still good and this project can reopen itself.
    if (!this.report && this.sourceHandle) this.chosenSource.emit(this.sourceHandle);
    this.chosen.emit(file);
  }

  back(): void {
    this.revokePreview();
    this.sourceBlob = null;
    this.report = null;
    this.sourceHandle = null;
    this.stage = 'choose';
    this.clearError();
    this.refresh();
  }

  close(): void {
    this.recorder?.cancel();
    this.cancelled.emit();
  }

  /** Closing on the backdrop is a click away from losing a recording, so it does not. */
  onBackdrop(): void {
    if (this.stage === 'recording' || this.working) return;
    this.close();
  }

  // ------------------------------------------------------------------ words --

  formatTime(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /** The meter, as a percentage, on a curve that makes speech fill most of it. */
  get levelPercent(): number {
    return Math.min(100, Math.round(Math.sqrt(this.level) * 118));
  }

  /** What the chosen preset actually does, for the select's tooltip. */
  get presetNote(): string {
    return this.presets.find((preset) => preset.id === this.settings.preset)?.description ?? '';
  }

  get workPercent(): number {
    return Math.round(this.workRatio * 100);
  }

  /** What the cleanup did, in one line, or empty when it did nothing worth saying. */
  get resultNote(): string {
    const report = this.report;
    if (!report) return '';

    const parts: string[] = [];
    if (report.noiseRemoved) parts.push('background removed');
    if (report.removedDuration > 0.05) {
      parts.push(`${this.formatTime(report.removedDuration)} of pauses cut`);
    }

    const summary = parts.length ? ` — ${parts.join(', ')}` : '';
    return `${this.formatTime(report.duration)}${summary}`;
  }

  get downloadName(): string {
    return this.report?.file.name ?? cleanName(this.suggestedName);
  }

  // ---------------------------------------------------------------- private --

  private showPreview(file: Blob): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.revokePreview();
    this.previewUrl = URL.createObjectURL(file);
  }

  private revokePreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
  }

  private clearError(): void {
    this.errorMessage = '';
    this.errorHint = '';
  }

  private showError(error: unknown): void {
    if (error instanceof AudioCleanupError || error instanceof RecorderError) {
      this.errorMessage = error.message;
      this.errorHint = error.hint;
      return;
    }

    this.errorMessage = 'That did not work.';
    this.errorHint = error instanceof Error ? error.message : '';
  }
}

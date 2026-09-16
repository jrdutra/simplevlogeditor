import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { AutoZoomControlComponent } from '../../shared/media/auto-zoom-control.component';
import { HelpHintComponent } from './help-hint.component';
import { AutoZoomSettings } from '../../shared/media/auto-zoom';
import { SETTING_LIMITS, SILENCE_PRESETS, clampSettings, presetFor } from '../cortador-de-silencio/silence-cutter-presets';
import { SilenceSettings } from '../cortador-de-silencio/silence-cutter.models';
import {
  FADE_SECONDS,
  SPEEDS,
  VOLUME_LIMITS,
  clampSpeed,
  clampVolume,
  cloneEdits,
  speedLabel
} from './video-editor-defaults';
import { ClipAudioMode, ClipEdits } from './video-editor.models';
import type { NoiseReport } from '../supressao-de-ruido/noise-analysis';
import type { SuppressionProgress } from '../supressao-de-ruido/noise-suppression.models';
import type { ClipNoiseSettings } from './clip-noise';

/**
 * Every setting a clip can have, in one panel.
 *
 * There is exactly one of these in the code and two on screen: the project's
 * copy at the top of the page and the clip's copy inside its dialog. That is
 * deliberate — a global setting and its per-clip override must offer the same
 * choices with the same wording, and the only way to guarantee it is for them
 * to be the same component.
 *
 * It owns nothing. Each change emits a whole new {@link ClipEdits}, already
 * cloned and clamped, so the host can store it without wondering whether the
 * object it is holding is shared with anything else.
 */
@Component({
  selector: 'app-clip-edits-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule, AutoZoomControlComponent, HelpHintComponent],
  templateUrl: './clip-edits-panel.component.html',
  styleUrl: './clip-edits-panel.component.css'
})
export class ClipEditsPanelComponent {
  @Input({ required: true }) edits!: ClipEdits;
  @Input() disabled = false;
  /** Prefix for the field ids, so two panels on one page stay distinct. */
  @Input() id = 'edits';
  /** Hidden for a text card, which has no source to cut. */
  @Input() showCuts = true;
  /** Takes the sound control away entirely, for a caller that has no use for it. */
  @Input() showAudio = true;
  /**
   * False for a text card, which never had a soundtrack to keep.
   *
   * It changes the wording and nothing else. The four choices are the same — a
   * title is still a place a file can be laid under, and still a place a track
   * already running should be able to play through — but "keep the clip's own
   * sound" would be offering something that does not exist.
   */
  @Input() hasOwnSound = true;
  /** One line under the automatic zoom checkbox, usually what it would do. */
  @Input() zoomNote = '';
  /**
   * One line under the speed control: how long the clip ends up lasting.
   *
   * The panel cannot work this out for itself — it is handed a `ClipEdits` and
   * nothing else, and the answer depends on what was cut, where the clip starts
   * and stops, and which clip this even is. So the host, which knows all three,
   * says it in words and this only finds a place to put it.
   */
  @Input() speedNote = '';
  /**
   * True while something other than the reader is deciding this clip's speed.
   *
   * Today that is the timelapse target and nothing else. The panel does not
   * need to know what set it — only that the menu would be lying, and that
   * {@link speedLockedLabel} is what to show instead.
   */
  @Input() speedLocked = false;
  /** The speed as words, when it is locked: the value, and where it came from. */
  @Input() speedLockedLabel = '';
  /** Present only for a media container. Project settings deliberately pass null. */
  @Input() noiseSettings: ClipNoiseSettings | null = null;
  @Input() noiseReport: NoiseReport | null = null;
  @Input() noiseWorking = false;
  @Input() noiseProgress: SuppressionProgress | null = null;
  @Input() noiseReady = false;

  @Output() readonly editsChange = new EventEmitter<ClipEdits>();
  /** The reader asking for the speed control back. */
  @Output() readonly speedRelease = new EventEmitter<void>();
  @Output() readonly noiseEnabledChange = new EventEmitter<boolean>();
  @Output() readonly noiseConfigure = new EventEmitter<void>();
  @Output() readonly noiseProcess = new EventEmitter<void>();

  cutsOpen = false;

  readonly speeds = SPEEDS;
  readonly fadeLimits = FADE_SECONDS;
  readonly volumeLimits = VOLUME_LIMITS;
  readonly limits = SETTING_LIMITS;
  readonly presets = SILENCE_PRESETS;
  readonly speedLabel = speedLabel;

  get noiseStatusClass(): string {
    const status = this.noiseReport?.status;
    return status === 'Relevant noise' ? 'ruido-alto' : status === 'Probable noise' ? 'ruido-medio' : 'ruido-baixo';
  }

  get noiseStatus(): string { return this.noiseReport?.status ?? ''; }
  get noiseBackgroundDb(): number | null { return this.noiseReport?.backgroundDb ?? null; }

  get preset(): string {
    return presetFor(this.edits.silence);
  }

  patch(change: Partial<ClipEdits>): void {
    this.editsChange.emit(cloneEdits({ ...this.edits, ...change }));
  }

  onSpeed(value: string | number): void {
    this.patch({ speed: clampSpeed(Number(value)) });
  }

  onAudioMode(mode: ClipAudioMode): void {
    this.patch({ audioMode: mode });
  }

  onVolume(value: string | number): void {
    this.patch({ volumePercent: clampVolume(Number(value)) });
  }

  onFadeSeconds(value: string): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.patch({ fadeSeconds: Math.min(FADE_SECONDS.max, Math.max(FADE_SECONDS.min, parsed)) });
  }

  /** Applies a silence change, clamped, leaving the render-only fields alone. */
  onSilence(change: Partial<SilenceSettings>): void {
    this.patch({ silence: clampSettings({ ...this.edits.silence, ...change }) });
  }

  onSilenceNumber(key: keyof SilenceSettings, value: string | number): void {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    this.onSilence({ [key]: parsed } as Partial<SilenceSettings>);
  }

  /**
   * A preset describes how eagerly to detect and nothing else, so the two
   * render-only settings survive it — a reader who set a crossfade or turned on
   * the automatic zoom did not mean to undo it by trying another preset.
   */
  applyPreset(id: string): void {
    const preset = this.presets.find((candidate) => candidate.id === id);
    if (!preset) return;

    this.onSilence({
      ...preset.settings,
      crossfadeMs: this.edits.silence.crossfadeMs,
      autoZoom: this.edits.silence.autoZoom
    });
  }

  onAutoZoom(autoZoom: AutoZoomSettings): void {
    this.onSilence({ autoZoom });
  }
}

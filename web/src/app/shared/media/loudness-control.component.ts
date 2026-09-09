import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import { LOUDNESS_LIMITS, LoudnessMode, LoudnessSettings, clampLoudness } from './loudness';

/**
 * The "Even out the volume" checkbox, with its settings behind a gear.
 *
 * Built like the automatic zoom control and for the same reason: the feature is
 * one checkbox most of the time, and the handful of numbers behind it matter
 * only to the reader who has already decided the default was not quite right.
 */
@Component({
  selector: 'app-loudness-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="nivel-controle">
      <div class="nivel-linha">
        <label class="nivel-check">
          <input
            type="checkbox"
            [checked]="settings.enabled"
            [disabled]="disabled"
            (change)="patch({ enabled: $any($event.target).checked })"
            aria-label="Even out the volume across the whole project">
          <span>Even out the volume across the project</span>
        </label>

        <button
          type="button"
          class="nivel-engrenagem"
          [class.aberto]="open"
          [disabled]="disabled"
          [attr.aria-expanded]="open"
          aria-label="Volume levelling settings"
          title="Volume levelling settings"
          (click)="open = !open">
          <mat-icon>tune</mat-icon>
        </button>
      </div>

      @if (note) {
        <p class="nivel-nota">{{ note }}</p>
      }

      @if (open) {
        <div class="nivel-painel">
          <div class="nivel-campo nivel-largo">
            <label [attr.for]="id + '-mode'">What to correct</label>
            <select
              [id]="id + '-mode'"
              [disabled]="disabled || !settings.enabled"
              [ngModel]="settings.mode"
              (ngModelChange)="patch({ mode: $event })">
              <option value="match">Only the difference between clips</option>
              <option value="level">Also the drift inside each clip</option>
            </select>
            <small>
              {{ settings.mode === 'match'
                ? 'One correction per clip, so clips recorded at different levels agree. Whatever happens inside a clip is left exactly as it was.'
                : 'A slow curve that follows the speaker as well, lifting the sentences they trailed off on and holding back the ones they leaned into.' }}
            </small>
          </div>

          <div class="nivel-campo">
            <label [attr.for]="id + '-target'">Bring speech to</label>
            <div class="nivel-entrada">
              <input
                [id]="id + '-target'"
                type="number"
                [min]="limits.targetDb.min"
                [max]="limits.targetDb.max"
                [step]="limits.targetDb.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.targetDb"
                (ngModelChange)="patch({ targetDb: +$event })">
              <span class="unidade">dBFS</span>
            </div>
            <small>Around −20 is comfortable for speech and leaves room for anything louder.</small>
          </div>

          <div class="nivel-campo">
            <label [attr.for]="id + '-boost'">Lift by at most</label>
            <div class="nivel-entrada">
              <input
                [id]="id + '-boost'"
                type="number"
                [min]="limits.maxBoostDb.min"
                [max]="limits.maxBoostDb.max"
                [step]="limits.maxBoostDb.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.maxBoostDb"
                (ngModelChange)="patch({ maxBoostDb: +$event })">
              <span class="unidade">dB</span>
              <span class="e">cut by</span>
              <input
                type="number"
                aria-label="Largest reduction"
                [min]="limits.maxCutDb.min"
                [max]="limits.maxCutDb.max"
                [step]="limits.maxCutDb.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.maxCutDb"
                (ngModelChange)="patch({ maxCutDb: +$event })">
              <span class="unidade">dB</span>
            </div>
            <small>A ceiling on the correction, so a badly recorded clip is improved rather than turned into hiss.</small>
          </div>

          @if (settings.mode === 'level') {
            <div class="nivel-campo">
              <label [attr.for]="id + '-smoothing'">Gain may move over</label>
              <div class="nivel-entrada">
                <input
                  [id]="id + '-smoothing'"
                  type="number"
                  [min]="limits.smoothingSeconds.min"
                  [max]="limits.smoothingSeconds.max"
                  [step]="limits.smoothingSeconds.step"
                  [disabled]="disabled || !settings.enabled"
                  [ngModel]="settings.smoothingSeconds"
                  (ngModelChange)="patch({ smoothingSeconds: +$event })">
                <span class="unidade">s</span>
              </div>
              <small>Slower is safer: a gain that reacts within a syllable is audible as pumping.</small>
            </div>
          }

          <div class="nivel-campo">
            <label [attr.for]="id + '-floor'">Treat as room tone below</label>
            <div class="nivel-entrada">
              <input
                [id]="id + '-floor'"
                type="number"
                [min]="limits.noiseFloorDb.min"
                [max]="limits.noiseFloorDb.max"
                [step]="limits.noiseFloorDb.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.noiseFloorDb"
                (ngModelChange)="patch({ noiseFloorDb: +$event })">
              <span class="unidade">dBFS</span>
            </div>
            <small>Anything quieter is never lifted. Boosting the hiss between sentences is what makes an edit sound processed.</small>
          </div>

          <div class="nivel-campo nivel-largo">
            <label class="nivel-check">
              <input
                type="checkbox"
                [checked]="settings.limiter"
                [disabled]="disabled || !settings.enabled"
                (change)="patch({ limiter: $any($event.target).checked })">
              <span>Round off anything that would overshoot</span>
            </label>
            <small>Keeps a lifted peak from squaring off into distortion. There is no reason to turn this off.</small>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .nivel-controle { display: block; }
      .nivel-linha { display: flex; align-items: center; gap: 8px; }

      .nivel-check {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        color: var(--text-main);
        font-size: 0.92rem;
      }

      .nivel-check input { accent-color: var(--aqua); cursor: pointer; }
      .nivel-check input:disabled { cursor: default; }

      .nivel-engrenagem {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        transition: color 0.15s ease, border-color 0.15s ease;
      }

      .nivel-engrenagem:hover:not(:disabled),
      .nivel-engrenagem.aberto { color: var(--aqua); border-color: var(--aqua); }
      .nivel-engrenagem:disabled { opacity: 0.45; cursor: default; }
      .nivel-engrenagem mat-icon { font-size: 18px; width: 18px; height: 18px; }

      .nivel-nota { margin: 4px 0 0 26px; color: var(--text-muted); font-size: 0.78rem; }

      .nivel-painel {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 10px;
        padding: 14px;
        border: 1px solid var(--line-soft);
        border-radius: 10px;
        background: var(--panel-dark);
      }

      .nivel-campo { display: flex; flex-direction: column; gap: 6px; }
      .nivel-largo { grid-column: 1 / -1; }
      .nivel-campo > label { color: var(--text-main); font-size: 0.82rem; font-weight: 600; }
      .nivel-campo small { color: var(--text-muted); font-size: 0.74rem; line-height: 1.4; }

      .nivel-entrada { display: flex; align-items: center; gap: 6px; }
      .nivel-entrada .unidade,
      .nivel-entrada .e { color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; }

      .nivel-campo input[type='number'],
      .nivel-campo select {
        width: 100%;
        min-width: 0;
        padding: 7px 9px;
        border: 1px solid var(--line-soft);
        border-radius: 8px;
        background: rgba(3, 14, 30, 0.6);
        color: var(--text-main);
        font: inherit;
        font-size: 0.85rem;
      }

      .nivel-campo input:disabled,
      .nivel-campo select:disabled { opacity: 0.5; }
      .nivel-campo input:focus, .nivel-campo select:focus { outline: 1px solid var(--aqua); }
    `
  ]
})
export class LoudnessControlComponent {
  @Input({ required: true }) settings!: LoudnessSettings;
  @Input() disabled = false;
  @Input() note = '';
  @Input() id = 'loudness';

  @Output() readonly settingsChange = new EventEmitter<LoudnessSettings>();

  open = false;

  readonly limits = LOUDNESS_LIMITS;

  patch(change: Partial<LoudnessSettings> & { mode?: LoudnessMode }): void {
    this.settingsChange.emit(clampLoudness({ ...this.settings, ...change }));
  }
}

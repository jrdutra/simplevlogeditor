import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

import {
  AUTO_ZOOM_LIMITS,
  AutoZoomSettings,
  ZoomScaleMode,
  ZoomTriggerMode,
  clampAutoZoom
} from './auto-zoom';

/**
 * The "Automatic zoom" checkbox, with its settings behind a gear.
 *
 * Two tools offer this and they must offer exactly the same thing, so the
 * control is one component rather than one panel copied twice. It owns no
 * state: everything is read from `settings` and every change is emitted
 * already clamped, which is what lets a caller store the value straight away
 * without repeating the validation.
 */
@Component({
  selector: 'app-auto-zoom-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, MatIconModule],
  template: `
    <div class="zoom-controle">
      <div class="zoom-linha">
        <label class="zoom-check">
          <input
            type="checkbox"
            [checked]="settings.enabled"
            [disabled]="disabled"
            (change)="patch({ enabled: $any($event.target).checked })"
            aria-label="Zoom in automatically after the longest pauses">
          <span>Automatic zoom after long pauses</span>
        </label>

        <button
          type="button"
          class="zoom-engrenagem"
          [class.aberto]="open"
          [disabled]="disabled"
          [attr.aria-expanded]="open"
          aria-label="Automatic zoom settings"
          title="Automatic zoom settings"
          (click)="open = !open">
          <mat-icon>tune</mat-icon>
        </button>
      </div>

      @if (note) {
        <p class="zoom-nota">{{ note }}</p>
      }

      @if (open) {
        <div class="zoom-painel">
          <div class="zoom-campo zoom-largo">
            <label [attr.for]="id + '-modo'">Zoom when</label>
            <select
              [id]="id + '-modo'"
              [disabled]="disabled || !settings.enabled"
              [ngModel]="settings.triggerMode"
              (ngModelChange)="patch({ triggerMode: $event })">
              <option value="above-average">A pause is much longer than the others</option>
              <option value="every-cuts">Every so many cuts</option>
              <option value="both">Either of the two</option>
            </select>
            <small>
              The first rule follows the speaking: it moves where the speaker actually stopped. The second follows the
              count, which keeps a densely cut stretch — where every pause is much the same length — from running for
              minutes on one framing.
            </small>
          </div>

          @if (settings.triggerMode !== 'above-average') {
            <div class="zoom-campo">
              <label [attr.for]="id + '-every'">Zoom after every</label>
              <div class="zoom-entrada">
                <input
                  [id]="id + '-every'"
                  type="number"
                  [min]="limits.everyCuts.min"
                  [max]="limits.everyCuts.max"
                  [step]="limits.everyCuts.step"
                  [disabled]="disabled || !settings.enabled"
                  [ngModel]="settings.everyCuts"
                  (ngModelChange)="patch({ everyCuts: +$event })">
                <span class="unidade">cuts, by</span>
                <input
                  type="number"
                  aria-label="Zoom used by the interval rule"
                  [min]="limits.intervalZoomPercent.min"
                  [max]="limits.intervalZoomPercent.max"
                  [step]="limits.intervalZoomPercent.step"
                  [disabled]="disabled || !settings.enabled"
                  [ngModel]="settings.intervalZoomPercent"
                  (ngModelChange)="patch({ intervalZoomPercent: +$event })">
                <span class="unidade">%</span>
              </div>
              <small>A fixed amount, so a regular device reads as deliberate rather than as an accident.</small>
            </div>
          }

          @if (settings.triggerMode !== 'every-cuts') {
          <div class="zoom-campo">
            <label [attr.for]="id + '-trigger'">Pause must be longer than average by</label>
            <div class="zoom-entrada">
              <input
                [id]="id + '-trigger'"
                type="number"
                [min]="limits.triggerPercent.min"
                [max]="limits.triggerPercent.max"
                [step]="limits.triggerPercent.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.triggerPercent"
                (ngModelChange)="patch({ triggerPercent: +$event })">
              <span class="unidade">%</span>
            </div>
            <small>Only pauses this much above the average removed pause earn a zoom.</small>
          </div>
          }

          @if (settings.triggerMode !== 'every-cuts') {
          <div class="zoom-campo">
            <label [attr.for]="id + '-min'">Zoom between</label>
            <div class="zoom-entrada">
              <input
                [id]="id + '-min'"
                type="number"
                [min]="limits.minZoomPercent.min"
                [max]="limits.minZoomPercent.max"
                [step]="limits.minZoomPercent.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.minZoomPercent"
                (ngModelChange)="patch({ minZoomPercent: +$event })">
              <span class="unidade">%</span>
              <span class="e">and</span>
              <input
                type="number"
                aria-label="Largest zoom"
                [min]="limits.maxZoomPercent.min"
                [max]="limits.maxZoomPercent.max"
                [step]="limits.maxZoomPercent.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.maxZoomPercent"
                (ngModelChange)="patch({ maxZoomPercent: +$event })">
              <span class="unidade">%</span>
            </div>
            <small>How far the picture pushes in. The edges are cropped, never stretched.</small>
          </div>

          <div class="zoom-campo">
            <label [attr.for]="id + '-mode'">Amount chosen</label>
            <select
              [id]="id + '-mode'"
              [disabled]="disabled || !settings.enabled"
              [ngModel]="settings.scaleMode"
              (ngModelChange)="patch({ scaleMode: $event })">
              <option value="random">At random inside the range</option>
              <option value="proportional">In proportion to how long the pause was</option>
            </select>
            <small>
              {{ settings.scaleMode === 'random'
                ? 'Varies from cut to cut so the zooms do not look mechanical. The same file always gets the same choices.'
                : 'The longer the pause, the further the picture pushes in.' }}
            </small>
          </div>
          }

          <div class="zoom-campo">
            <label [attr.for]="id + '-ramp'">Push-in takes</label>
            <div class="zoom-entrada">
              <input
                [id]="id + '-ramp'"
                type="number"
                [min]="limits.rampSeconds.min"
                [max]="limits.rampSeconds.max"
                [step]="limits.rampSeconds.step"
                [disabled]="disabled || !settings.enabled"
                [ngModel]="settings.rampSeconds"
                (ngModelChange)="patch({ rampSeconds: +$event })">
              <span class="unidade">s</span>
            </div>
            <small>Zero cuts straight to the closer framing instead of easing into it.</small>
          </div>

          <div class="zoom-campo">
            <label [attr.for]="id + '-hold'">Held for</label>
            <div class="zoom-entrada">
              <input
                [id]="id + '-hold'"
                type="number"
                [min]="limits.holdSeconds.min"
                [max]="limits.holdSeconds.max"
                [step]="limits.holdSeconds.step"
                [disabled]="disabled || !settings.enabled || settings.holdToEnd"
                [ngModel]="settings.holdSeconds"
                (ngModelChange)="patch({ holdSeconds: +$event })">
              <span class="unidade">s</span>
            </div>
            <small>Zero holds the zoom until the next cut instead of pulling back out.</small>
          </div>

          <!-- Two different edits, not two ways of writing one. Pulling back
               returns every take to the same framing, which is what makes the
               next push-in read as a move; holding is how a lot of talking-head
               editing actually works — each cut lands a little closer and stays
               there — and no combination of the fields above produces it. -->
          <div class="zoom-campo zoom-largo">
            <label class="zoom-check">
              <input
                type="checkbox"
                [disabled]="disabled || !settings.enabled"
                [checked]="settings.holdToEnd"
                (change)="patch({ holdToEnd: $any($event.target).checked })">
              <span>Keep the zoom instead of pulling back out</span>
            </label>
            <small>
              {{ settings.holdToEnd
                ? 'The push-in stays to the last frame of the take. The cut into the next one does the returning.'
                : 'The picture eases back out to the original framing before the take ends.' }}
            </small>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .zoom-controle { display: block; }

      .zoom-linha { display: flex; align-items: center; gap: 8px; }

      .zoom-check {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        color: var(--text-main);
        font-size: 0.92rem;
      }

      .zoom-check input { accent-color: var(--aqua); cursor: pointer; }
      .zoom-check input:disabled { cursor: default; }

      .zoom-engrenagem {
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

      .zoom-engrenagem:hover:not(:disabled),
      .zoom-engrenagem.aberto { color: var(--aqua); border-color: var(--aqua); }
      .zoom-engrenagem:disabled { opacity: 0.45; cursor: default; }
      .zoom-engrenagem mat-icon { font-size: 18px; width: 18px; height: 18px; }

      .zoom-nota { margin: 4px 0 0 26px; color: var(--text-muted); font-size: 0.78rem; }

      .zoom-painel {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
        margin-top: 10px;
        padding: 14px;
        border: 1px solid var(--line-soft);
        border-radius: 10px;
        background: var(--panel-dark);
      }

      .zoom-campo { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
      /* No global reset on this site: without border-box the padding is added
         to the width and the field hangs off the edge of its column. */
      .zoom-campo input,
      .zoom-campo select { box-sizing: border-box; min-width: 0; max-width: 100%; }
      .zoom-largo { grid-column: 1 / -1; }
      .zoom-campo label { color: var(--text-main); font-size: 0.82rem; font-weight: 600; }
      .zoom-campo small { color: var(--text-muted); font-size: 0.74rem; line-height: 1.4; }

      .zoom-check {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        color: var(--text-main);
        font-size: 0.9rem;
      }

      .zoom-check input { accent-color: var(--aqua); cursor: pointer; }
      .zoom-check input:disabled { cursor: default; }

      .zoom-entrada { display: flex; align-items: center; gap: 6px; }
      .zoom-entrada .unidade,
      .zoom-entrada .e { color: var(--text-muted); font-size: 0.78rem; }

      .zoom-campo input,
      .zoom-campo select {
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

      .zoom-campo input:disabled,
      .zoom-campo select:disabled { opacity: 0.5; }
      .zoom-campo input:focus, .zoom-campo select:focus { outline: 1px solid var(--aqua); }
    `
  ]
})
export class AutoZoomControlComponent {
  @Input({ required: true }) settings!: AutoZoomSettings;
  @Input() disabled = false;
  /** One line under the checkbox, usually what the current plan would do. */
  @Input() note = '';
  /** Prefix for the field ids, so two of these on one page stay distinct. */
  @Input() id = 'auto-zoom';

  @Output() readonly settingsChange = new EventEmitter<AutoZoomSettings>();

  open = false;

  readonly limits = AUTO_ZOOM_LIMITS;

  /** Emits the whole object, already clamped: callers only ever store valid settings. */
  patch(change: Partial<AutoZoomSettings> & { scaleMode?: ZoomScaleMode; triggerMode?: ZoomTriggerMode }): void {
    this.settingsChange.emit(clampAutoZoom({ ...this.settings, ...change }));
  }
}

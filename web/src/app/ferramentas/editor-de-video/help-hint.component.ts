import { ChangeDetectionStrategy, Component, ElementRef, HostListener, Input, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

let nextId = 0;

/**
 * A small round "?" beside a control, holding the paragraph that explains it.
 *
 * The explanations were printed under every field, and a panel of eight fields
 * was three screens of prose with the controls scattered through it. They are
 * worth keeping — each one answers a real question — so they moved behind a
 * button rather than being cut: nothing is lost, and the panel is a panel
 * again.
 *
 * Click rather than hover, because a hover tooltip cannot be read on a phone
 * and cannot be kept open while you look at the control it describes.
 */
@Component({
  selector: 'app-help-hint',
  standalone: true,
  imports: [MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="ajuda-botao"
      [class.is-open]="open"
      [attr.aria-expanded]="open"
      [attr.aria-controls]="open ? panelId : null"
      [attr.aria-label]="label"
      (click)="toggle($event)">?</button>

    @if (open) {
      <span class="ajuda-balao" role="tooltip" [id]="panelId">
        <ng-content></ng-content>
      </span>
    }
  `,
  styles: [`
    :host {
      position: relative;
      display: inline-flex;
      vertical-align: middle;
      /* Upright inside a legend that is uppercase and letter-spaced. */
      text-transform: none;
      letter-spacing: normal;
    }

    .ajuda-botao {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      padding: 0;
      border: 1px solid var(--line-soft);
      border-radius: 50%;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 0.68rem;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
    }

    .ajuda-botao:hover,
    .ajuda-botao:focus-visible,
    .ajuda-botao.is-open {
      color: var(--aqua);
      border-color: var(--aqua);
      background: rgba(142, 232, 255, 0.08);
    }

    .ajuda-balao {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 30;
      display: block;
      width: max-content;
      max-width: min(46ch, 78vw);
      padding: 10px 12px;
      border: 1px solid var(--line-soft);
      border-radius: 10px;
      background: var(--panel-dark);
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 400;
      line-height: 1.55;
      text-align: left;
      white-space: normal;
    }

    /* Near the right edge the balloon would run off the panel, so it hangs from
       the other corner instead. */
    :host(.ajuda-fim) .ajuda-balao {
      left: auto;
      right: 0;
    }

    .ajuda-balao strong { color: var(--text-main); }
  `]
})
export class HelpHintComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  /** What the button announces to a screen reader. */
  @Input() label = 'What is this?';

  open = false;
  readonly panelId = `ajuda-${nextId++}`;

  toggle(event: MouseEvent): void {
    // Stopped here so opening the hint inside a row does not also count as a
    // click on the row, which selects a clip or opens a dialog.
    event.stopPropagation();
    this.open = !this.open;
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open) return;
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) return;
    this.open = false;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open = false;
  }
}

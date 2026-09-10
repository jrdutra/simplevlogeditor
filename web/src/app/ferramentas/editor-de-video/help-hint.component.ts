import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, Input, OnDestroy, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';

import { BodyPortalDirective } from '../../shared/ui/body-portal.directive';

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
  imports: [MatIconModule, BodyPortalDirective],
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
      <span
        #balao
        appBodyPortal
        class="ajuda-balao"
        role="tooltip"
        [id]="panelId"
        [style.top.px]="top"
        [style.bottom.px]="bottom"
        [style.left.px]="left"
        [style.right.px]="right">
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

    /*
     * The balloon is placed against the window, not against the field.
     *
     * It used to hang off the button by absolute positioning, which meant every
     * ancestor got a say in whether it could be seen: a dialog clips its body
     * to scroll it, a card hides its own overflow to round its corners, and a
     * paragraph of explanation was cut off mid-sentence by a border eight
     * pixels to its right. Fixed coordinates — worked out from where the button
     * actually is, and kept inside the window — answer to nothing above it, and
     * the node is moved to the end of the document body so that not even a
     * stacking context can put something in front of it.
     *
     * The trade is that a balloon does not follow its button on its own, which
     * is what the scroll and resize listeners below are for.
     */
    .ajuda-balao {
      position: fixed;
      /* Above every dialog in this tool, which sit at 4000. */
      z-index: 5000;
      display: block;
      width: max-content;
      max-width: min(46ch, calc(100vw - 24px));
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

    .ajuda-balao strong { color: var(--text-main); }
  `]
})
export class HelpHintComponent implements OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly cdr = inject(ChangeDetectorRef);

  /** What the button announces to a screen reader. */
  @Input() label = 'What is this?';

  open = false;
  readonly panelId = `ajuda-${nextId++}`;

  /* Where the balloon sits, in window coordinates. Exactly one of each pair is
     a number and the other is null, so the balloon is anchored by the edge it
     has room on. */
  top: number | null = null;
  bottom: number | null = null;
  left: number | null = null;
  right: number | null = null;

  /** Capture-phase, so a panel scrolling under the balloon is heard too. */
  private readonly follow = () => {
    if (!this.open) return;
    this.place();
    this.cdr.markForCheck();
  };

  ngOnDestroy(): void {
    this.unwatch();
  }

  toggle(event: MouseEvent): void {
    // Stopped here so opening the hint inside a row does not also count as a
    // click on the row, which selects a clip or opens a dialog.
    event.stopPropagation();
    if (this.open) this.close();
    else this.show();
  }

  private show(): void {
    this.place();
    this.open = true;
    if (typeof window === 'undefined') return;
    // `true` is the point: scroll does not bubble, so a balloon opened inside a
    // dialog's scrolling body would never hear the body scroll.
    document.addEventListener('scroll', this.follow, true);
    window.addEventListener('resize', this.follow);
  }

  private close(): void {
    this.open = false;
    this.unwatch();
  }

  private unwatch(): void {
    if (typeof window === 'undefined') return;
    document.removeEventListener('scroll', this.follow, true);
    window.removeEventListener('resize', this.follow);
  }

  /**
   * Works out which corner of the button the balloon hangs from.
   *
   * Its size is not known until it has been drawn, so the decision is made on
   * the room around the button rather than on the paragraph inside: below the
   * button unless the button is in the lower part of the window, and from the
   * left unless there is more room on the right. That is enough for every place
   * this appears, and it is stable — a balloon that measured itself and then
   * moved would flicker on the frame it opened.
   */
  private place(): void {
    if (typeof window === 'undefined') return;

    const rect = (this.host.nativeElement as HTMLElement).getBoundingClientRect();
    const margin = 12;
    const gap = 8;

    if (rect.bottom > window.innerHeight * 0.62) {
      this.top = null;
      this.bottom = Math.max(margin, window.innerHeight - rect.top + gap);
    } else {
      this.bottom = null;
      this.top = Math.min(window.innerHeight - margin, rect.bottom + gap);
    }

    if (window.innerWidth - rect.left < 340) {
      this.left = null;
      this.right = Math.max(margin, window.innerWidth - rect.right);
    } else {
      this.right = null;
      this.left = Math.max(margin, rect.left);
    }
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.open) return;
    const target = event.target;
    if (!(target instanceof Node)) return;
    // The balloon lives at the end of `<body>` now, so "inside the component"
    // is two elements rather than one.
    if (this.host.nativeElement.contains(target)) return;
    if ((target as Element).closest?.(`#${this.panelId}`)) return;
    this.close();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}

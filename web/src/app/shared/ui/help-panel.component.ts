import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  Inject,
  Input,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
  effect
} from '@angular/core';

import { HelpPanel, HelpService } from './help.service';

/**
 * The page's manual, in a dialog.
 *
 * Every tool carries a few hundred words explaining what it does and how to
 * work it, and the home page carries a paragraph or two about each tool. That
 * text is worth having — it is what a search engine reads and what a
 * first-time visitor needs — but printed down the page it makes every screen
 * several screens long and gets scrolled past by everybody who has been here
 * once. Here it lives behind the chrome's Help button and scrolls on its own.
 *
 * The component owns the dialog but not the button: the button is in the
 * chrome, the same one on every page, and finds this panel through
 * `HelpService`.
 *
 * The one thing this must not do is remove the text from the page. It is
 * hidden with an attribute, never with `@if`, so the prerendered HTML a crawler
 * fetches still contains every word whether or not anyone pressed the button.
 *
 * The same shell serves the privacy notice, which is the one panel that is not
 * a page's own: `kind` says which of the two this is, and a privacy panel does
 * not register itself, because registering is how a page says "I have
 * instructions" and this one is not a page.
 */
@Component({
  selector: 'app-help-panel',
  standalone: true,
  template: `
    <div class="help-scrim" [hidden]="!visible()" (click)="help.hide()"></div>

    <div
      class="help-modal"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="label"
      [hidden]="!visible()">
      <header class="help-modal__bar">
        <h2 class="help-modal__title">{{ label }}</h2>
        <button type="button" class="help-modal__close" (click)="help.hide()" aria-label="Close">
          <span aria-hidden="true">&times;</span>
        </button>
      </header>

      <div class="help-modal__body">
        <ng-content></ng-content>
      </div>
    </div>
  `,
  styleUrl: './help-panel.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HelpPanelComponent implements OnInit, OnDestroy {
  /** Names the dialog, in its title bar and to a screen reader. */
  @Input() label = 'How this works';

  /** Which of the two this shell is being used as. */
  @Input() kind: HelpPanel = 'instructions';

  /** Whether this particular panel is the one on screen. */
  readonly visible = computed(() => this.help.showing() === this.kind);

  constructor(
    readonly help: HelpService,
    @Inject(DOCUMENT) private readonly document: Document,
    @Inject(PLATFORM_ID) private readonly platformId: object
  ) {
    effect(() => this.lockPage(this.visible()));
  }

  ngOnInit(): void {
    if (this.kind === 'instructions') this.help.register();
  }

  ngOnDestroy(): void {
    if (this.kind !== 'instructions') return;

    // Closing on the way out matters: navigating with the dialog open would
    // otherwise carry it onto the next page, showing the previous tool's text.
    this.help.hideIf('instructions');
    this.help.unregister();
    this.lockPage(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.visible()) this.help.hide();
  }

  /**
   * Stops the page behind the dialog from scrolling.
   *
   * Without this, a scroll gesture that reaches the end of the dialog's own
   * scroller carries on into the page underneath, so closing the dialog leaves
   * the reader somewhere they never chose to be.
   */
  private lockPage(locked: boolean): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.document.body.style.overflow = locked ? 'hidden' : '';
  }
}

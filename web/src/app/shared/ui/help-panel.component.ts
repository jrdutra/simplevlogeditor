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

import { DesktopService } from '../desktop/desktop.service';
import { DownloadService } from '../desktop/download.service';
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
        <!--
          How to get the thing, before how to use it.
          A reader opening the instructions in a browser tab is often here to
          find out what this is and how to install it, and that answer used to
          be nowhere in the dialog. Inside the desktop application it is absent:
          they already have it.
        -->
        @if (kind === 'instructions' && !desktop.isDesktop) {
          <section class="instalar">
            <h2>Get it on your machine</h2>
            <p>Everything here also runs as a desktop application, which is the same editor with
              access to your folders and to an AI client.</p>

            <ul class="instalar-lista">
              <li>
                <a [href]="download.installerPath" download>
                  <strong>Windows installer</strong>
                  <em>Setup .exe<span>{{ installerSize() }}</span> — run it and follow the prompts.</em>
                </a>
              </li>
              <li>
                <a [href]="download.portablePath" download>
                  <strong>Standalone</strong>
                  <em>Portable .zip — unzip anywhere and run it; nothing is installed.</em>
                </a>
              </li>
            </ul>

            <h3>Let an AI drive it</h3>
            <p>The desktop application exposes the whole editor through a local MCP server, so
              Codex or Claude Code can cut, caption and export for you. The plugins use the editor
              installed by the Windows installer in its default folder (the portable .zip is not
              used by them). Install the desktop application first, keeping the default folder, then
              the plugin for your client.</p>

            <ul class="instalar-lista">
              <li class="instalar-codex">
                <a [href]="download.codexPluginRepository" (click)="download.copyCodexRepository($event)">
                  <span class="instalar-marca"><img src="/assets/icons/codex-mark.svg" alt="" aria-hidden="true"></span>
                  <strong>Codex plugin</strong>
                  <em>Copies the repository address to add as a marketplace in Codex.</em>
                </a>
              </li>
              <li class="instalar-claude">
                <a [href]="download.claudePluginRepository" (click)="download.copyClaudeRepository($event)">
                  <span class="instalar-marca"><img src="/assets/icons/claude-mark.svg" alt="" aria-hidden="true"></span>
                  <strong>Claude Code plugin</strong>
                  <em>Copies the repository address and shows how to install in Claude Code.</em>
                </a>
              </li>

            </ul>

            <p class="instalar-nota">Each plugin carries a doctor script
              (<code>node scripts/doctor.mjs</code>) that checks the installation and says what to
              run for anything missing. Which folders the editor may open is decided in the editor
              itself — your own Videos, Pictures, Music, Downloads, Desktop and Documents to begin
              with, and anything else you allow when it asks.</p>
          </section>
        }

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

  /** " · 119 MB" once the manifest says so, and nothing before then. */
  readonly installerSize = computed(() => {
    const size = this.download.info()?.installer.size;
    return size ? ` · ${size}` : '';
  });

  constructor(
    readonly help: HelpService,
    readonly desktop: DesktopService,
    readonly download: DownloadService,
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

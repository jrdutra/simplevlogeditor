import { Injectable, computed, signal } from '@angular/core';

/** What the Help button can open. */
export type HelpPanel = 'instructions' | 'privacy' | 'about';

/**
 * The link between the Help button and what it opens.
 *
 * The button belongs to the chrome, which is drawn once for the whole site.
 * One of the two things it offers — the instructions — belongs to the page,
 * which changes with the route. Neither can reach the other directly, so they
 * meet here: a page registers its panel on the way in, the menu picks one, and
 * the panel that happens to be registered is the one that opens.
 *
 * Registration is a count rather than a boolean because during a route change
 * the outgoing page is destroyed after the incoming one is created, so for one
 * moment two panels exist. A boolean would be switched off by the departure of
 * the page that has already left.
 *
 * Privacy is the other kind: it says the same thing on every page, so it is
 * mounted once in the chassis and never registers at all.
 */
@Injectable({ providedIn: 'root' })
export class HelpService {
  private readonly panels = signal(0);
  private readonly shown = signal<HelpPanel | null>(null);
  private readonly menu = signal(false);

  /** True while some page on screen has instructions to show. */
  readonly available = computed(() => this.panels() > 0);

  /** Which panel is on screen, if any. */
  readonly showing = computed(() => {
    const panel = this.shown();
    if (panel === 'instructions' && this.panels() === 0) return null;
    return panel;
  });

  /** True while the instructions dialog should be on screen. */
  readonly open = computed(() => this.showing() === 'instructions');

  /** True while the privacy dialog should be on screen. */
  readonly privacyOpen = computed(() => this.showing() === 'privacy');

  /** True while the about dialog should be on screen. */
  readonly aboutOpen = computed(() => this.showing() === 'about');

  /** True while the button's own little menu is open. */
  readonly menuOpen = this.menu.asReadonly();

  register(): void {
    this.panels.update((n) => n + 1);
  }

  unregister(): void {
    this.panels.update((n) => Math.max(0, n - 1));
  }

  /** Opens one panel and closes the menu that asked for it. */
  show(panel: HelpPanel): void {
    this.menu.set(false);
    this.shown.set(panel);
  }

  hide(): void {
    this.shown.set(null);
  }

  /**
   * Closes one panel, and only if it is the one on screen.
   *
   * The instructions panel calls this as it is destroyed, which happens on
   * every navigation — including one made with the privacy dialog open, which
   * is not the leaving page's to close.
   */
  hideIf(panel: HelpPanel): void {
    if (this.shown() === panel) this.shown.set(null);
  }

  toggleMenu(): void {
    this.menu.update((open) => !open);
  }

  closeMenu(): void {
    this.menu.set(false);
  }
}

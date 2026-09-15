import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';

import { DesktopService } from './shared/desktop/desktop.service';
import { DownloadService } from './shared/desktop/download.service';
import { HelpService } from './shared/ui/help.service';
import { AboutPanelComponent } from './shared/ui/about-panel.component';
import { PrivacyPanelComponent } from './shared/ui/privacy-panel.component';
import { SeoService } from './seo.service';
import { WindowControlsComponent } from './shared/desktop/window-controls.component';
import { TOOL_BY_ROUTE, TOOLS } from './tools.data';

/**
 * The chassis.
 *
 * Every page of this site is one module inside the same console, so the frame,
 * the menu and the window lights are drawn once here and the router fills the
 * stage.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, MatIconModule, RouterOutlet, RouterLink, RouterLinkActive, WindowControlsComponent, PrivacyPanelComponent, AboutPanelComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  readonly tools = TOOLS;
  readonly currentYear = new Date().getFullYear();
  readonly selectedToolName = signal('');
  @ViewChild('stage') private stage?: ElementRef<HTMLElement>;

  /** Whether the tools menu is open. */
  readonly menuOpen = signal(false);

  /** Whether the Windows download choices are open. */
  readonly downloadMenuOpen = signal(false);

  constructor(
    readonly help: HelpService,
    readonly desktop: DesktopService,
    readonly download: DownloadService,
    private readonly seo: SeoService,
    private readonly router: Router
  ) {
    this.seo.init();
    this.updateSelectedTool();

    /*
     * A menu that survives the navigation it started is a menu covering the
     * page the reader just asked for. Closing on NavigationEnd also covers the
     * back button and a link followed from inside the page, which a click
     * handler on the item would not.
     */
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => {
        this.menuOpen.set(false);
        this.downloadMenuOpen.set(false);
        this.help.closeMenu();
        this.updateSelectedTool();
        if (this.stage) this.stage.nativeElement.scrollTop = 0;
      });
  }

  private updateSelectedTool(): void {
    const route = this.router.routerState.snapshot.root.firstChild?.routeConfig?.path ?? '';
    this.selectedToolName.set(TOOL_BY_ROUTE.get(route)?.titulo ?? '');
  }

  /* Three menus hang off this bar and only one of them can be open: a panel
     over a panel is a panel nobody asked for. */
  toggleMenu(): void {
    this.downloadMenuOpen.set(false);
    this.help.closeMenu();
    this.menuOpen.update((open) => !open);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  toggleDownloadMenu(): void {
    this.menuOpen.set(false);
    this.help.closeMenu();
    this.downloadMenuOpen.update((open) => !open);
  }

  closeDownloadMenu(): void {
    this.downloadMenuOpen.set(false);
  }

  toggleHelpMenu(): void {
    this.menuOpen.set(false);
    this.downloadMenuOpen.set(false);
    this.help.toggleMenu();
  }

  /** Escape closes it, from wherever the focus happens to be. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.menuOpen()) this.menuOpen.set(false);
    if (this.downloadMenuOpen()) this.downloadMenuOpen.set(false);
    if (this.help.menuOpen()) this.help.closeMenu();
  }
}

import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, ViewChild, effect, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';

import { AGENT_REQUEST_NOT_HANDLED, DesktopService } from './shared/desktop/desktop.service';
import { DownloadService } from './shared/desktop/download.service';
import { HelpService } from './shared/ui/help.service';
import { AboutPanelComponent } from './shared/ui/about-panel.component';
import { PrivacyPanelComponent } from './shared/ui/privacy-panel.component';
import { PluginGuideClient, PluginGuideService } from './shared/ui/plugin-guide.service';
import { SeoService } from './seo.service';
import { WindowControlsComponent } from './shared/desktop/window-controls.component';
import { TOOL_BY_ROUTE, TOOLS } from './tools.data';
import {
  VideoPackagingInput,
  VideoPackagingService,
  VideoUnderstandingInput
} from './ferramentas/video-packaging/video-packaging.service';
import { TagStylePickerComponent } from './ferramentas/video-packaging/tag-style-picker.component';
import { AgentActivityComponent } from './shared/ui/agent-activity.component';
import { AgentActivityService } from './shared/ui/agent-activity.service';
import { EDITOR_AGENT_API_VERSION, EditorAgentRequest } from './ferramentas/editor-de-video/editor-agent-api';
import CURRENT_VERSION from '../currentversion.json';

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
  imports: [CommonModule, MatIconModule, RouterOutlet, RouterLink, RouterLinkActive, WindowControlsComponent, PrivacyPanelComponent, AboutPanelComponent, TagStylePickerComponent, AgentActivityComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent {
  readonly tools = TOOLS;
  readonly currentYear = new Date().getFullYear();
  /** The version this build of the editor is (src/currentversion.json, bumped with every release). */
  readonly appVersion: string = String((CURRENT_VERSION as { desktop?: unknown }).desktop ?? '');
  /** Plugin releases from the same version manifest used by the installers. */
  readonly pluginVersions = {
    codex: String((CURRENT_VERSION as { plugins?: { codex?: unknown } }).plugins?.codex ?? ''),
    claude: String((CURRENT_VERSION as { plugins?: { claude?: unknown } }).plugins?.claude ?? '')
  } as const;
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
    readonly pluginGuide: PluginGuideService,
    private readonly videoPackaging: VideoPackagingService,
    readonly agentActivity: AgentActivityService,
    private readonly seo: SeoService,
    private readonly router: Router
  ) {
    this.seo.init();
    // The picker and the AI control log never share the screen. When the
    // assistant raised the picker, the log comes back once it is answered, so
    // the reader sees the run carry on.
    let pickerForAgent = false;
    effect(() => {
      const open = this.videoPackaging.pickerOpen();
      const forAgent = this.videoPackaging.pickerReason() === 'agent';
      this.agentActivity.suspendForStylePicker(open);
      if (!open && pickerForAgent) this.agentActivity.show();
      pickerForAgent = open && forAgent;
    }, { allowSignalWrites: true });
    this.desktop.registerAgentHandler((request) => this.handleGlobalAgentRequest(request));
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

  private async handleGlobalAgentRequest(request: unknown): Promise<unknown> {
    if (!request || typeof request !== 'object' || !('name' in request)) return AGENT_REQUEST_NOT_HANDLED;
    const command = request as EditorAgentRequest;
    const commandName = String(command.name);
    const handled = [
      'set_video_packaging', 'get_video_packaging', 'clear_video_packaging',
      'set_video_understanding', 'get_video_understanding', 'set_packaging_tag_style',
      'show_tool', 'set_ai_control_log'
    ];
    if (!handled.includes(commandName)) return AGENT_REQUEST_NOT_HANDLED;

    const args = (command.arguments ?? {}) as Record<string, unknown>;
    let result: unknown;
    this.agentActivity.begin();
    this.agentActivity.append('command', commandName.replaceAll('_', ' '), commandName, 'INFO');
    try {
    if (commandName === 'set_video_packaging') {
      result = await this.videoPackaging.apply(args as unknown as VideoPackagingInput);
      this.agentActivity.minimize();
      await this.revealVideoPackaging();
    } else if (commandName === 'clear_video_packaging') {
      this.videoPackaging.clear();
      result = { cleared: true };
      await this.revealVideoPackaging();
    } else if (commandName === 'set_video_understanding') {
      // Kept outside the editor on purpose: what the assistant understood has
      // to survive the reader walking to this tool and back, which the editor
      // page itself does not.
      result = this.videoPackaging.setUnderstanding(args as unknown as VideoUnderstandingInput);
    } else if (commandName === 'get_video_understanding') {
      result = this.videoPackaging.understandingState() ?? { stored: false };
    } else if (commandName === 'set_packaging_tag_style') {
      const state = await this.videoPackaging.setCustomStyleFromPath(String(args['path'] ?? ''));
      result = { source: state.source, id: state.id, name: state.name, path: state.path };
    } else if (commandName === 'show_tool') {
      const route = String(args['tool'] ?? '');
      if (!TOOL_BY_ROUTE.has(route)) throw Object.assign(new Error(`Unknown tool "${route}".`), { code: 'invalid_argument' });
      await this.router.navigateByUrl('/' + route);
      this.desktop.focus();
      result = { tool: route, visible: true };
    } else if (commandName === 'set_ai_control_log') {
      const view = String(args['view'] ?? '') as 'open' | 'minimized' | 'hidden';
      if (!['open', 'minimized', 'hidden'].includes(view)) {
        throw Object.assign(new Error('view must be open, minimized or hidden.'), { code: 'invalid_argument' });
      }
      result = this.agentActivity.setView(view);
    } else {
      result = this.videoPackaging.snapshot();
    }
    this.agentActivity.append('done', `${commandName.replaceAll('_', ' ')} completed`, commandName, 'INFO');
    return { apiVersion: EDITOR_AGENT_API_VERSION, projectRevision: 0, result };
    } catch (error) {
      this.agentActivity.append('fail', error instanceof Error ? error.message : String(error), commandName, 'ERROR');
      throw error;
    } finally {
      this.agentActivity.end();
    }
  }

  /**
   * Brings the package forward wherever the reader happens to be.
   */
  private async revealVideoPackaging(): Promise<void> {
    await this.router.navigateByUrl('/video-packaging');
    this.desktop.focus();
    queueMicrotask(() => {
      this.stage?.nativeElement.focus({ preventScroll: true });
      if (this.stage) this.stage.nativeElement.scrollTop = 0;
    });
  }

  private updateSelectedTool(): void {
    const route = this.router.routerState.snapshot.root.firstChild?.routeConfig?.path ?? '';
    this.selectedToolName.set(TOOL_BY_ROUTE.get(route)?.titulo ?? '');
  }

  setToolVisible(tool: unknown, visible: boolean): void {
    (tool as { onToolVisibilityChanged?: (active: boolean) => void })?.onToolVisibilityChanged?.(visible);
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

  openPluginGuide(client: PluginGuideClient, event?: Event): void {
    event?.preventDefault();
    this.closeDownloadMenu();
    this.pluginGuide.open(client);
  }

  closePluginGuide(): void {
    this.pluginGuide.close();
  }

  async copyPluginRepository(client: PluginGuideClient): Promise<void> {
    const copied = client === 'codex'
      ? await this.download.copyCodexRepository(undefined, false)
      : await this.download.copyClaudeRepository(undefined, false);
    this.pluginGuide.setRepositoryCopied(copied);
  }

  toggleHelpMenu(): void {
    this.menuOpen.set(false);
    this.downloadMenuOpen.set(false);
    this.help.toggleMenu();
  }

  /** Escape closes it, from wherever the focus happens to be. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.pluginGuide.client()) this.closePluginGuide();
    if (this.menuOpen()) this.menuOpen.set(false);
    if (this.downloadMenuOpen()) this.downloadMenuOpen.set(false);
    if (this.help.menuOpen()) this.help.closeMenu();
  }
}

import { isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Inject, Injectable, PLATFORM_ID, signal } from '@angular/core';

import { DesktopService } from './desktop.service';

/** One published file, as `publish-installer.js` described it. */
export interface DownloadFile {
  file: string;
  bytes: number;
  size: string;
}

/** What `publish-installer.js` wrote beside the files it published. */
export interface InstallerInfo {
  version: string;
  builtAt: string;
  installer: DownloadFile;
  /** Absent when the `zip` target was not built. */
  portable?: DownloadFile;
  /** The AI plugins, when their sizes were recorded. Both find the installed editor. */
  plugins?: {
    claude?: DownloadFile;
    codex?: DownloadFile;
  };
}

/** Where the build always puts them. Every link is a plain link to these. */
export const INSTALLER_PATH = '/assets/download/SimpleVlogEditor-Setup.exe';
export const PORTABLE_PATH = '/assets/download/SimpleVlogEditor-Portable.zip';

/**
 * The two AI plugins, offered from the same menu as the application.
 *
 * Each archive is the plugin itself at its root, so it can be handed to the
 * client as a .zip or unzipped first and handed over as a folder — both routes
 * are described in the INSTALL.txt inside it.
 */
export const CLAUDE_PLUGIN_PATH = '/assets/download/simple-vlog-editor-claude.zip';
export const CODEX_PLUGIN_PATH = '/assets/download/simple-vlog-editor-codex.zip';

/** The Codex plugin is installed from its marketplace repository, not from a .zip. */
export const CODEX_PLUGIN_REPOSITORY = 'https://github.com/jrdutra/simplevlogeditor-codex-plugin';
export const CLAUDE_PLUGIN_REPOSITORY = 'https://github.com/jrdutra/simplevlogeditor-claude-plugin';

/**
 * The desktop application, as something the site can offer.
 *
 * The button lives in the chrome, so what it knows has to live somewhere both
 * the chrome and the footer can reach — the offer is one thing said in two
 * places, and it would be wrong for them to disagree about whether there is
 * anything to download.
 *
 * The button is always there, and the manifest only adds the version and the
 * size to it. It used to hide itself when the manifest was missing, which was
 * wrong twice over: in development there is never a manifest, so the button was
 * permanently invisible on the one machine where it needed testing; and in
 * production the build always publishes the installer, so the case it guarded
 * against barely happens. A link that 404s is a visible, diagnosable fault. A
 * button that silently deletes itself is neither.
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  readonly installerPath = INSTALLER_PATH;
  readonly portablePath = PORTABLE_PATH;
  readonly claudePluginPath = CLAUDE_PLUGIN_PATH;
  readonly codexPluginPath = CODEX_PLUGIN_PATH;
  readonly codexPluginRepository = CODEX_PLUGIN_REPOSITORY;
  readonly claudePluginRepository = CLAUDE_PLUGIN_REPOSITORY;

  readonly info = signal<InstallerInfo | null>(null);

  constructor(
    desktop: DesktopService,
    http: HttpClient,
    @Inject(PLATFORM_ID) platformId: object
  ) {
    // Inside the application there is nothing to offer: it is the download.
    if (desktop.isDesktop || !isPlatformBrowser(platformId)) return;

    // A missing manifest costs the version and the size, and nothing else.
    http.get<InstallerInfo>('/assets/download/installer.json').subscribe({
      next: (info) => this.info.set(info),
      error: () => {}
    });
  }

  /**
   * The Codex plugin: copies its repository address and says where to paste it.
   * Bound to a link whose href is the repository, so without scripts it still
   * leads somewhere useful.
   */
  async copyCodexRepository(event?: Event, announce = true): Promise<boolean> {
    return this.copyPluginRepository('codex', event, announce);
  }

  async copyClaudeRepository(event?: Event, announce = true): Promise<boolean> {
    return this.copyPluginRepository('claude', event, announce);
  }

  private async copyPluginRepository(
    client: 'codex' | 'claude',
    event?: Event,
    announce = true
  ): Promise<boolean> {
    event?.preventDefault();
    const address = client === 'codex' ? CODEX_PLUGIN_REPOSITORY : CLAUDE_PLUGIN_REPOSITORY;
    const name = client === 'codex' ? 'Codex' : 'Claude Code';
    let copied = false;
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
    } catch {
      try {
        const field = document.createElement('textarea');
        field.value = address;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.appendChild(field);
        field.select();
        copied = document.execCommand('copy');
        field.remove();
      } catch { /* shown in the message below */ }
    }
    if (!announce) return copied;

    window.alert(
      (copied ? `The ${name} plugin repository was copied to your clipboard:\n\n`
              : `Copy the ${name} plugin repository:\n\n`) +
      `${address}\n\n` +
      'The editor and the plugin are released together, so use the latest of both.\n\n' +
      '1. Install the latest SimpleVlogEditor for Windows from this site, keeping the default folder. ' +
      'If a version is already installed, uninstall it first, install the new one, and restart the computer.\n' +
      '2. Node.js 18 or newer must be on the PATH.\n' +
      (client === 'codex'
        ? '3. In Codex, open Plugins, add a marketplace using this repository address, then install "Simple Vlog Editor". ' +
          'If the plugin is already installed, remove it and install it again from the repository.\n' +
          'Or run in a terminal:\n' +
          `codex plugin marketplace add ${address}\n` +
          'codex plugin add simple-vlog-editor@simple-vlog-editor\n' +
          '4. Restart Codex and start a new task, so it loads the new version.'
        : '3. In Claude Code, run these two commands:\n' +
          `/plugin marketplace add ${address}\n` +
          '/plugin install simple-vlog-editor@simplevlogeditor\n' +
          'If the plugin is already installed, uninstall it and install it again from the repository.\n' +
          '4. Restart Claude Code and start a new session, so it loads the new version.')
    );
    return copied;
  }

  /** "Windows app — version 1.0.0, 94 MB", once the manifest has arrived. */
  installerTitle(): string {
    const info = this.info();
    return info
      ? `Download the Windows app — version ${info.version}, ${info.installer.size}`
      : 'Download the Windows app';
  }
}

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

  /** "Windows app — version 1.0.0, 94 MB", once the manifest has arrived. */
  installerTitle(): string {
    const info = this.info();
    return info
      ? `Download the Windows app — version ${info.version}, ${info.installer.size}`
      : 'Download the Windows app';
  }
}

import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** What the window is doing, as the main process sees it. */
export interface DesktopWindowState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

/** The bridge the desktop shell hangs on `window`. Absent in a browser. */
interface DesktopBridge {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  getState(): Promise<DesktopWindowState>;
  onState(listener: (state: DesktopWindowState) => void): () => void;
  /** Added after the first release; absent in a window built before it. */
  reconnectFiles?(): Promise<boolean>;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

/**
 * Whether this is a window, and what that window is doing.
 *
 * The same build serves both: in a browser tab `isDesktop` is false, nothing
 * here is ever called and the page is exactly what it has always been. Inside
 * the desktop shell the bridge exists, the title bar's three lights become
 * buttons and the bar itself becomes the thing you drag the window by.
 *
 * Everything is guarded for the server as well, because these pages are
 * prerendered and there is no `window` at all while that happens.
 */
@Injectable({ providedIn: 'root' })
export class DesktopService {
  private readonly bridge: DesktopBridge | undefined =
    typeof window === 'undefined' ? undefined : window.desktop;

  /** True only inside the desktop shell. */
  readonly isDesktop = !!this.bridge;

  readonly maximized = signal(false);
  readonly fullScreen = signal(false);
  readonly focused = signal(true);

  constructor() {
    if (!this.bridge) return;

    /*
     * One class on the document, and the global stylesheet does the rest.
     *
     * It has to be global: what it turns off — selecting text, dragging an
     * image out — happens inside every component on every page, and a
     * component's own stylesheet can only reach its own elements.
     */
    document.documentElement.classList.add('is-desktop');

    this.bridge.getState().then((state) => this.apply(state)).catch(() => {});
    const stop = this.bridge.onState((state) => this.apply(state));
    inject(DestroyRef).onDestroy(stop);
  }

  private apply(state: DesktopWindowState): void {
    this.maximized.set(state.maximized);
    this.fullScreen.set(state.fullScreen);
    this.focused.set(state.focused);
  }

  /**
   * Asks the application to call the page back with a gesture behind the call.
   *
   * The editor can reopen the files a restored project is waiting for — it kept
   * a durable reference to each of them — but asking for permission to read a
   * file is only allowed while somebody is pressing something, and a window
   * that has just opened by itself has nobody pressing anything. The
   * application has no such restriction, so it runs the page's own reconnect
   * inside a real activation and the project comes back with nothing said.
   *
   * False in a browser tab, and in a desktop build older than this, where the
   * reader presses the button as they always did.
   */
  async reconnectFiles(): Promise<boolean> {
    if (!this.bridge?.reconnectFiles) return false;
    try {
      return await this.bridge.reconnectFiles();
    } catch {
      return false;
    }
  }

  minimize(): void {
    this.bridge?.minimize();
  }

  toggleMaximize(): void {
    this.bridge?.toggleMaximize();
  }

  close(): void {
    this.bridge?.close();
  }

  /**
   * The double-click on the title bar.
   *
   * A double-click that landed on a button is that button being pressed twice,
   * not a gesture on the bar, so anything interactive under the pointer means
   * this does nothing.
   */
  titleBarDoubleClick(event: MouseEvent): void {
    if (!this.isDesktop) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, select, textarea, [role="button"], .no-drag')) return;

    this.toggleMaximize();
  }
}

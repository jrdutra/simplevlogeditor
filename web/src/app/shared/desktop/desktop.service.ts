import { DestroyRef, Injectable, NgZone, inject, signal } from '@angular/core';
import { DesktopFileDescriptor, PathBackedFile } from './path-backed-file';

/** What the window is doing, as the main process sees it. */
export interface DesktopWindowState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

export interface AgentControlState {
  active: boolean;
  visible?: boolean;
  connectionStatus?: 'idle' | 'connected' | 'disconnected' | 'reconnecting';
  controller: 'codex' | 'chatgpt' | 'mcp';
  controllers: string[];
  sessionId?: string;
  lastConnectionAt?: string | null;
  recoveryPath?: string | null;
}

export interface AgentSystemEvent {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  module: string;
  message: string;
  details?: unknown;
}

export interface AgentRuntimeInfo {
  editorVersion?: string;
  apiVersion?: number;
  protocolVersion?: number;
  sessionId?: string;
  platform?: string;
  arch?: string;
  versions?: Record<string, string>;
}

/** The bridge the desktop shell hangs on `window`. Absent in a browser. */
interface DesktopBridge {
  platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  getState(): Promise<DesktopWindowState>;
  onState(listener: (state: DesktopWindowState) => void): () => void;
  onAgentControlState?(listener: (state: AgentControlState) => void): () => void;
  onAgentSystemEvent?(listener: (entry: AgentSystemEvent) => void): () => void;
  getAgentRuntimeInfo?(): Promise<AgentRuntimeInfo>;
  /** Added after the first release; absent in a window built before it. */
  reconnectFiles?(): Promise<boolean>;
  /** Registers the one narrow command surface the local MCP host may call. */
  registerAgentHandler?(
    handler: (request: unknown, respond: (response: { result?: unknown; error?: unknown }) => void) => void
  ): () => void;
  registerAgentCancelHandler?(handler: (operationId: string) => void): () => void;
  reportAgentProgress?(progress: Record<string, unknown>): void;
  /** Resolves admitted paths to small descriptors; bytes stay on disk. */
  readAgentFiles?(paths: string[]): Promise<DesktopFileDescriptor[]>;
  openAgentOutput?(path: string): Promise<string>;
  writeAgentOutput?(id: string, position: number, data: ArrayBuffer): Promise<number>;
  closeAgentOutput?(id: string): Promise<void>;
  abortAgentOutput?(id: string): Promise<void>;
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
  private readonly zone = inject(NgZone);
  private readonly bridge: DesktopBridge | undefined =
    typeof window === 'undefined' ? undefined : window.desktop;

  /** True only inside the desktop shell. */
  readonly isDesktop = !!this.bridge;

  readonly maximized = signal(false);
  readonly fullScreen = signal(false);
  readonly focused = signal(true);
  readonly agentControl = signal<AgentControlState>({ active: false, controller: 'mcp', controllers: [] });

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
    const stopAgentControl = this.bridge.onAgentControlState?.((state) => {
      this.zone.run(() => this.agentControl.set(state));
    });
    if (stopAgentControl) inject(DestroyRef).onDestroy(stopAgentControl);
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

  registerAgentHandler(handler: (request: unknown) => Promise<unknown>): () => void {
    return this.bridge?.registerAgentHandler?.((request, respond) => {
      handler(request).then(
        (result) => respond({ result }),
        (error) => respond({
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: error && typeof error === 'object' && 'code' in error ? error.code : 'editor_error',
            details: error && typeof error === 'object' ? {
              ...('details' in error && error.details && typeof error.details === 'object' ? error.details : {}),
              stage: 'stage' in error ? error.stage : undefined,
              hint: 'hint' in error ? error.hint : undefined,
              stack: error instanceof Error ? error.stack : undefined,
              cause: 'cause' in error && error.cause instanceof Error ? {
                name: error.cause.name,
                message: error.cause.message,
                stack: error.cause.stack
              } : undefined
            } : undefined
          }
        })
      );
    }) ?? (() => undefined);
  }

  registerAgentCancelHandler(handler: (operationId: string) => void): () => void {
    return this.bridge?.registerAgentCancelHandler?.(handler) ?? (() => undefined);
  }

  reportAgentProgress(progress: Record<string, unknown>): void {
    this.bridge?.reportAgentProgress?.(progress);
  }

  onAgentSystemEvent(listener: (entry: AgentSystemEvent) => void): () => void {
    return this.bridge?.onAgentSystemEvent?.((entry) => this.zone.run(() => listener(entry))) ?? (() => undefined);
  }

  async getAgentRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return await this.bridge?.getAgentRuntimeInfo?.() ?? {
      platform: typeof navigator === 'undefined' ? 'unknown' : navigator.platform
    };
  }

  async readAgentFiles(paths: string[]): Promise<File[]> {
    if (!this.bridge?.readAgentFiles) throw new Error('Automated file access is only available in the desktop app.');
    const files = await this.bridge.readAgentFiles(paths);
    return files.map((entry) => new PathBackedFile(entry));
  }

  async openAgentOutput(path: string): Promise<{
    write(chunk: { data?: BufferSource; position?: number } | BufferSource): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    if (!this.bridge?.openAgentOutput || !this.bridge.writeAgentOutput || !this.bridge.closeAgentOutput) {
      throw new Error('Automated export is only available in the desktop app.');
    }
    const id = await this.bridge.openAgentOutput(path);
    let cursor = 0;
    return {
      write: async (chunk) => {
        const wrapped = typeof chunk === 'object' && chunk !== null && 'data' in chunk
          ? chunk as { data?: BufferSource; position?: number }
          : { data: chunk as BufferSource };
        if (!wrapped.data) return;
        const bytes = wrapped.data instanceof ArrayBuffer
          ? wrapped.data
          : wrapped.data.buffer.slice(wrapped.data.byteOffset, wrapped.data.byteOffset + wrapped.data.byteLength);
        const position = wrapped.position ?? cursor;
        cursor = await this.bridge!.writeAgentOutput!(id, position, bytes);
      },
      close: () => this.bridge!.closeAgentOutput!(id),
      abort: () => this.bridge?.abortAgentOutput?.(id) ?? this.bridge!.closeAgentOutput!(id)
    };
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

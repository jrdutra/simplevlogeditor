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
  controller: 'codex' | 'chatgpt' | 'claude-code' | 'mcp';
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
  shortCommand?(name: string, args?: Record<string, unknown>): Promise<any>;
  chooseShortOutput?(name: string): Promise<string | null>;
  platform: string;
  minimize(): void;
  focus?(): void;
  toggleMaximize(): void;
  close(): void | Promise<void>;
  getState(): Promise<DesktopWindowState>;
  onState(listener: (state: DesktopWindowState) => void): () => void;
  onAgentControlState?(listener: (state: AgentControlState) => void): () => void;
  onAgentSystemEvent?(listener: (entry: AgentSystemEvent) => void): () => void;
  getAgentRuntimeInfo?(): Promise<AgentRuntimeInfo>;
  checkpointProject?(payload: { document: unknown; projectRevision: number; reason: string }): Promise<unknown>;
  clearProjectCheckpoint?(payload: { projectRevision: number; reason: string }): Promise<unknown>;
  purgeProjectRecovery?(payload: { projectRevision: number; reason: string }): Promise<unknown>;
  registerBeforeCloseHandler?(handler: () => Promise<void>): () => void;
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
  /** Creates an output folder inside an allowed root. Absent in a window built before Video Packaging. */
  ensureAgentFolder?(path: string): Promise<string>;
  openAgentOutput?(path: string): Promise<string>;
  writeAgentOutput?(id: string, position: number, data: ArrayBuffer): Promise<number>;
  closeAgentOutput?(id: string): Promise<void>;
  abortAgentOutput?(id: string): Promise<void>;
  /** Allowed folders. Absent in a window built before consent existed. */
  pathForFile?(file: File): string | null;
  rememberFolders?(paths: string[]): Promise<RootState & { granted: string[] }>;
  ensureRoots?(paths: string[]): Promise<RootState & { missing: MissingRoot[] }>;
  listRoots?(): Promise<RootState>;
  addRoot?(purpose?: 'packaging'): Promise<RootState & { granted: string | null; cancelled: boolean }>;
  removeRoot?(folder: string): Promise<RootState & { removed: boolean }>;
  requestRootConsent?(request: { path: string; folder?: string }): Promise<RootConsentResult>;
  onRootState?(listener: (state: RootState) => void): () => void;
}

/** A persistent shell handler can decline a command so the active tool may handle it. */
export const AGENT_REQUEST_NOT_HANDLED = Symbol('agent-request-not-handled');
type AgentRequestHandler = (request: unknown) => Promise<unknown> | unknown;

/** A path the editor may not reach yet, and the folder that would allow it. */
export interface MissingRoot { path: string; folder: string; }

/** Where each allowed folder came from. */
export type RootSource = 'env' | 'mcp-client' | 'consent' | 'defaults';

export interface RootState {
  roots: string[];
  entries: { path: string; source: RootSource }[];
  rootSource: RootSource | 'none';
  overridden: boolean;
  refusedByPolicy: string[];
  rootNotice: string;
}

export interface RootConsentResult extends RootState {
  granted: string | null;
  /** null when granted; otherwise path_consent_denied/mismatch/refused. */
  code: string | null;
  chosen?: string;
  message?: string;
}

export const EMPTY_ROOT_STATE: RootState = {
  roots: [], entries: [], rootSource: 'none', overridden: false,
  refusedByPolicy: [], rootNotice: ''
};

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
  private readonly agentHandlers = new Set<AgentRequestHandler>();
  private agentBridgeStop: (() => void) | null = null;
  private agentHandlerVersion = 0;
  private readonly agentHandlerWaiters = new Set<() => void>();

  /** True only inside the desktop shell. */
  readonly isDesktop = !!this.bridge;

  readonly maximized = signal(false);
  readonly fullScreen = signal(false);
  readonly focused = signal(true);
  readonly agentControl = signal<AgentControlState>({ active: false, controller: 'mcp', controllers: [] });

  /**
   * The folders the editor may use, kept live. The application pushes a new
   * state whenever one is added or removed, so the settings list and the
   * consent dialog never show a stale answer.
   */
  readonly roots = signal<RootState>(EMPTY_ROOT_STATE);

  /** False in a browser tab, and in a desktop window built before consent. */
  readonly supportsRootConsent = typeof window !== 'undefined' && !!window.desktop?.requestRootConsent;

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
      this.zone.run(() => {
        this.agentControl.set(state);
        this.noticeConnection(state);
      });
    });
    if (stopAgentControl) inject(DestroyRef).onDestroy(stopAgentControl);

    this.bridge.listRoots?.().then((state) => this.zone.run(() => this.roots.set(state))).catch(() => {});
    const stopRoots = this.bridge.onRootState?.((state) => this.zone.run(() => this.roots.set(state)));
    if (stopRoots) inject(DestroyRef).onDestroy(stopRoots);

    this.watchUserChosenFiles(inject(DestroyRef));
  }

  /**
   * Every file the user puts into this window, in one place.
   *
   * Listening at the document in the capture phase rather than calling from
   * each picker: there are seven `<input type="file">` elements and a drop
   * target in the editor alone, and the one that gets forgotten is the one that
   * refuses the user's folder a month from now. `DataTransfer.files` is read
   * synchronously here, before any handler yields and empties it.
   *
   * `showOpenFilePicker` fires no change event, so that path calls
   * `rememberFolders` itself.
   */
  private watchUserChosenFiles(destroyRef: DestroyRef): void {
    if (!this.bridge?.rememberFolders) return;

    const onDrop = (event: Event) => {
      const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
      if (files.length) void this.rememberFolders(files);
    };
    const onChange = (event: Event) => {
      const target = event.target as HTMLInputElement | null;
      if (!target || target.tagName !== 'INPUT' || target.type !== 'file') return;
      const files = Array.from(target.files ?? []);
      if (files.length) void this.rememberFolders(files);
    };

    document.addEventListener('drop', onDrop, true);
    document.addEventListener('change', onChange, true);
    destroyRef.onDestroy(() => {
      document.removeEventListener('drop', onDrop, true);
      document.removeEventListener('change', onChange, true);
    });
  }

  /**
   * A *new* client connection, as opposed to one that is merely still there.
   *
   * The control panel can be closed outright, and what brings it back is an AI
   * connecting — not more activity from the one the user just dismissed. That
   * distinction needs an edge, and the state signal only offers a level.
   */
  private lastConnectionStamp: string | null = null;
  private readonly connectionHandlers = new Set<() => void>();

  onAgentConnected(handler: () => void): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  private noticeConnection(state: AgentControlState): void {
    if (!state.active) {
      // A drop clears the stamp, so reconnecting afterwards counts as new.
      this.lastConnectionStamp = null;
      return;
    }
    const stamp = state.lastConnectionAt ?? state.sessionId ?? null;
    if (!stamp || stamp === this.lastConnectionStamp) return;
    this.lastConnectionStamp = stamp;
    for (const handler of this.connectionHandlers) handler();
  }

  /**
   * Tell the application which folders the user just chose in this window.
   *
   * Called wherever a file arrives by the user's own hand — a picker, a drop,
   * opening or saving a project. Silent by design: the folder is already
   * reachable to the user, and the Allowed folders list is where they see what
   * accumulated. Files the user did not choose never reach this.
   */
  async rememberFolders(files: readonly File[]): Promise<void> {
    if (!this.bridge?.rememberFolders || !this.bridge.pathForFile) return;
    const paths: string[] = [];
    for (const file of files) {
      const found = this.bridge.pathForFile(file);
      if (found) paths.push(found);
    }
    if (!paths.length) return;
    try {
      const state = await this.bridge.rememberFolders(paths);
      this.zone.run(() => this.roots.set(state));
    } catch {
      // A folder that could not be remembered is not a reason to refuse the
      // file the user just chose: the window already holds its bytes.
    }
  }

  /** Ask the user, through the native picker, to allow the folder of one path. */
  async requestRootConsent(request: { path: string; folder?: string }): Promise<RootConsentResult | null> {
    if (!this.bridge?.requestRootConsent) return null;
    const result = await this.bridge.requestRootConsent(request);
    this.zone.run(() => this.roots.set(result));
    return result;
  }

  async addRoot(purpose?: 'packaging'): Promise<{ granted: string | null; cancelled: boolean } | null> {
    if (!this.bridge?.addRoot) return null;
    const result = await this.bridge.addRoot(purpose);
    this.zone.run(() => this.roots.set(result));
    return result;
  }

  async removeRoot(folder: string): Promise<boolean> {
    if (!this.bridge?.removeRoot) return false;
    const result = await this.bridge.removeRoot(folder);
    this.zone.run(() => this.roots.set(result));
    return result.removed;
  }

  /**
   * Which of these paths the editor may not reach yet.
   *
   * Asked before the paths are used. An IPC rejection carries a message but
   * none of the error's own fields, so a refusal caught afterwards cannot be
   * told apart from any other failure — and "ask rather than fail" needs the
   * answer while there is still something to ask about.
   */
  async missingRoots(paths: readonly string[]): Promise<MissingRoot[]> {
    if (!this.bridge?.ensureRoots || !paths.length) return [];
    try {
      const result = await this.bridge.ensureRoots([...paths]);
      this.zone.run(() => this.roots.set(result));
      return result.missing ?? [];
    } catch {
      // A window built before consent existed. The path check still happens in
      // the application; it simply cannot be asked about in advance.
      return [];
    }
  }

  async refreshRoots(): Promise<void> {
    if (!this.bridge?.listRoots) return;
    try {
      const state = await this.bridge.listRoots();
      this.zone.run(() => this.roots.set(state));
    } catch { /* the list is a view; a failed refresh is not an error to raise */ }
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

  registerAgentHandler(handler: AgentRequestHandler): () => void {
    this.agentHandlers.add(handler);
    this.agentHandlerVersion++;
    for (const wake of [...this.agentHandlerWaiters]) wake();

    if (!this.agentBridgeStop) this.agentBridgeStop = this.bridge?.registerAgentHandler?.((request, respond) => {
      this.dispatchAgentRequest(request).then(
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
    }) ?? null;

    return () => {
      this.agentHandlers.delete(handler);
      this.agentHandlerVersion++;
    };
  }

  private async dispatchAgentRequest(request: unknown): Promise<unknown> {
    const deadline = Date.now() + 10_000;
    while (true) {
      const version = this.agentHandlerVersion;
      for (const handler of [...this.agentHandlers]) {
        try {
          const result = await handler(request);
          if (result !== AGENT_REQUEST_NOT_HANDLED) return result;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code ?? '') : '';
          if (code !== 'unknown_command') throw error;
        }
      }
      if (Date.now() >= deadline) {
        const name = request && typeof request === 'object' && 'name' in request
          ? String((request as { name?: unknown }).name ?? '') : '';
        throw Object.assign(new Error(`No active tool handles "${name || 'this command'}".`), { code: 'unknown_command' });
      }
      await new Promise<void>((resolve) => {
        let timer = 0;
        const wake = () => done();
        const done = () => {
          window.clearTimeout(timer);
          this.agentHandlerWaiters.delete(wake);
          resolve();
        };
        timer = window.setTimeout(done, 250);
        this.agentHandlerWaiters.add(wake);
        if (this.agentHandlerVersion !== version) done();
      });
    }
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

  /** Persist the complete edit to Electron without exposing a writable path. */
  async checkpointProject(document: unknown, projectRevision: number, reason = 'Editor autosave'): Promise<boolean> {
    if (!this.bridge?.checkpointProject) return false;
    await this.bridge.checkpointProject({ document, projectRevision, reason });
    return true;
  }

  /** Clearing a project also clears the disk recovery, so stale work cannot return. */
  async clearProjectCheckpoint(projectRevision: number, reason = 'Project cleared'): Promise<boolean> {
    if (!this.bridge?.clearProjectCheckpoint) return false;
    await this.bridge.clearProjectCheckpoint({ projectRevision, reason });
    return true;
  }

  /**
   * "Clear all": removes every recovery checkpoint and AI temporary the desktop
   * editor left in any folder, not only the current one. Falls back to the
   * single checkpoint on an older desktop build.
   */
  async purgeProjectRecovery(projectRevision: number, reason = 'Clear all'): Promise<boolean> {
    if (this.bridge?.purgeProjectRecovery) {
      await this.bridge.purgeProjectRecovery({ projectRevision, reason });
      return true;
    }
    return this.clearProjectCheckpoint(projectRevision, reason);
  }

  registerBeforeCloseHandler(handler: () => Promise<void>): () => void {
    return this.bridge?.registerBeforeCloseHandler?.(handler) ?? (() => undefined);
  }

  async readAgentFiles(paths: string[]): Promise<File[]> {
    if (!this.bridge?.readAgentFiles) throw new Error('Automated file access is only available in the desktop app.');
    await this.ensureAllowed(paths, 'read this media');
    const files = await this.bridge.readAgentFiles(paths);
    return files.map((entry) => new PathBackedFile(entry));
  }

  /**
   * Registered by the editor window: shows the consent dialog and resolves with
   * the folder the user allowed, or null if they declined. Left null in a
   * browser tab, where there is nothing to ask and nothing to grant.
   */
  private consentAsker: ((missing: MissingRoot, reason: string) => Promise<string | null>) | null = null;

  registerRootConsentAsker(asker: ((missing: MissingRoot, reason: string) => Promise<string | null>) | null): void {
    this.consentAsker = asker;
  }

  /**
   * Ask before failing.
   *
   * Every automated read and write passes through here, so a path outside the
   * allowed folders raises a dialog once rather than an error the user cannot
   * act on. Declining throws `path_consent_denied`, which is a decision and is
   * reported as one — not as a missing file or a broken editor.
   */
  private async ensureAllowed(paths: readonly string[], reason: string): Promise<void> {
    if (!this.consentAsker) return;
    let missing = await this.missingRoots(paths);
    while (missing.length) {
      const granted = await this.consentAsker(missing[0], reason);
      if (!granted) {
        throw Object.assign(
          new Error(`The editor was not allowed to use ${missing[0].folder}.`),
          { code: 'path_consent_denied', details: { path: missing[0].path, folder: missing[0].folder } }
        );
      }
      const remaining = await this.missingRoots(paths);
      // A grant that leaves the same folder missing would loop forever; stop
      // and report rather than asking again for something already answered.
      if (remaining.length === missing.length && remaining[0]?.folder === missing[0].folder) {
        throw Object.assign(
          new Error(`${granted} does not make ${missing[0].path} reachable.`),
          { code: 'path_consent_denied', details: { path: missing[0].path, folder: missing[0].folder } }
        );
      }
      missing = remaining;
    }
  }

  /**
   * Makes sure a folder exists before anything is written into it.
   *
   * Video Packaging keeps its covers and its lettering reference beside the
   * footage, in a folder that will not exist the first time. Older windows have
   * no such bridge, and say so rather than failing later on the first write.
   */
  async ensureAgentFolder(path: string): Promise<string> {
    if (!this.bridge?.ensureAgentFolder) {
      throw new Error('This version of the desktop app cannot create the output folder. Install the current editor.');
    }
    await this.ensureAllowed([path], 'write into this folder');
    return this.bridge.ensureAgentFolder(path);
  }

  async openAgentOutput(path: string): Promise<{
    write(chunk: { data?: BufferSource; position?: number } | BufferSource): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  }> {
    if (!this.bridge?.openAgentOutput || !this.bridge.writeAgentOutput || !this.bridge.closeAgentOutput) {
      throw new Error('Automated export is only available in the desktop app.');
    }
    await this.ensureAllowed([path], 'write this file');
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

  focus(): void {
    this.bridge?.focus?.();
  }

  toggleMaximize(): void {
    this.bridge?.toggleMaximize();
  }

  close(): void {
    void this.bridge?.close();
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

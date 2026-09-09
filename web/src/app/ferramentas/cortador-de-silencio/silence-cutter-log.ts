import type { MediabunnyLib } from './mediabunny-loader';

/**
 * Diagnostic trail for the Free Silence Cutter.
 *
 * Media processing fails in the browser for reasons that are invisible from the
 * outside: a codec configuration the browser quietly refuses, a decoder that
 * stops mid-file, a writable stream that was closed by someone else. When that
 * happens the only useful thing to have is an ordered record of what the tool
 * decided and what it was doing at the moment it stopped.
 *
 * Every entry goes to the console live, prefixed so it can be filtered, and is
 * also kept in memory so the whole run can be copied out of the error card in
 * one go.
 *
 * What is never recorded: the media itself, any sample or frame data, the
 * waveform, or the full path of the file. Sizes, durations, codecs and counts
 * describe the shape of the problem without describing the reader's recording.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Milliseconds since the run started. */
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const PREFIX = '[silence-cutter]';
const MAX_ENTRIES = 600;

/** Everything worth knowing about a thrown value, flattened for logging. */
export function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { type: typeof error, value: String(error) };
  }

  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };

  if (error.stack) described['stack'] = error.stack.split('\n').slice(0, 8).join('\n');
  if ('cause' in error && error.cause !== undefined) described['cause'] = describeError(error.cause);
  return described;
}

class SilenceCutterLog {
  private entries: LogEntry[] = [];
  private startedAt = 0;
  private detachMediabunny: (() => void)[] = [];

  /** Clears the trail. Called whenever a new run begins. */
  reset(label: string): void {
    this.entries = [];
    this.startedAt = typeof performance === 'undefined' ? 0 : performance.now();
    this.info('run', label, this.environment());
  }

  info(scope: string, message: string, data?: unknown): void {
    this.push('info', scope, message, data);
  }

  warn(scope: string, message: string, data?: unknown): void {
    this.push('warn', scope, message, data);
  }

  error(scope: string, message: string, data?: unknown): void {
    this.push('error', scope, message, data);
  }

  /** Logs how long something took, in milliseconds, rounded. */
  timing(scope: string, message: string, startedAt: number, data?: Record<string, unknown>): void {
    const elapsed = Math.round(performance.now() - startedAt);
    this.info(scope, message, { ...data, ms: elapsed });
  }

  /**
   * Forwards Mediabunny's own diagnostics into the same trail.
   *
   * The library warns about things this tool cannot see from outside — a frame
   * that was collected without being closed, an output finalized twice — and
   * those warnings belong next to the decisions that caused them.
   */
  attachMediabunny(library: MediabunnyLib): void {
    if (this.detachMediabunny.length) return;

    try {
      library.Logging.level = library.LogLevel.Info;
      for (const level of ['info', 'warn', 'error'] as const) {
        this.detachMediabunny.push(
          library.Logging.on(level, (data: unknown[]) => {
            this.push(level, 'mediabunny', data.map((item) => String(item)).join(' '), undefined, true);
          })
        );
      }
      this.info('mediabunny', 'diagnostics attached');
    } catch (error) {
      this.warn('mediabunny', 'could not attach diagnostics', describeError(error));
    }
  }

  /** The whole run as text, ready to be pasted into a bug report. */
  transcript(): string {
    const lines = this.entries.map((entry) => {
      const time = String(Math.round(entry.at)).padStart(6, ' ');
      const level = entry.level === 'info' ? '   ' : entry.level === 'warn' ? 'WRN' : 'ERR';
      const data = entry.data === undefined ? '' : ` ${safeJson(entry.data)}`;
      return `${time}ms ${level} ${entry.scope}: ${entry.message}${data}`;
    });

    return [`${PREFIX} diagnostic log — ${lines.length} entries`, ...lines].join('\n');
  }

  get size(): number {
    return this.entries.length;
  }

  /** Facts about the browser that change which pipeline can even be used. */
  private environment(): Record<string, unknown> {
    if (typeof navigator === 'undefined') return {};
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      userAgent: nav.userAgent,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory ?? null,
      secureContext: typeof isSecureContext === 'undefined' ? null : isSecureContext,
      language: nav.language
    };
  }

  private push(level: LogLevel, scope: string, message: string, data?: unknown, fromLibrary = false): void {
    if (typeof performance === 'undefined') return;

    const entry: LogEntry = {
      at: performance.now() - this.startedAt,
      level,
      scope,
      message,
      data
    };

    this.entries.push(entry);
    // A trail that grows without bound would itself become a memory problem on
    // a long export; the oldest entries are the least useful ones.
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);

    // Mediabunny already printed its own messages; re-printing them would
    // double every line in the console.
    if (fromLibrary) return;

    const label = `${PREFIX} ${scope}: ${message}`;
    const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    if (data === undefined) method(label);
    else method(label, data);
  }
}

/** Serializes anything, including the values that would normally throw. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (item instanceof Error) return describeError(item);
      if (ArrayBuffer.isView(item)) return `<${item.constructor.name} length=${(item as Uint8Array).length}>`;
      return item;
    });
  } catch {
    return String(value);
  }
}

/** One trail per page, shared by every layer of the tool. */
export const silenceLog = new SilenceCutterLog();

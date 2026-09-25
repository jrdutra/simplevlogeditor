export interface DesktopFileDescriptor {
  filePath?: string;
  path?: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  url: string;
}

interface PathBackedMarker {
  readonly sveSourceUrl: string;
  readonly sveSourcePath?: string;
}

function rangeHeader(start: number, end: number): HeadersInit {
  return end > start ? { Range: `bytes=${start}-${end - 1}` } : {};
}

async function checkedFetch(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Local media read failed (${response.status}).`);
  return response;
}

/**
 * A browser File-shaped reference to a local path. Only requested byte ranges
 * cross Electron's private HTTP endpoint; the video is never copied into IPC.
 */
export class PathBackedFile extends File implements PathBackedMarker {
  readonly sveSourceUrl: string;
  readonly sveSourcePath?: string;
  private readonly sourceSize: number;

  constructor(descriptor: DesktopFileDescriptor) {
    super([], descriptor.name, { type: descriptor.type, lastModified: descriptor.lastModified });
    this.sourceSize = descriptor.size;
    this.sveSourceUrl = descriptor.url;
    this.sveSourcePath = descriptor.filePath ?? descriptor.path;
  }

  override get size(): number { return this.sourceSize; }

  override slice(start = 0, end = this.size, contentType = this.type): Blob {
    const safeStart = Math.max(0, start < 0 ? this.size + start : start);
    const safeEnd = Math.max(safeStart, Math.min(this.size, end < 0 ? this.size + end : end));
    const url = this.sveSourceUrl;
    const length = safeEnd - safeStart;
    return {
      size: length,
      type: contentType,
      arrayBuffer: async () => length ? (await checkedFetch(url, { headers: rangeHeader(safeStart, safeEnd) })).arrayBuffer() : new ArrayBuffer(0),
      text: async () => new TextDecoder().decode(length ? await (await checkedFetch(url, { headers: rangeHeader(safeStart, safeEnd) })).arrayBuffer() : new ArrayBuffer(0)),
      stream: () => remoteStream(url, safeStart, safeEnd),
      slice: (innerStart?: number, innerEnd?: number, innerType?: string) => this.slice(safeStart + (innerStart ?? 0), safeStart + (innerEnd ?? length), innerType ?? contentType)
    } as unknown as Blob;
  }

  override arrayBuffer(): Promise<ArrayBuffer> { return checkedFetch(this.sveSourceUrl).then((response) => response.arrayBuffer()); }
  override text(): Promise<string> { return checkedFetch(this.sveSourceUrl).then((response) => response.text()); }
  override stream(): ReadableStream<Uint8Array> { return remoteStream(this.sveSourceUrl, 0, this.size); }
}

function remoteStream(url: string, start: number, end: number): ReadableStream<Uint8Array> {
  if (end <= start) return new ReadableStream({ start: (controller) => controller.close() });
  const abort = new AbortController();
  // A paused decoder must not keep an HTTP response open to the end of a large
  // file. Several such readers (filmstrip, waveform, tracking) otherwise occupy
  // all Chromium connections to the local server and block new range requests.
  const chunkSize = 1024 * 1024;
  let position = start;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        const next = Math.min(end, position + chunkSize);
        const response = await checkedFetch(url, { headers: rangeHeader(position, next), signal: abort.signal });
        // Consume the complete bounded response before yielding to a consumer
        // that may pause indefinitely. Memory and read-ahead stay bounded too.
        const data = await response.arrayBuffer();
        if (cancelled) return;
        if (data.byteLength !== next - position) throw new Error('Local media returned an incomplete byte range.');
        position = next;
        controller.enqueue(new Uint8Array(data));
        if (position >= end) controller.close();
      } catch (error) { if (!cancelled) controller.error(error); }
    },
    cancel() {
      cancelled = true;
      abort.abort();
    }
  });
}

export function pathBackedUrl(file: File): string | null {
  return typeof (file as unknown as Partial<PathBackedMarker>).sveSourceUrl === 'string'
    ? (file as unknown as PathBackedMarker).sveSourceUrl
    : null;
}

export function pathBackedPath(file: File): string | undefined {
  const stored = (file as unknown as Partial<PathBackedMarker>).sveSourcePath;
  if (stored) return stored;
  // Native picker/drop Files are not PathBackedFiles. Electron 32+ exposes
  // their path through webUtils in preload, not through File.path. Resolving
  // this does not grant access; all disk operations still check allowed roots.
  try {
    return typeof window === 'undefined' ? undefined : window.desktop?.pathForFile?.(file) || undefined;
  } catch {
    // Browser-created Files and some restored handles have bytes but no path.
    return undefined;
  }
}

export function mediaObjectUrl(file: File): string {
  return pathBackedUrl(file) ?? URL.createObjectURL(file);
}

export async function imageBitmapForFile(file: File): Promise<ImageBitmap> {
  const url = pathBackedUrl(file);
  return createImageBitmap(url ? await checkedFetch(url).then((response) => response.blob()) : file);
}

export function revokeMediaObjectUrl(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

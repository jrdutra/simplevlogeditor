/**
 * Where Video Packaging keeps what it makes.
 *
 * Covers are drawn from the footage, so they belong beside the footage: a
 * `video-packaging` folder next to the media, holding the chosen backgrounds
 * and the lettering the covers copy. Nothing here touches the filesystem — it
 * is path arithmetic only, so it can be read and tested on its own.
 */

/** The separator the given path already uses, so a Windows path stays a Windows path. */
export function separatorOf(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/**
 * Everything before the last separator.
 *
 * A file at the root keeps its root — `C:\clip.mp4` lives in `C:\`, not in the
 * drive-relative `C:`, and `/clip.mp4` lives in `/`. A bare name has no folder
 * of its own and answers `.`.
 */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) return '.';
  const head = path.slice(0, cut);
  if (!head) return path[cut];
  if (/^[A-Za-z]:$/.test(head)) return head + path[cut];
  return head;
}

/** The last segment of a path. */
export function nameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

export function joinPath(base: string, ...parts: readonly string[]): string {
  const segments = parts.filter(Boolean);
  if (!base) return segments.join('/');
  const separator = separatorOf(base);
  const trimmed = base.replace(/[\\/]+$/, '');
  return [trimmed, ...segments].join(separator);
}

/** The folder Video Packaging writes into, given any one of the project's media files. */
export function packagingFolderFor(sourcePath: string): string {
  return joinPath(folderOf(sourcePath), 'video-packaging');
}

/**
 * Whether two spellings name the same file.
 *
 * The bridge hands paths back in whatever form the filesystem prefers, and an
 * assistant may repeat one with forward slashes or a different case. On Windows
 * neither changes which file is meant.
 */
export function samePath(left: string, right: string): boolean {
  const windows = (value: string) => value.includes('\\') || /^[A-Za-z]:/.test(value);
  const normal = (value: string, fold: boolean) => {
    const unified = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
    return fold ? unified.toLowerCase() : unified;
  };
  const fold = windows(left) || windows(right);
  return normal(left, fold) === normal(right, fold);
}

/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name a filesystem will accept, built from something a person typed. */
export function safeStem(value: string, fallback = 'video'): string {
  const clean = value
    .normalize('NFKD')
    .replace(/[^\w\-. ]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!clean) return fallback;
  return RESERVED.test(clean.split('.')[0]) ? `${clean}-${fallback}` : clean;
}

/**
 * `00m07s400` — sortable, and readable next to the timestamp an agent asked for.
 *
 * Rounded once, to the millisecond, before it is split: rounding the fraction
 * on its own turns 7.9996 s into "07s1000".
 */
export function stampOf(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const minutes = Math.floor(total / 60_000);
  const rest = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}m${String(rest).padStart(2, '0')}s${String(millis).padStart(3, '0')}`;
}

export function extensionForMime(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

/** The bytes behind a data URL, without a round trip through fetch(). */
export function bytesFromDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) throw new Error('That is not a data URL.');
  const header = dataUrl.slice(5, comma);
  const mimeType = header.split(';')[0] || 'text/plain';
  const body = dataUrl.slice(comma + 1);

  if (header.split(';').includes('base64')) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return { bytes, mimeType };
  }

  // Percent-escapes are bytes, everything else is text and goes out as UTF-8.
  // decodeURIComponent would refuse escapes that are not UTF-8, and reading
  // char codes would cut every non-Latin character down to its low byte.
  const encoder = new TextEncoder();
  const out: number[] = [];
  for (let index = 0; index < body.length;) {
    if (body[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(body.slice(index + 1, index + 3))) {
      out.push(parseInt(body.slice(index + 1, index + 3), 16));
      index += 3;
      continue;
    }
    const code = body.codePointAt(index)!;
    const character = String.fromCodePoint(code);
    out.push(...encoder.encode(character));
    index += character.length;
  }
  return { bytes: Uint8Array.from(out), mimeType };
}

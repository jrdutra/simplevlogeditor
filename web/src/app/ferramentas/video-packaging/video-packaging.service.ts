import { computed, Injectable, signal } from '@angular/core';

import { DesktopService } from '../../shared/desktop/desktop.service';
import {
  clearCustomStyle,
  readCustomStyle,
  readSettings,
  writeCustomStyle,
  writeSettings
} from './packaging-style-store';
import { DEFAULT_TAG_STYLE_ID, TagStyleOption, tagStyleOf, TAG_STYLES } from './video-packaging-styles';
import { readPackagingImage } from './packaging-image';
import { samePath } from './packaging-paths';

export interface ThumbnailResult {
  id: number;
  title: string;
  imageUrl: string | null;
  image: Blob | null;
  fileName: string | null;
  sourceTimestamp: number | null;
  sourceFramePath: string | null;
}

export interface VideoPackagingInput {
  thumbnails?: readonly {
    path: string;
    altText?: string;
    sourceTimestamp?: number;
    sourceFramePath?: string;
  }[];
  titles?: readonly string[];
  description?: string;
  tags?: readonly string[] | string;
}

/**
 * What the assistant understood about the video before it wrote anything.
 *
 * It is kept here rather than in the editor because it has to outlive the
 * editor page: a reader who walks from the timeline to this tool and back must
 * not cost the assistant a second pass over the transcript and the frames.
 */
export interface VideoUnderstanding {
  summary: string;
  topics: readonly string[];
  chapters: readonly { start: number; title: string }[];
  highlights: readonly { clipId: string; timestamp: number; note: string }[];
  language: string;
  updatedAt: number;
  /** The edit it was read from; null when no editor was open to say. See `editFingerprint`. */
  editFingerprint: string | null;
}

export interface VideoUnderstandingInput {
  summary?: string;
  topics?: readonly string[];
  chapters?: readonly { start: number; title: string }[];
  highlights?: readonly { clipId: string; timestamp: number; note: string }[];
  language?: string;
}

/** A frame the editor wrote to disk so it can be used as a cover background. */
export interface PackagingFrame {
  path: string;
  clipId: string;
  timestamp: number;
  width: number;
  height: number;
  outputTime: number;
  composited: true;
  /** The edit this frame was composed from. See `editFingerprint`. */
  editFingerprint: string;
}

/** The lettering in use: one of the sheets that ship with the editor, or the reader's own. */
export interface TagStyleState {
  source: 'preset' | 'custom';
  id: string;
  name: string;
  description: string;
  url: string;
  /** Null for a shipped sheet, which is fetched from the app's own assets when needed. */
  blob: Blob | null;
  /** Where the sheet was last written on disk, when the assistant asked for it. */
  path: string | null;
}

export const CUSTOM_TAG_STYLE_ID = 'custom';

const EMPTY_TITLE = 'Generated video title will appear here';
const EMPTY_DESCRIPTION =
  'The generated video description will appear here, followed by chapters and relevant hashtags.';
const EMPTY_TAGS = 'Generated tags will appear here, separated by commas';

/** Long enough for somebody to walk back to the machine, short enough not to hang a run. */
const PICKER_TIMEOUT_MS = 5 * 60_000;

@Injectable({ providedIn: 'root' })
export class VideoPackagingService {
  private readonly images = signal<readonly {
    url: string;
    blob: Blob;
    fileName: string;
    altText: string;
    sourceTimestamp: number | null;
    sourceFramePath: string | null;
    width: number;
    height: number;
  }[]>([]);
  private readonly titles = signal<readonly string[]>([]);
  private readonly descriptionValue = signal('');
  private readonly tagsValue = signal<readonly string[]>([]);
  private readonly understandingValue = signal<VideoUnderstanding | null>(null);
  private readonly framesValue = signal<readonly PackagingFrame[]>([]);
  readonly ready: Promise<void>;

  /**
   * Names the edit as it is now. Registered by the Video Editor, which is the
   * only thing that knows; see `editFingerprint` there. Frames and the stored
   * understanding are stamped with it, so a later cut, zoom or caption makes
   * them stale instead of letting a cover be drawn from a picture the video no
   * longer contains.
   */
  private fingerprintProvider: (() => string) | null = null;

  // -------------------------------------------------------------- the lettering

  /** The sheets that ship with the editor, for the picker. */
  readonly styles = TAG_STYLES;
  private readonly selectedId = signal(DEFAULT_TAG_STYLE_ID);
  private readonly modeValue = signal<'default' | 'ask'>('default');
  private readonly custom = signal<{ name: string; blob: Blob; url: string } | null>(null);
  private readonly stylePath = signal<string | null>(null);

  /** Open while the reader is choosing. `agent` means a packaging run is waiting on it. */
  readonly pickerOpen = signal(false);
  readonly pickerReason = signal<'reader' | 'agent'>('reader');
  private pickerSettle: ((id: string | null) => void) | null = null;
  private pickerTimer = 0;

  readonly options = computed<readonly ThumbnailResult[]>(() => Array.from({ length: 3 }, (_, index) => {
    const image = this.images()[index];
    return {
      id: index + 1,
      title: this.titles()[index] ?? EMPTY_TITLE,
      imageUrl: image?.url ?? null,
      image: image?.blob ?? null,
      fileName: image?.fileName ?? null,
      sourceTimestamp: image?.sourceTimestamp ?? null,
      sourceFramePath: image?.sourceFramePath ?? null
    };
  }));
  readonly description = computed(() => this.descriptionValue() || EMPTY_DESCRIPTION);
  readonly hasDescription = computed(() => !!this.descriptionValue());
  readonly tagsText = computed(() => this.tagsValue().length ? this.tagsValue().join(', ') : EMPTY_TAGS);
  readonly hasContent = computed(() =>
    this.images().length > 0 || this.titles().length > 0 || !!this.descriptionValue() || this.tagsValue().length > 0
  );
  readonly understanding = computed(() => this.understandingValue());
  readonly frames = computed(() => this.framesValue());
  readonly styleMode = computed(() => this.modeValue());
  readonly customStyle = computed(() => this.custom());

  readonly tagStyle = computed<TagStyleState>(() => {
    const own = this.custom();
    if (this.selectedId() === CUSTOM_TAG_STYLE_ID && own) {
      return {
        source: 'custom',
        id: CUSTOM_TAG_STYLE_ID,
        name: own.name,
        description: 'The reader loaded this lettering themselves. Copy it exactly.',
        url: own.url,
        blob: own.blob,
        path: this.stylePath()
      };
    }
    const preset: TagStyleOption = tagStyleOf(this.selectedId());
    return {
      source: 'preset',
      id: preset.id,
      name: preset.name,
      description: preset.description,
      url: preset.url,
      blob: null,
      path: this.stylePath()
    };
  });

  constructor(private readonly desktop: DesktopService) {
    this.ready = this.restoreStyle();
  }

  registerEditFingerprint(provider: () => string): () => void {
    this.fingerprintProvider = provider;
    return () => {
      if (this.fingerprintProvider === provider) this.fingerprintProvider = null;
    };
  }

  /** Null when no editor is open to say what the edit is. */
  currentEditFingerprint(): string | null {
    try {
      return this.fingerprintProvider?.() ?? null;
    } catch {
      return null;
    }
  }

  /** Frames composed from the edit as it is now. The rest are kept only to be reported as stale. */
  currentFrames(): readonly PackagingFrame[] {
    const now = this.currentEditFingerprint();
    return now ? this.framesValue().filter(frame => frame.editFingerprint === now) : [];
  }

  /** The stored understanding, and whether the edit has moved on since it was written. */
  understandingState(): (VideoUnderstanding & { stale: boolean }) | null {
    const stored = this.understandingValue();
    if (!stored) return null;
    const now = this.currentEditFingerprint();
    return { ...stored, stale: !!now && !!stored.editFingerprint && stored.editFingerprint !== now };
  }

  /** Brings back the choice, and the reader's own sheet, from the last time the app ran. */
  private async restoreStyle(): Promise<void> {
    const settings = readSettings();
    if (settings) {
      this.modeValue.set(settings.mode);
      this.selectedId.set(settings.styleId);
    }
    // Never rejects: `ready` is awaited before every style operation, and a
    // storage failure here must cost the reader their saved sheet, not the
    // ability to choose one at all.
    let stored: Awaited<ReturnType<typeof readCustomStyle>> = null;
    try {
      stored = await readCustomStyle();
    } catch {
      stored = null;
    }
    // Something the reader loaded while this was reading wins over the old one.
    if (stored && !this.custom()) {
      this.custom.set({ name: stored.name, blob: stored.blob, url: URL.createObjectURL(stored.blob) });
    } else if (!this.custom() && this.selectedId() === CUSTOM_TAG_STYLE_ID) {
      // The setting outlived the image: fall back rather than show an empty box.
      this.selectedId.set(DEFAULT_TAG_STYLE_ID);
    }
  }

  private remember(): void {
    writeSettings({ mode: this.modeValue(), styleId: this.selectedId() });
  }

  setStyleMode(mode: 'default' | 'ask'): void {
    this.modeValue.set(mode === 'ask' ? 'ask' : 'default');
    this.remember();
  }

  /** Picks one of the shipped sheets, or `custom` when the reader has loaded one. */
  selectStyle(id: string): TagStyleState {
    if (id === CUSTOM_TAG_STYLE_ID) {
      if (!this.custom()) throw this.invalid('No custom tag style has been loaded.');
      this.selectedId.set(CUSTOM_TAG_STYLE_ID);
    } else {
      this.selectedId.set(tagStyleOf(id).id);
    }
    this.stylePath.set(null);
    this.remember();
    return this.tagStyle();
  }

  /**
   * The reader's own sheet. It is kept in the browser's own database rather
   * than in memory, so closing the application does not lose it.
   */
  async setCustomStyleFile(file: File): Promise<TagStyleState> {
    await this.ready;
    const { blob } = await readPackagingImage(file);
    const persisted = await writeCustomStyle({ name: file.name, type: blob.type, blob, savedAt: Date.now() });
    if (!persisted) throw this.invalid('The style could not be saved. Allow local storage and try again.');

    const previous = this.custom();
    if (previous) URL.revokeObjectURL(previous.url);
    this.custom.set({ name: file.name, blob, url: URL.createObjectURL(blob) });
    return this.selectStyle(CUSTOM_TAG_STYLE_ID);
  }

  /** The same, from a path the assistant supplies over MCP. */
  async setCustomStyleFromPath(path: string): Promise<TagStyleState> {
    const wanted = this.text(path, 'path', 32_768);
    const [file] = await this.desktop.readAgentFiles([wanted]);
    if (!file) throw this.invalid(`${wanted} could not be read.`);
    return this.setCustomStyleFile(file);
  }

  async removeCustomStyle(): Promise<TagStyleState> {
    await this.ready;
    const previous = this.custom();
    if (previous) URL.revokeObjectURL(previous.url);
    this.custom.set(null);
    await clearCustomStyle();
    return this.selectStyle(DEFAULT_TAG_STYLE_ID);
  }

  /** Remembers where the sheet was written so the next call can hand back the same file. */
  rememberTagStylePath(path: string): void {
    this.stylePath.set(path);
  }

  // ------------------------------------------------------------ choosing it

  /** Opens the picker for the reader themselves; nothing is waiting on the answer. */
  openStylePicker(): void {
    if (this.pickerSettle) return;
    this.settlePicker(null);
    this.pickerReason.set('reader');
    this.pickerOpen.set(true);
  }

  /**
   * The style a cover will be drawn in.
   *
   * On `default` it is simply the chosen one. On `ask` the picker is opened and
   * this waits for it, so a packaging run pauses on the reader rather than
   * guessing. A run left unanswered falls back to the chosen style instead of
   * hanging for ever.
   */
  async ensureStyleChosen(timeoutMs = PICKER_TIMEOUT_MS): Promise<TagStyleState> {
    await this.ready;
    if (this.modeValue() !== 'ask') return this.tagStyle();

    this.settlePicker(null);
    this.pickerReason.set('agent');
    this.pickerOpen.set(true);
    const chosen = await new Promise<string | null>((resolve) => {
      this.pickerSettle = resolve;
      this.pickerTimer = window.setTimeout(() => this.settlePicker(null), Math.max(10_000, timeoutMs));
    });
    if (chosen) this.selectStyle(chosen);
    return this.tagStyle();
  }

  /** The reader chose one. Closes the picker and releases whatever was waiting. */
  chooseStyle(id: string): TagStyleState {
    const state = this.selectStyle(id);
    this.settlePicker(id);
    this.pickerOpen.set(false);
    return state;
  }

  /** Closed without choosing: whatever was waiting carries on with the current style. */
  cancelStylePicker(): void {
    this.settlePicker(null);
    this.pickerOpen.set(false);
  }

  private settlePicker(id: string | null): void {
    if (this.pickerTimer) {
      clearTimeout(this.pickerTimer);
      this.pickerTimer = 0;
    }
    const settle = this.pickerSettle;
    this.pickerSettle = null;
    if (settle) {
      settle(id);
      this.pickerOpen.set(false);
    }
  }

  /**
   * The style as bytes, whichever it is.
   *
   * A shipped sheet has no blob because it is served from the app's own assets;
   * it is fetched on the first call and then behaves like any other.
   */
  async tagStyleBytes(): Promise<Blob> {
    await this.ready;
    const current = this.tagStyle();
    if (current.blob) return current.blob;
    const response = await fetch(current.url);
    if (!response.ok) throw this.invalid(`The tag style could not be read (${response.status}).`);
    return response.blob();
  }

  // ---------------------------------------------------------- the deliverables

  /** Internal entry point used by UI code and by the MCP adapter. Omitted fields keep their current values. */
  async apply(input: VideoPackagingInput): Promise<{ thumbnails: number; titles: number; hasDescription: boolean; tags: number }> {
    if (!input || !['thumbnails', 'titles', 'description', 'tags'].some((field) => field in input)) {
      throw this.invalid('Provide at least one of thumbnails, titles, description or tags.');
    }

    // Validate every text field before changing images, so a malformed title
    // cannot leave the user with half of a new delivery.
    if (input.titles !== undefined) {
      this.list(input.titles, 'titles', 3).forEach((value, index) => this.text(value, `titles[${index}]`, 240));
    }
    if (input.description !== undefined) this.text(input.description, 'description', 30_000);
    if (input.tags !== undefined) {
      const tags = typeof input.tags === 'string' ? input.tags.split(',') : input.tags;
      this.list(tags, 'tags', 100).forEach((value, index) => this.text(value, `tags[${index}]`, 120));
    }
    if (input.thumbnails !== undefined) await this.setThumbnails(input.thumbnails);
    if (input.titles !== undefined) this.setTitles(input.titles);
    if (input.description !== undefined) this.setDescription(input.description);
    if (input.tags !== undefined) this.setTags(input.tags);

    return this.summary();
  }

  async setThumbnails(thumbnails: readonly {
    path: string;
    altText?: string;
    sourceTimestamp?: number;
    sourceFramePath?: string;
  }[]): Promise<void> {
    if (!Array.isArray(thumbnails) || thumbnails.length > 3) {
      throw this.invalid('thumbnails must contain at most three image paths.');
    }
    const paths = thumbnails.map((entry, index) => this.text(entry?.path, `thumbnails[${index}].path`, 32_768));
    const current = this.currentFrames();
    for (const [index, entry] of thumbnails.entries()) {
      const at = this.seconds(entry.sourceTimestamp, `thumbnails[${index}].sourceTimestamp`);
      const source = this.text(entry.sourceFramePath, `thumbnails[${index}].sourceFramePath`, 32_768);
      const saved = current.find(frame => samePath(frame.path, source) && frame.composited);
      if (!saved) {
        const earlier = this.framesValue().some(frame => samePath(frame.path, source));
        throw this.invalid(earlier
          ? `Thumbnail ${index + 1} was drawn on a frame saved from an earlier version of the edit. Save the background again with save_frames and redraw the cover.`
          : `Thumbnail ${index + 1} must name, as sourceFramePath, a frame that save_frames wrote for this edit.`);
      }
      if (Math.abs(saved.outputTime - at) > 0.05) {
        throw this.invalid(`Thumbnail ${index + 1}: sourceTimestamp must be that frame's outputTime (${saved.outputTime}s on the finished video), not ${at}s.`);
      }
    }
    const files = paths.length ? await this.desktop.readAgentFiles(paths) : [];
    await this.setThumbnailFiles(files, thumbnails);
  }

  /**
   * Materialises every image before it enters application state.
   *
   * Electron exposes large local media as a lazy File-shaped reference. That
   * is ideal for video decoding, but URL.createObjectURL(File) reads the empty
   * backing store of that wrapper. Covers are small, so keeping their actual
   * bytes is both safe and necessary: preview and Save cover then use the same
   * non-empty Blob.
   */
  async setThumbnailFiles(
    files: readonly File[],
    metadata: readonly {
      altText?: string;
      sourceTimestamp?: number;
      sourceFramePath?: string;
    }[] = []
  ): Promise<void> {
    if (!Array.isArray(files) || files.length > 3) {
      throw this.invalid('files must contain at most three images.');
    }
    const prepared = await Promise.all(files.map(async (file, index) => {
      const { blob, width, height } = await readPackagingImage(file);
      const item = metadata[index] ?? {};
      return {
        blob,
        width,
        height,
        fileName: file.name,
        altText: item.altText?.trim() || `Generated thumbnail ${index + 1}`,
        sourceTimestamp: item.sourceTimestamp === undefined
          ? null
          : this.seconds(item.sourceTimestamp, `thumbnails[${index}].sourceTimestamp`),
        sourceFramePath: item.sourceFramePath === undefined
          ? null
          : this.text(item.sourceFramePath, `thumbnails[${index}].sourceFramePath`, 32_768)
      };
    }));

    for (const current of this.images()) URL.revokeObjectURL(current.url);
    this.images.set(prepared.map(image => ({ ...image, url: URL.createObjectURL(image.blob) })));
  }

  setTitles(titles: readonly string[]): void {
    if (!Array.isArray(titles) || titles.length > 3) throw this.invalid('titles must contain at most three items.');
    this.titles.set(titles.map((title, index) => this.text(title, `titles[${index}]`, 240)));
  }

  setDescription(description: string): void {
    const clean = this.text(description, 'description', 30_000)
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');
    this.descriptionValue.set(clean);
  }

  setTags(tags: readonly string[] | string): void {
    const values = typeof tags === 'string' ? tags.split(',') : tags;
    if (!Array.isArray(values) || values.length > 100) throw this.invalid('tags must contain at most 100 items.');
    this.tagsValue.set(values.map((tag, index) => this.text(tag, `tags[${index}]`, 120)));
  }

  // ------------------------------------------------- what the video is about

  /**
   * Stores the assistant's reading of the video so a second pass is never
   * needed. Every field is optional: a run that only learned the chapters
   * should not have to invent a summary to record them.
   */
  setUnderstanding(input: VideoUnderstandingInput): VideoUnderstanding {
    if (!input || typeof input !== 'object') throw this.invalid('Provide the understanding to store.');
    const current = this.understandingValue();
    const chapters = input.chapters === undefined
      ? current?.chapters ?? []
      : this.list(input.chapters, 'chapters', 200).map((chapter, index) => ({
        start: this.seconds((chapter as { start?: unknown })?.start, `chapters[${index}].start`),
        title: this.text((chapter as { title?: unknown })?.title, `chapters[${index}].title`, 240)
      }));
    const highlights = input.highlights === undefined
      ? current?.highlights ?? []
      : this.list(input.highlights, 'highlights', 200).map((highlight, index) => ({
        clipId: this.text((highlight as { clipId?: unknown })?.clipId, `highlights[${index}].clipId`, 120),
        timestamp: this.seconds((highlight as { timestamp?: unknown })?.timestamp, `highlights[${index}].timestamp`),
        note: this.text((highlight as { note?: unknown })?.note, `highlights[${index}].note`, 1_000)
      }));

    const stored: VideoUnderstanding = {
      summary: input.summary === undefined ? current?.summary ?? '' : this.text(input.summary, 'summary', 20_000),
      topics: input.topics === undefined
        ? current?.topics ?? []
        : this.list(input.topics, 'topics', 100).map((topic, index) => this.text(topic, `topics[${index}]`, 200)),
      chapters,
      highlights,
      language: input.language === undefined
        ? current?.language ?? ''
        : this.text(input.language, 'language', 40),
      updatedAt: Date.now(),
      editFingerprint: this.currentEditFingerprint()
    };
    this.understandingValue.set(stored);
    return stored;
  }

  clearUnderstanding(): void {
    this.understandingValue.set(null);
  }

  // --------------------------------------------------- the cover backgrounds

  /** Recorded by the editor after it writes frames to disk, so a later run reuses them. */
  recordFrames(frames: readonly PackagingFrame[]): void {
    const kept = new Map<string, PackagingFrame>();
    for (const frame of [...this.framesValue(), ...frames]) kept.set(frame.path, frame);
    this.framesValue.set([...kept.values()].slice(-64));
  }

  clearFrames(): void {
    this.framesValue.set([]);
  }

  // -------------------------------------------------------------------- state

  clear(): void {
    for (const current of this.images()) URL.revokeObjectURL(current.url);
    this.images.set([]);
    this.titles.set([]);
    this.descriptionValue.set('');
    this.tagsValue.set([]);
  }

  snapshot(): unknown {
    const understanding = this.understandingValue();
    const style = this.tagStyle();
    return {
      thumbnails: this.images().map((image, index) => ({
        position: index + 1,
        fileName: image.fileName,
        altText: image.altText,
        byteLength: image.blob.size,
        width: image.width,
        height: image.height,
        decoded: true,
        sourceTimestamp: image.sourceTimestamp,
        sourceFramePath: image.sourceFramePath
      })),
      titles: [...this.titles()],
      description: this.descriptionValue(),
      tags: [...this.tagsValue()],
      understanding: understanding ? this.understandingState() : null,
      frames: this.framesValue().map((frame) => ({ ...frame, stale: !this.currentFrames().includes(frame) })),
      tagStyle: { source: style.source, id: style.id, name: style.name, path: style.path, mode: this.modeValue() },
      counts: this.summary()
    };
  }

  private summary(): { thumbnails: number; titles: number; hasDescription: boolean; tags: number } {
    return {
      thumbnails: this.images().length,
      titles: this.titles().length,
      hasDescription: !!this.descriptionValue(),
      tags: this.tagsValue().length
    };
  }

  private list(value: unknown, field: string, maxLength: number): readonly unknown[] {
    if (!Array.isArray(value)) throw this.invalid(`${field} must be an array.`);
    if (value.length > maxLength) throw this.invalid(`${field} must contain at most ${maxLength} items.`);
    return value;
  }

  private seconds(value: unknown, field: string): number {
    const time = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(time) || time < 0) throw this.invalid(`${field} must be a number of seconds.`);
    return Math.round(time * 1000) / 1000;
  }

  private text(value: unknown, field: string, maxLength: number): string {
    if (typeof value !== 'string' || !value.trim()) throw this.invalid(`${field} must be a non-empty string.`);
    const clean = value.trim();
    if (clean.length > maxLength) throw this.invalid(`${field} exceeds ${maxLength} characters.`);
    return clean;
  }

  private mimeFromName(name: string): string {
    const extension = name.split('.').pop()?.toLowerCase();
    if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
    if (extension === 'webp') return 'image/webp';
    if (extension === 'gif') return 'image/gif';
    return extension === 'png' ? 'image/png' : 'application/octet-stream';
  }

  private invalid(message: string): Error {
    return Object.assign(new Error(message), { code: 'invalid_arguments' });
  }
}

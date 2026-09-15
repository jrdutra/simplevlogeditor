/**
 * Remembering *which* files a project was made of, so it can open them itself.
 *
 * A project kept in the browser comes back complete and empty-handed: every
 * cut, every caption and every setting survives a reload, and not one byte of
 * media does, because a page is not allowed to reopen a file on its own. The
 * reader is then asked to find the same nine files again — which is the single
 * most tedious thing this tool has ever asked anybody to do.
 *
 * A browser with the File System Access API can do better. A file dragged onto
 * the page, or chosen through `showOpenFilePicker`, comes with a *handle* — a
 * durable reference that can be stored in IndexedDB and used later to reopen
 * the same file from disk, once the reader has said yes once. So the handles
 * are kept here, keyed exactly the way the project document identifies a file,
 * and a restored project asks for them back before it asks the reader for
 * anything.
 *
 * Everything degrades quietly. Firefox and Safari have no handles to give, the
 * permission can be refused, and a file can have been moved or deleted since —
 * in each case this answers with nothing and the reader is asked to add the
 * files by hand, which is exactly what happened before any of this existed.
 */

const DATABASE = 'utily-video-editor';
const STORE = 'file-handles';
const VERSION = 1;

/** How a file is recognised again: the same two fields the project document uses. */
export function handleKey(ref: { name: string; size: number }): string {
  return `${ref.name}:${ref.size}`;
}

/** The slice of the API this module uses, so nothing here depends on lib.dom's version of it. */
interface FileHandleLike {
  kind: string;
  getFile(): Promise<File>;
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface ItemWithHandle extends DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileHandleLike | null>;
}

export type StoredHandle = FileHandleLike;

interface PickerWindow {
  showOpenFilePicker?(options: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: { description: string; accept: Record<string, string[]> }[];
  }): Promise<FileHandleLike[]>;
}

/** True when the reader can be given a picker that hands back handles. */
export function pickerSupported(): boolean {
  return typeof window !== 'undefined' &&
    typeof (window as unknown as PickerWindow).showOpenFilePicker === 'function';
}

/**
 * True when this browser can hand out durable references to a file at all.
 *
 * Two doors, not one. Dropping a file was the only one of these for a while,
 * which quietly meant that everybody who used the button instead of dragging —
 * most people — had a project that could never reopen itself, and no way to
 * tell that the two gestures were not the same gesture.
 */
export function handlesSupported(): boolean {
  if (typeof indexedDB === 'undefined') return false;
  if (pickerSupported()) return true;

  return typeof DataTransferItem !== 'undefined' &&
    'getAsFileSystemHandle' in DataTransferItem.prototype;
}

/** The extensions the picker offers, grouped the way the dialog wants them. */
const PICKER_TYPES = [
  {
    description: 'Video, audio and images',
    accept: {
      'video/*': ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'],
      'audio/*': ['.m4a', '.mp3', '.wav', '.aac', '.ogg', '.oga', '.opus', '.flac'],
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']
    }
  }
];

/**
 * Opens the file picker that comes with handles attached.
 *
 * `null` means this browser has no such picker and the caller should fall back
 * to its hidden `<input type="file">`, which works everywhere and remembers
 * nothing. An empty result means the reader closed the dialog, which is not the
 * same thing and must not reopen anything.
 */
export async function pickFilesWithHandles(
  multiple = true
): Promise<{ files: File[]; handles: Map<string, StoredHandle> } | null> {
  const picker = (window as unknown as PickerWindow).showOpenFilePicker;
  if (typeof picker !== 'function') return null;

  let picked: FileHandleLike[];
  try {
    picked = await picker.call(window, { multiple, types: PICKER_TYPES, excludeAcceptAllOption: false });
  } catch {
    // `AbortError` when the dialog is closed, and anything else a browser
    // decides to throw. Either way the reader chose nothing, which is a result
    // rather than a failure.
    return { files: [], handles: new Map() };
  }

  const files: File[] = [];
  const handles = new Map<string, StoredHandle>();

  for (const handle of picked) {
    if (handle.kind !== 'file') continue;
    try {
      const file = await handle.getFile();
      files.push(file);
      handles.set(handleKey(file), handle);
    } catch {
      /* Chosen and then moved, between the dialog closing and this line. */
    }
  }

  // `showOpenFilePicker` fires no change event, so the one document-level
  // listener that notices chosen files cannot see these. Told here instead, so
  // that picking a file through this dialog allows its folder like any other.
  if (files.length) notifyChosen?.(files);

  return { files, handles };
}

type ChosenListener = (files: readonly File[]) => void;
let notifyChosen: ChosenListener | null = null;

/** Set once by the desktop shell; a browser tab leaves it null. */
export function onFilesChosenThroughPicker(listener: ChosenListener | null): void {
  notifyChosen = listener;
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);

  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // A browser in private mode, or one that has run out of room, simply has no
    // database. That is not an error worth telling anybody about: the reader
    // adds their files by hand, as they always did.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return open().then(
    (database) =>
      new Promise<T | null>((resolve) => {
        if (!database) {
          resolve(null);
          return;
        }

        try {
          const transaction = database.transaction(STORE, mode);
          const request = work(transaction.objectStore(STORE));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => resolve(null);
          transaction.oncomplete = () => database.close();
        } catch {
          database.close();
          resolve(null);
        }
      })
  );
}

/** Keeps a reference to one file, if this browser gave us one to keep. */
export async function rememberHandle(file: File, handle: StoredHandle | null): Promise<void> {
  if (!handle) return;
  await run('readwrite', (store) => store.put(handle, handleKey(file)));
}

/** The reference kept for a file the project is waiting for, or null. */
export async function recallHandle(ref: { name: string; size: number }): Promise<StoredHandle | null> {
  const stored = await run<StoredHandle>('readonly', (store) => store.get(handleKey(ref)));
  return stored && typeof stored.getFile === 'function' ? stored : null;
}

/**
 * The reference kept for a file we only know the name of.
 *
 * A soundtrack comes back from the document as a zero-byte stand-in, so the
 * size half of the key is gone and the exact lookup cannot find it. Scanning the
 * keys for the name is the price of that, and the store holds one entry per file
 * the reader has ever added to this project rather than per file on their disk.
 */
export async function recallHandleByName(name: string): Promise<StoredHandle | null> {
  const keys = await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  if (!keys) return null;

  const prefix = `${name}:`;
  const match = keys.find((key) => typeof key === 'string' && key.startsWith(prefix));
  if (typeof match !== 'string') return null;

  const stored = await run<StoredHandle>('readonly', (store) => store.get(match));
  return stored && typeof stored.getFile === 'function' ? stored : null;
}

/**
 * Keeps a reference under a name the caller chose, rather than under the file's.
 *
 * The ordinary key is `name:size`, which is what a project document already
 * knows about a file and is enough to find it again. A settings file needs
 * something sturdier: it is meant to be opened weeks later, and by then the
 * soundtrack may have been renamed, re-encoded or moved — any of which changes
 * that key while the handle itself still opens exactly the right file, because
 * a handle follows the file rather than its name.
 *
 * This is as close as a browser gets to writing a path into the document. The
 * document carries the id; the browser carries the reference the id points at.
 */
export async function rememberHandleAs(id: string, handle: StoredHandle | null): Promise<void> {
  if (!handle || !id) return;
  await run('readwrite', (store) => store.put(handle, `id:${id}`));
}

/** The reference kept under {@link rememberHandleAs}, or null. */
export async function recallHandleById(id: string): Promise<StoredHandle | null> {
  if (!id) return null;
  const stored = await run<StoredHandle>('readonly', (store) => store.get(`id:${id}`));
  return stored && typeof stored.getFile === 'function' ? stored : null;
}

/** A key for a reference this tool is about to keep. */
export function newHandleId(): string {
  return `snd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function forgetHandles(): Promise<void> {
  await run('readwrite', (store) => store.clear());
}

/**
 * The file behind a stored reference, or null.
 *
 * `ask` is the difference between the two moments this is called at. On a
 * reload nothing may be asked of the reader — a permission prompt that appears
 * because a page loaded is a prompt people click away without reading — so the
 * permission is only *queried*, and a project whose files are still granted
 * reconnects itself with nothing said. When the reader presses the button, the
 * prompt is theirs to expect and permission is requested properly.
 */
export async function fileFromHandle(handle: StoredHandle, ask: boolean): Promise<File | null> {
  try {
    const mode = { mode: 'read' } as const;
    let state: PermissionState = (await handle.queryPermission?.(mode)) ?? 'granted';
    if (state === 'prompt' && ask) state = (await handle.requestPermission?.(mode)) ?? 'denied';
    if (state !== 'granted') return null;

    return await handle.getFile();
  } catch {
    // Moved, renamed, deleted, or on a drive that is no longer mounted.
    return null;
  }
}

/**
 * The handles behind a drop, paired with the files they belong to.
 *
 * Reading `items` has to happen synchronously, before the first `await`: a
 * `DataTransfer` is emptied the moment the event handler yields, and a handle
 * asked for afterwards comes back null with no explanation.
 */
export function handlesFromDrop(transfer: DataTransfer | null): Promise<Map<string, StoredHandle>> {
  const empty = new Map<string, StoredHandle>();
  if (!transfer || !handlesSupported()) return Promise.resolve(empty);

  const pending: Promise<FileHandleLike | null>[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== 'file') continue;
    const withHandle = item as ItemWithHandle;
    if (typeof withHandle.getAsFileSystemHandle !== 'function') continue;
    pending.push(withHandle.getAsFileSystemHandle().catch(() => null));
  }

  if (!pending.length) return Promise.resolve(empty);

  return Promise.all(pending).then(async (handles) => {
    const found = new Map<string, StoredHandle>();

    for (const handle of handles) {
      if (!handle || handle.kind !== 'file') continue;
      try {
        const file = await handle.getFile();
        found.set(handleKey(file), handle);
      } catch {
        /* A directory, or something the browser will not open. */
      }
    }

    return found;
  });
}

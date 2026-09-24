/**
 * What the reader chose, kept across restarts.
 *
 * Two different things are remembered, in the two places that suit them: the
 * small settings (which style, and whether to be asked each time) go in
 * `localStorage`, and the reader's own uploaded sheet — which is an image and
 * has no business in a string store — goes in IndexedDB. Both are per-origin
 * and the desktop app has a stable one, so a style loaded once is still there
 * after the application is closed and opened again.
 *
 * Everything here fails quietly. A browser with storage switched off is a
 * browser that forgets the choice, not one where the tool stops working.
 */

const SETTINGS_KEY = 'sve.video-packaging.tag-style';
const DATABASE = 'sve-video-packaging';
const STORE = 'tag-style';
const CUSTOM_KEY = 'custom';

export interface TagStyleSettings {
  /** `default` uses `styleId` every time; `ask` opens the picker before covers are drawn. */
  mode: 'default' | 'ask';
  /** A catalogue id, or `custom` for the reader's own sheet. */
  styleId: string;
}

export interface StoredCustomStyle {
  name: string;
  type: string;
  blob: Blob;
  savedAt: number;
}

export function readSettings(): TagStyleSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TagStyleSettings>;
    const mode = parsed.mode === 'ask' ? 'ask' : 'default';
    const styleId = typeof parsed.styleId === 'string' && parsed.styleId ? parsed.styleId : '';
    return styleId ? { mode, styleId } : null;
  } catch {
    return null;
  }
}

export function writeSettings(settings: TagStyleSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // A full or disabled store is not a reason to refuse the choice itself.
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, 1);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function readCustomStyle(): Promise<StoredCustomStyle | null> {
  const database = await openDatabase();
  if (!database) return null;
  try {
    return await new Promise<StoredCustomStyle | null>((resolve) => {
      // transaction() throws synchronously on a store that is missing or a
      // database that is closing; inside the executor that would reject the
      // promise, and a rejected restore would poison every later await.
      try {
        const request = database.transaction(STORE, 'readonly').objectStore(STORE).get(CUSTOM_KEY);
        request.onsuccess = () => {
          const value = request.result as StoredCustomStyle | undefined;
          resolve(value && value.blob instanceof Blob && value.blob.size > 0 ? value : null);
        };
        request.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  } finally {
    database.close();
  }
}

export async function writeCustomStyle(style: StoredCustomStyle): Promise<boolean> {
  const database = await openDatabase();
  if (!database) return false;
  try {
    return await new Promise<boolean>((resolve) => {
      try {
        const transaction = database.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(style, CUSTOM_KEY);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => resolve(false);
        transaction.onabort = () => resolve(false);
      } catch {
        // Quota, a blob the store cannot clone, a database being deleted.
        resolve(false);
      }
    });
  } finally {
    database.close();
  }
}

export async function clearCustomStyle(): Promise<void> {
  const database = await openDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve) => {
      try {
        const transaction = database.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).delete(CUSTOM_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  } finally {
    database.close();
  }
}

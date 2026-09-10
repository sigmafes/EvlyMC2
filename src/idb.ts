/**
 * Shared IndexedDB handle for EvlyMC. Both the chunk-edit store and the
 * block-data store live in one database so there is a single schema version to
 * bump. Opening the same name at different versions from two places is the
 * classic IndexedDB footgun; this keeps it in one place.
 */

const DB_NAME = 'evlymc';
const DB_VERSION = 2;
export const STORE_CHUNK_EDITS = 'chunkEdits';
export const STORE_BLOCK_DATA = 'blockData';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openEvlymcDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHUNK_EDITS)) {
        db.createObjectStore(STORE_CHUNK_EDITS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOCK_DATA)) {
        db.createObjectStore(STORE_BLOCK_DATA, { keyPath: 'key' });
      }
    };
    req.onblocked = () => {
      // Another tab is still on the old schema; resolves once it closes.
      console.warn('evlymc DB upgrade blocked by another tab');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // If the open fails, let a later caller try again.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/** Delete every record whose key starts with `${seed}:` from one store. */
export async function deleteSeedFromStore(store: string, seed: number): Promise<void> {
  try {
    const db = await openEvlymcDb();
    const prefix = `${seed}:`;
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const keysReq = os.getAllKeys();
    await new Promise<void>((resolve, reject) => {
      keysReq.onsuccess = () => {
        for (const k of keysReq.result as IDBValidKey[]) {
          if (typeof k === 'string' && k.startsWith(prefix)) os.delete(k);
        }
        resolve();
      };
      keysReq.onerror = () => reject(keysReq.error);
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    // IndexedDB unavailable — nothing persisted to clear.
  }
}

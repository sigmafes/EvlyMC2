import { openEvlymcDb, deleteSeedFromStore, STORE_DROPPED_ITEMS } from './idb';

export type DroppedItemRecord = { id: number; count: number; x: number; y: number; z: number; age: number };

/**
 * Persists the ground-item entity list as one blob per seed. Positions change
 * every frame under physics, so tracking each item key-by-key like block edits
 * would mean constant writes; the whole list is snapshotted together instead,
 * on a slow periodic timer plus on unload/tab-hide.
 */
export class DroppedItemsStore {
  private db: IDBDatabase | null = null;

  constructor(private readonly seed: number) {}

  async load(): Promise<DroppedItemRecord[]> {
    try {
      const db = await openEvlymcDb();
      this.db = db;
      const tx = db.transaction(STORE_DROPPED_ITEMS, 'readonly');
      const req = tx.objectStore(STORE_DROPPED_ITEMS).get(`${this.seed}`);
      const rec = await new Promise<{ key: string; items: DroppedItemRecord[] } | undefined>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return rec?.items ?? [];
    } catch {
      return []; // IndexedDB unavailable -> nothing to restore.
    }
  }

  async save(items: DroppedItemRecord[]): Promise<void> {
    try {
      if (!this.db) this.db = await openEvlymcDb();
      const tx = this.db.transaction(STORE_DROPPED_ITEMS, 'readwrite');
      tx.objectStore(STORE_DROPPED_ITEMS).put({ key: `${this.seed}`, items });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // Best-effort; the next periodic save (or the final flush) retries.
    }
  }

  static deleteSeed(seed: number): Promise<void> {
    return deleteSeedFromStore(STORE_DROPPED_ITEMS, seed);
  }
}

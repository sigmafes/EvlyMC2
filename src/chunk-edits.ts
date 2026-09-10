import { BlockId } from './block';
import { CHUNK_SIZE } from './chunk';
import { openEvlymcDb, deleteSeedFromStore, STORE_CHUNK_EDITS } from './idb';

type ChunkKey = string; // "cx,cz"

/** Local block index inside a chunk, matching Chunk.index(). */
function localIndex(x: number, y: number, z: number, minX: number, minZ: number): number {
  return (y * CHUNK_SIZE + (z - minZ)) * CHUNK_SIZE + (x - minX);
}

function chunkCoord(v: number): number {
  return Math.floor((v + 8) / CHUNK_SIZE);
}

const STORE = STORE_CHUNK_EDITS;
const SAVE_DEBOUNCE_MS = 1500;

/**
 * Player-made block changes (place/break), keyed by chunk. Applied on top of the
 * deterministic generation so builds survive chunk unload and page reload.
 * Only edits from World.add / World.remove are stored — simulation engines
 * (water/lava/fire) recompute their state and are not persisted.
 */
export class ChunkEditStore {
  private readonly mem = new Map<ChunkKey, Map<number, BlockId>>();
  private readonly dirty = new Set<ChunkKey>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private db: IDBDatabase | null = null;

  constructor(private readonly seed: number) {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { void this.flush(); });
      // Fires when the tab is hidden/backgrounded — more reliable than beforeunload.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush();
      });
    }
  }

  /** Read all persisted edits for this seed into memory. Await before loading chunks. */
  async load(): Promise<void> {
    try {
      this.db = await this.openDb();
      const prefix = `${this.seed}:`;
      const records = await this.readAll();
      for (const rec of records) {
        if (!rec.key.startsWith(prefix)) continue;
        const chunkKey = rec.key.slice(prefix.length);
        this.mem.set(chunkKey, new Map(rec.entries));
      }
    } catch {
      // IndexedDB unavailable (private mode, etc.) -> in-memory only.
    }
  }

  /** Record a player edit. `id` is the new block (BlockId.AIR for a break). */
  record(x: number, y: number, z: number, id: BlockId) {
    const cx = chunkCoord(x);
    const cz = chunkCoord(z);
    const key = `${cx},${cz}`;
    const minX = cx * CHUNK_SIZE - 8;
    const minZ = cz * CHUNK_SIZE - 8;

    let edits = this.mem.get(key);
    if (!edits) {
      edits = new Map();
      this.mem.set(key, edits);
    }
    edits.set(localIndex(x, y, z, minX, minZ), id);
    this.dirty.add(key);
    this.scheduleSave();
  }

  /** Edits for a chunk (local index -> BlockId), or undefined. */
  get(cx: number, cz: number): Map<number, BlockId> | undefined {
    return this.mem.get(`${cx},${cz}`);
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush(); }, SAVE_DEBOUNCE_MS);
  }

  /** Persist every dirty chunk now. */
  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    try {
      if (!this.db) this.db = await this.openDb();
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const chunkKey of keys) {
        const edits = this.mem.get(chunkKey);
        if (!edits || edits.size === 0) continue;
        store.put({ key: `${this.seed}:${chunkKey}`, entries: [...edits] });
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      // couldn't persist; keep the keys dirty for the next attempt
      for (const k of keys) this.dirty.add(k);
    }
  }

  private openDb(): Promise<IDBDatabase> {
    return openEvlymcDb();
  }

  /** Wipe every persisted edit belonging to a world seed (used when a world is deleted). */
  static deleteSeed(seed: number): Promise<void> {
    return deleteSeedFromStore(STORE, seed);
  }

  private readAll(): Promise<{ key: string; entries: [number, BlockId][] }[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }
}

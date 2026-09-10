import { openEvlymcDb, deleteSeedFromStore, STORE_BLOCK_DATA } from './idb';

/**
 * Extra per-block state that a single BlockId can't carry: which way an
 * orientable block faces, and whether a machine is running. Kept in a sparse
 * side table (only blocks that actually need it get an entry) and persisted to
 * IndexedDB, keyed by seed + world position, mirroring ChunkEditStore.
 *
 * `facing`: 0 = +Z (south), 1 = +X (east), 2 = -Z (north), 3 = -X (west).
 */
export type BlockData = {
  facing?: 0 | 1 | 2 | 3;
  lit?: boolean;
};

const STORE = STORE_BLOCK_DATA;
const SAVE_DEBOUNCE_MS = 1500;
const posKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Which cube face (mesher face index) a `facing` value points at. */
export const FACING_TO_FACE_INDEX: Record<number, number> = { 0: 4, 1: 0, 2: 5, 3: 1 };

/**
 * Cardinal `facing` (0..3) whose face points back toward a player looking along
 * `yaw`. Used so a placed furnace's front (off) face looks at the player.
 * Player forward at yaw is (-sin yaw, 0, -cos yaw); the front normal is its
 * negation, snapped to the dominant axis.
 */
export function facingTowardPlayer(yaw: number): 0 | 1 | 2 | 3 {
  const nx = Math.sin(yaw);
  const nz = Math.cos(yaw);
  if (Math.abs(nx) > Math.abs(nz)) return nx > 0 ? 1 : 3;
  return nz > 0 ? 0 : 2;
}

export class BlockDataStore {
  private readonly mem = new Map<string, BlockData>();
  private readonly dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private db: IDBDatabase | null = null;

  constructor(private readonly seed: number) {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => { void this.flush(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void this.flush();
      });
    }
  }

  /** Read this seed's block data into memory. Await before chunks are meshed. */
  async load(): Promise<void> {
    try {
      this.db = await openEvlymcDb();
      const prefix = `${this.seed}:`;
      const records = await this.readAll();
      for (const rec of records) {
        if (!rec.key.startsWith(prefix)) continue;
        this.mem.set(rec.key.slice(prefix.length), rec.data);
      }
    } catch {
      // IndexedDB unavailable -> in-memory only.
    }
  }

  get(x: number, y: number, z: number): BlockData | undefined {
    return this.mem.get(posKey(x, y, z));
  }

  /** Merge `patch` into the block's data (creates the entry if missing). */
  set(x: number, y: number, z: number, patch: BlockData): void {
    const key = posKey(x, y, z);
    this.mem.set(key, { ...this.mem.get(key), ...patch });
    this.dirty.add(key);
    this.scheduleSave();
  }

  delete(x: number, y: number, z: number): void {
    const key = posKey(x, y, z);
    if (!this.mem.has(key)) return;
    this.mem.delete(key);
    this.dirty.add(key);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.flush(); }, SAVE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty.size === 0) return;
    const keys = [...this.dirty];
    this.dirty.clear();
    try {
      if (!this.db) this.db = await openEvlymcDb();
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const k of keys) {
        const data = this.mem.get(k);
        if (data) store.put({ key: `${this.seed}:${k}`, data });
        else store.delete(`${this.seed}:${k}`);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      for (const k of keys) this.dirty.add(k);
    }
  }

  static deleteSeed(seed: number): Promise<void> {
    return deleteSeedFromStore(STORE, seed);
  }

  private readAll(): Promise<{ key: string; data: BlockData }[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  }
}

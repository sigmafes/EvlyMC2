import type { InventorySlot } from './inventory';

/**
 * Per-world save of the player's own data (position, look angles, inventory).
 * Block edits live in IndexedDB (ChunkEditStore); this is small, so localStorage.
 */
export interface PlayerSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  selectedIndex: number;
  slots: InventorySlot[];
  /** Day/night cycle position in seconds. */
  dayTime?: number;
}

const key = (worldId: string) => `evlymc-player:${worldId}`;

export function loadPlayerSave(worldId: string): PlayerSave | null {
  try {
    const raw = localStorage.getItem(key(worldId));
    if (!raw) return null;
    const data = JSON.parse(raw) as PlayerSave;
    if (typeof data?.x !== 'number' || !Array.isArray(data.slots)) return null;
    return data;
  } catch {
    return null;
  }
}

export function savePlayerSave(worldId: string, save: PlayerSave): void {
  try {
    localStorage.setItem(key(worldId), JSON.stringify(save));
  } catch {
    /* private mode / quota */
  }
}

export function deletePlayerSave(worldId: string): void {
  try {
    localStorage.removeItem(key(worldId));
  } catch {
    /* ignore */
  }
}

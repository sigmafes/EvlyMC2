import { ChunkEditStore } from './chunk-edits';
import { deletePlayerSave } from './player-store';

export const EVLYMC_VERSION = '0.1.0';

export type GameMode = 'Survival' | 'Creative';

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  mode: GameMode;
  cheats: boolean;
  version: string;
  createdAt: number;
  lastPlayed: number;
}

const KEY = 'evlymc-worlds';
export const SEED_KEY = 'evlymc-world-seed';
export const ACTIVE_WORLD_KEY = 'evlymc-active-world';

export function randomSeed(): number {
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
}

function makeId(): string {
  return `w_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** All saved worlds, most-recently-played first. */
export function loadWorlds(): WorldMeta[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as WorldMeta[];
    if (!Array.isArray(list)) return [];
    return list.slice().sort((a, b) => b.lastPlayed - a.lastPlayed);
  } catch {
    return [];
  }
}

export function saveWorlds(list: WorldMeta[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

/** Pick "New World", then "New World (1)", "New World (2)"… avoiding existing names. */
export function nextWorldName(list: WorldMeta[], base = 'New World'): string {
  const taken = new Set(list.map((w) => w.name));
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function createWorld(partial: Partial<WorldMeta> = {}): WorldMeta {
  const list = loadWorlds();
  const now = Date.now();
  const world: WorldMeta = {
    id: makeId(),
    name: partial.name ?? nextWorldName(list),
    seed: partial.seed ?? randomSeed(),
    mode: partial.mode ?? 'Survival',
    cheats: partial.cheats ?? false,
    version: partial.version ?? EVLYMC_VERSION,
    createdAt: now,
    lastPlayed: now,
  };
  list.push(world);
  saveWorlds(list);
  return world;
}

export function updateWorld(id: string, patch: Partial<WorldMeta>): void {
  const list = loadWorlds();
  const i = list.findIndex((w) => w.id === id);
  if (i === -1) return;
  list[i] = { ...list[i], ...patch, id: list[i].id };
  saveWorlds(list);
}

export function deleteWorld(id: string): void {
  const list = loadWorlds();
  const world = list.find((w) => w.id === id);
  if (!world) return;
  saveWorlds(list.filter((w) => w.id !== id));
  deletePlayerSave(id);
  // Only wipe the seed's edits if no other world reuses it.
  if (!list.some((w) => w.id !== id && w.seed === world.seed)) {
    void ChunkEditStore.deleteSeed(world.seed);
  }
}

/** Mark a world as the one to load and bump its play time. */
export function activateWorld(world: WorldMeta): void {
  updateWorld(world.id, { lastPlayed: Date.now() });
  try {
    localStorage.setItem(SEED_KEY, String(world.seed));
    localStorage.setItem(ACTIVE_WORLD_KEY, world.id);
  } catch {
    /* private mode */
  }
}

/** The world last activated for play, if it still exists. */
export function activeWorld(): WorldMeta | undefined {
  try {
    const id = localStorage.getItem(ACTIVE_WORLD_KEY);
    if (!id) return undefined;
    return loadWorlds().find((w) => w.id === id);
  } catch {
    return undefined;
  }
}

/** "13/07/2022, 1:31 pm" */
export function formatStamp(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const ampm = d.getHours() < 12 ? 'am' : 'pm';
  let h = d.getHours() % 12;
  if (h === 0) h = 12;
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy}, ${h}:${min} ${ampm}`;
}

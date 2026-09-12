import * as THREE from 'three';
import { BlockId, isSolidBlock } from './block';
import { WATER_LEVEL, CHUNK_SIZE } from './chunk';
import type { World } from './world';
import type { PlayerController } from './player';
import type { MobManager, MobKind, MobSpec } from './mob-manager';
import type { DayNightCycle } from './day-night-cycle';
import type { LightEngine } from './light-engine';
import { PIG_SPEC } from './pig-model';
import { COW_SPEC } from './cow-model';
import { SHEEP_SPEC } from './sheep-model';
import { ZOMBIE_SPEC } from './zombie-model';
import { SKELETON_SPEC } from './skeleton-model';

export const MOB_SPECS: Record<MobKind, MobSpec> = {
  pig: PIG_SPEC, cow: COW_SPEC, sheep: SHEEP_SPEC, zombie: ZOMBIE_SPEC, skeleton: SKELETON_SPEC,
};

// --- Mob spawning: three fixed-size populations (6 animals, 6 surface
// hostiles, 4 cave hostiles), each with independent "slots". Each slot holds
// at most one mob id; when that mob dies or wanders outside the currently-
// loaded chunks, the slot goes on its own 30s cooldown before trying to fill
// again. No global caps/timers - cheap either way (16 slots, checked once a
// frame). Animals/surface hostiles spawn within a fixed 3x3-chunk area
// centred on the player, independent of render distance (SPAWN_AREA_RADIUS_BLOCKS
// below); cave hostiles always try a fixed 10-block radius regardless of
// lighting - only actually lighting the area (raw light > 3) stops them.
const MOB_KINDS: MobKind[] = ['pig', 'cow', 'sheep'];
const HOSTILE_SPAWN_KINDS: MobKind[] = ['zombie', 'skeleton'];
const RESPAWN_COOLDOWN = 30; // seconds, individual per slot
const AMBIENT_SPAWN_MIN_RADIUS = 10; // animals/surface hostiles: stay out of the player's immediate view so they don't visibly pop in
// Animals/surface hostiles spawn within a fixed 3x3-chunk area centred on the
// player, independent of render distance - a low render distance shouldn't
// shrink their spawn area, and a high one shouldn't let them pop in far out
// of sight either.
const SPAWN_AREA_RADIUS_BLOCKS = Math.floor(CHUNK_SIZE * 1.5); // half-width of a 3x3 chunk block
const CAVE_SPAWN_RADIUS = 10; // fixed, not a range - "si o si en el radio 10"
const CAVE_LIGHT_MAX = 3; // raw light level a cave column must be at/under to qualify
const SURFACE_LIGHT_MAX = 4; // sky exposure a night surface column must be at/under (day/night-cycle.ts's nightSkyDarken=11 floors an exposed column at 15-11)

type SpawnSlot = { mobId: number | null; cooldown: number };

export type MobSpawningDeps = {
  world: World;
  player: PlayerController;
  mobManager: MobManager;
  dayNightCycle: DayNightCycle;
  lightEngine: LightEngine;
};

export type MobSpawning = {
  update(delta: number): void;
  /** Human-readable per-population slot state (mobstatus chat command). */
  debugStatus(): string[];
};

export function createMobSpawning(deps: MobSpawningDeps): MobSpawning {
  const { world, player, mobManager, dayNightCycle, lightEngine } = deps;

  const animalSlots: SpawnSlot[] = Array.from({ length: 6 }, () => ({ mobId: null, cooldown: 0 }));
  const surfaceHostileSlots: SpawnSlot[] = Array.from({ length: 6 }, () => ({ mobId: null, cooldown: 0 }));
  const caveHostileSlots: SpawnSlot[] = Array.from({ length: 4 }, () => ({ mobId: null, cooldown: 0 }));

  /** True if (x,gy,z) is generated grass with two clear blocks above - a valid spot for a passive mob to stand. */
  function isValidMobSpawnColumn(x: number, gy: number, z: number): boolean {
    if (!world.isChunkLoaded(x, z)) return false;
    if (world.getBlock(x, gy, z) !== BlockId.GRASS) return false;
    return !isSolidBlock(world.getBlock(x, gy + 1, z)) && !isSolidBlock(world.getBlock(x, gy + 2, z));
  }

  /** Surface: dark enough (night, not just shaded), solid dry footing, at/above water level, not standing in water. */
  function isValidHostileSurfaceColumn(x: number, gy: number, z: number): boolean {
    if (!world.isChunkLoaded(x, z)) return false;
    if (gy < WATER_LEVEL) return false;
    const ground = world.getBlock(x, gy, z);
    if (ground === BlockId.AIR || ground === BlockId.WATER || ground === BlockId.LAVA) return false;
    if (!isSolidBlock(ground)) return false;
    if (isSolidBlock(world.getBlock(x, gy + 1, z)) || isSolidBlock(world.getBlock(x, gy + 2, z))) return false;
    if (world.getBlock(x, gy + 1, z) === BlockId.WATER || world.getBlock(x, gy + 2, z) === BlockId.WATER) return false;
    return lightEngine.getSkyExposure(x, gy + 1, z) <= SURFACE_LIGHT_MAX;
  }

  /**
   * Underground: standable column, dim enough (raw light <= CAVE_LIGHT_MAX - a
   * nearby torch pushes it over and blocks the spawn). Depth is judged relative
   * to the LOCAL surface height (baked into how the caller picks `y`, always a
   * few blocks under that column's own terrain), not the world's absolute
   * WATER_LEVEL - a cave cut into a mountain at y=100 is just as "underground"
   * as one at y=40, even though 100 >= WATER_LEVEL (63).
   */
  function isValidHostileCaveColumn(x: number, y: number, z: number): boolean {
    if (!world.isChunkLoaded(x, z)) return false;
    if (!isSolidBlock(world.getBlock(x, y, z))) return false;
    if (isSolidBlock(world.getBlock(x, y + 1, z)) || isSolidBlock(world.getBlock(x, y + 2, z))) return false;
    if (world.getBlock(x, y + 1, z) === BlockId.WATER || world.getBlock(x, y + 2, z) === BlockId.WATER) return false;
    return lightEngine.getRawBrightness(x, y + 1, z) <= CAVE_LIGHT_MAX;
  }

  /** Random point within the player's currently-loaded chunks (view radius), for animals/surface hostiles. */
  function trySpawnAnimal(): number | null {
    const p = player.state.position;
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = AMBIENT_SPAWN_MIN_RADIUS + Math.random() * (SPAWN_AREA_RADIUS_BLOCKS - AMBIENT_SPAWN_MIN_RADIUS);
      const gx = Math.round(p.x + Math.sin(angle) * radius);
      const gz = Math.round(p.z + Math.cos(angle) * radius);
      const gy = world.getSurfaceHeight(gx, gz);
      if (!isValidMobSpawnColumn(gx, gy, gz)) continue;
      const kind = MOB_KINDS[Math.floor(Math.random() * MOB_KINDS.length)];
      return mobManager.spawn(kind, MOB_SPECS[kind], new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  function trySpawnSurfaceHostile(): number | null {
    const p = player.state.position;
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = AMBIENT_SPAWN_MIN_RADIUS + Math.random() * (SPAWN_AREA_RADIUS_BLOCKS - AMBIENT_SPAWN_MIN_RADIUS);
      const gx = Math.round(p.x + Math.sin(angle) * radius);
      const gz = Math.round(p.z + Math.cos(angle) * radius);
      const gy = world.getSurfaceHeight(gx, gz);
      if (gy < WATER_LEVEL || !isValidHostileSurfaceColumn(gx, gy, gz)) continue;
      const kind = HOSTILE_SPAWN_KINDS[Math.floor(Math.random() * HOSTILE_SPAWN_KINDS.length)];
      return mobManager.spawn(kind, MOB_SPECS[kind], new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  function trySpawnCaveHostile(): number | null {
    const p = player.state.position;
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const gx = Math.round(p.x + Math.sin(angle) * CAVE_SPAWN_RADIUS);
      const gz = Math.round(p.z + Math.cos(angle) * CAVE_SPAWN_RADIUS);
      if (!world.isChunkLoaded(gx, gz)) continue;
      const surfaceY = world.getSurfaceHeight(gx, gz);
      const gy = Math.max(1, Math.min(surfaceY - 3, Math.round(p.y) + Math.round((Math.random() - 0.5) * 16)));
      if (!isValidHostileCaveColumn(gx, gy, gz)) continue;
      const kind = HOSTILE_SPAWN_KINDS[Math.floor(Math.random() * HOSTILE_SPAWN_KINDS.length)];
      return mobManager.spawn(kind, MOB_SPECS[kind], new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  /** Frees a slot whose mob died or left the loaded area, ticks its cooldown, and tries a fresh spawn once ready. */
  function updateSpawnSlot(slot: SpawnSlot, delta: number, condition: boolean, trySpawn: () => number | null): void {
    if (slot.mobId !== null) {
      if (!mobManager.isAlive(slot.mobId)) {
        slot.mobId = null;
        slot.cooldown = RESPAWN_COOLDOWN;
        return;
      }
      const pos = mobManager.getPosition(slot.mobId);
      if (pos && !world.isChunkLoaded(Math.round(pos.x), Math.round(pos.z))) {
        mobManager.forceRemove(slot.mobId);
        slot.mobId = null;
        slot.cooldown = RESPAWN_COOLDOWN;
      }
      return;
    }
    if (slot.cooldown > 0) {
      slot.cooldown -= delta;
      return;
    }
    if (!condition) return;
    slot.mobId = trySpawn();
  }

  function update(delta: number): void {
    const isDay = !dayNightCycle.isNight();
    const isNight = dayNightCycle.isNight();
    for (const slot of animalSlots) updateSpawnSlot(slot, delta, isDay, trySpawnAnimal);
    for (const slot of surfaceHostileSlots) updateSpawnSlot(slot, delta, isNight, trySpawnSurfaceHostile);
    for (const slot of caveHostileSlots) updateSpawnSlot(slot, delta, true, trySpawnCaveHostile);
  }

  function describe(slots: SpawnSlot[]): string {
    return slots.map((s) => (s.mobId !== null ? `#${s.mobId}` : s.cooldown > 0 ? `cd ${s.cooldown.toFixed(0)}s` : 'ready')).join(', ');
  }

  function debugStatus(): string[] {
    return [
      `Animals (day): ${describe(animalSlots)}`,
      `Surface hostiles (night): ${describe(surfaceHostileSlots)}`,
      `Cave hostiles (any time): ${describe(caveHostileSlots)}`,
      `isNight=${dayNightCycle.isNight()} viewRadius=${world.viewRadius} chunks`,
    ];
  }

  return { update, debugStatus };
}

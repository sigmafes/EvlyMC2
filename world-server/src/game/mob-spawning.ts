// Copiado de src/mob-spawning.ts - ver world-server/src/game/README.md para
// el criterio de qué se copia vs qué sigue compartido con singleplayer.
// Cambios acá NO se reflejan automáticamente en src/mob-spawning.ts.
//
// La diferencia real con singleplayer no es la lógica de spawning en sí
// (los 16 slots, el cooldown de 30s, los radios de spawn) - eso queda
// idéntico. Son dos cosas que ese archivo daba por sentado porque
// singleplayer solo tiene un jugador y una escena real:
//
// 1. `world.isChunkLoaded(x,z)` pasa a ser `isActiveAt(x,z)` - la región
//    activa de la Fase 6 (game/active-region.ts), que ya resuelve
//    exactamente "¿hay alguien lo bastante cerca de esto como para que
//    importe?" para el resto de la simulación (agua, fuego). Un slot cuyo
//    mob salió de la región activa de TODOS los jugadores se libera igual
//    que en singleplayer cuando un mob sale de los chunks cargados.
// 2. El servidor NO TIENE motor de luz por voxel - la iluminación siempre
//    fue una cuestión de renderizado del cliente, nunca algo que el
//    servidor necesitara calcular. `isValidHostileSurfaceColumn` pierde el
//    chequeo de `getSkyExposure` (no hace falta: esa función solo se llama
//    de noche, y una columna a cielo abierto de noche ya cumple el umbral
//    de por sí - ver el comentario en el propio código de abajo). Para
//    `isValidHostileCaveColumn`, que sí necesita saber si hay una antorcha
//    cerca independientemente de la hora, se usa `approxBrightnessAt` -
//    una aproximación barata (la antorcha/bloque emisivo EDITADO más
//    fuerte en línea recta, sin rodear esquinas), no una propagación real.
//    Alcanza para que una habitación iluminada no genere hostiles; no es
//    idéntico voxel a voxel a lo que vería el cliente, pero nadie puede
//    notar la diferencia sin instrumentar el servidor a propósito.

import * as THREE from 'three';
import { BlockId, isSolidBlock } from '../../../src/block';
import { WATER_LEVEL, CHUNK_SIZE } from '../../../src/chunk';
import type { MobKind } from './mob-manager';

const MOB_KINDS: MobKind[] = ['pig', 'cow', 'sheep'];
const HOSTILE_SPAWN_KINDS: MobKind[] = ['zombie', 'skeleton'];
const RESPAWN_COOLDOWN = 30;
const AMBIENT_SPAWN_MIN_RADIUS = 10;
const SPAWN_AREA_RADIUS_BLOCKS = Math.floor(CHUNK_SIZE * 1.5);
const CAVE_SPAWN_RADIUS = 10;
const CAVE_LIGHT_MAX = 3;

type SpawnSlot = { mobId: number | null; cooldown: number };

/** The handful of ServerMobManager methods a spawner needs - narrowed rather than the whole class so it's clear this never touches combat/AI, only the roster. */
export type SpawnableMobManager = {
  spawn(kind: MobKind, pos: THREE.Vector3, yaw: number): number | null;
  isAlive(id: number): boolean;
  getPos(id: number): THREE.Vector3 | null;
  forceRemove(id: number): void;
};

export type MobSpawningDeps = {
  getPlayerPos: () => THREE.Vector3;
  isSolidAt: (x: number, y: number, z: number) => boolean;
  getBlockAt: (x: number, y: number, z: number) => BlockId;
  surfaceHeight: (x: number, z: number) => number;
  isActiveAt: (x: number, z: number) => boolean;
  isNight: () => boolean;
  /** See the module doc comment above - a bounded approximation, not real light propagation. */
  approxBrightnessAt: (x: number, y: number, z: number) => number;
  mobs: SpawnableMobManager;
};

export type MobSpawning = { update(delta: number): void };

/**
 * One of these per connected player (created on join, discarded on
 * disconnect - see world-do.ts) - each keeps its own 16 slots and cooldowns,
 * evaluated against that player's own position. Mobs it spawns all land in
 * the ONE shared ServerMobManager roster (ids are already globally unique
 * there), so combat/persistence/everyone-sees-everyone's-mobs works exactly
 * as before - only WHO decides when/where a new one appears changes.
 */
export function createMobSpawning(deps: MobSpawningDeps): MobSpawning {
  const { getPlayerPos, isSolidAt, getBlockAt, surfaceHeight, isActiveAt, isNight, approxBrightnessAt, mobs } = deps;

  const animalSlots: SpawnSlot[] = Array.from({ length: 6 }, () => ({ mobId: null, cooldown: 0 }));
  const surfaceHostileSlots: SpawnSlot[] = Array.from({ length: 6 }, () => ({ mobId: null, cooldown: 0 }));
  const caveHostileSlots: SpawnSlot[] = Array.from({ length: 4 }, () => ({ mobId: null, cooldown: 0 }));

  function isValidMobSpawnColumn(x: number, gy: number, z: number): boolean {
    if (!isActiveAt(x, z)) return false;
    if (getBlockAt(x, gy, z) !== BlockId.GRASS) return false;
    return !isSolidAt(x, gy + 1, z) && !isSolidAt(x, gy + 2, z);
  }

  /**
   * Surface: solid dry footing, at/above water level, two clear blocks above.
   * No sky-exposure check here (unlike singleplayer's own) - this is only
   * ever called while isNight() is already true (see update() below), and an
   * open-sky column at night already sits at/under the same brightness
   * threshold singleplayer's getSkyExposure would have required; the check
   * would never actually reject anything this one doesn't already reject.
   */
  function isValidHostileSurfaceColumn(x: number, gy: number, z: number): boolean {
    if (!isActiveAt(x, z)) return false;
    if (gy < WATER_LEVEL) return false;
    const ground = getBlockAt(x, gy, z);
    if (ground === BlockId.AIR || ground === BlockId.WATER || ground === BlockId.LAVA) return false;
    if (!isSolidBlock(ground)) return false;
    if (isSolidAt(x, gy + 1, z) || isSolidAt(x, gy + 2, z)) return false;
    if (getBlockAt(x, gy + 1, z) === BlockId.WATER || getBlockAt(x, gy + 2, z) === BlockId.WATER) return false;
    return true;
  }

  function isValidHostileCaveColumn(x: number, y: number, z: number): boolean {
    if (!isActiveAt(x, z)) return false;
    if (!isSolidAt(x, y, z)) return false;
    if (isSolidAt(x, y + 1, z) || isSolidAt(x, y + 2, z)) return false;
    if (getBlockAt(x, y + 1, z) === BlockId.WATER || getBlockAt(x, y + 2, z) === BlockId.WATER) return false;
    return approxBrightnessAt(x, y + 1, z) <= CAVE_LIGHT_MAX;
  }

  function trySpawnAnimal(): number | null {
    const p = getPlayerPos();
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = AMBIENT_SPAWN_MIN_RADIUS + Math.random() * (SPAWN_AREA_RADIUS_BLOCKS - AMBIENT_SPAWN_MIN_RADIUS);
      const gx = Math.round(p.x + Math.sin(angle) * radius);
      const gz = Math.round(p.z + Math.cos(angle) * radius);
      const gy = surfaceHeight(gx, gz);
      if (!isValidMobSpawnColumn(gx, gy, gz)) continue;
      const kind = MOB_KINDS[Math.floor(Math.random() * MOB_KINDS.length)];
      return mobs.spawn(kind, new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  function trySpawnSurfaceHostile(): number | null {
    const p = getPlayerPos();
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = AMBIENT_SPAWN_MIN_RADIUS + Math.random() * (SPAWN_AREA_RADIUS_BLOCKS - AMBIENT_SPAWN_MIN_RADIUS);
      const gx = Math.round(p.x + Math.sin(angle) * radius);
      const gz = Math.round(p.z + Math.cos(angle) * radius);
      const gy = surfaceHeight(gx, gz);
      if (gy < WATER_LEVEL || !isValidHostileSurfaceColumn(gx, gy, gz)) continue;
      const kind = HOSTILE_SPAWN_KINDS[Math.floor(Math.random() * HOSTILE_SPAWN_KINDS.length)];
      return mobs.spawn(kind, new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  function trySpawnCaveHostile(): number | null {
    const p = getPlayerPos();
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const gx = Math.round(p.x + Math.sin(angle) * CAVE_SPAWN_RADIUS);
      const gz = Math.round(p.z + Math.cos(angle) * CAVE_SPAWN_RADIUS);
      if (!isActiveAt(gx, gz)) continue;
      const surfaceY = surfaceHeight(gx, gz);
      const gy = Math.max(1, Math.min(surfaceY - 3, Math.round(p.y) + Math.round((Math.random() - 0.5) * 16)));
      if (!isValidHostileCaveColumn(gx, gy, gz)) continue;
      const kind = HOSTILE_SPAWN_KINDS[Math.floor(Math.random() * HOSTILE_SPAWN_KINDS.length)];
      return mobs.spawn(kind, new THREE.Vector3(gx, gy + 0.5, gz), Math.random() * Math.PI * 2 - Math.PI);
    }
    return null;
  }

  /** Frees a slot whose mob died or left every active region, ticks its cooldown, and tries a fresh spawn once ready. */
  function updateSpawnSlot(slot: SpawnSlot, delta: number, condition: boolean, trySpawn: () => number | null): void {
    if (slot.mobId !== null) {
      if (!mobs.isAlive(slot.mobId)) {
        slot.mobId = null;
        slot.cooldown = RESPAWN_COOLDOWN;
        return;
      }
      const pos = mobs.getPos(slot.mobId);
      if (pos && !isActiveAt(Math.round(pos.x), Math.round(pos.z))) {
        mobs.forceRemove(slot.mobId);
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
    const night = isNight();
    for (const slot of animalSlots) updateSpawnSlot(slot, delta, !night, trySpawnAnimal);
    for (const slot of surfaceHostileSlots) updateSpawnSlot(slot, delta, night, trySpawnSurfaceHostile);
    for (const slot of caveHostileSlots) updateSpawnSlot(slot, delta, true, trySpawnCaveHostile);
  }

  return { update };
}

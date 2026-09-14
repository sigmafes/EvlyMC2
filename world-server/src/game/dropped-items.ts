// Copiado de src/dropped-items.ts - ver world-server/src/game/README.md para el
// criterio de qué se copia vs qué sigue compartido con singleplayer.
// Cambios acá NO se reflejan automáticamente en src/dropped-items.ts, y viceversa.
//
// Qué se sacó respecto del original: TODO lo que es renderizado o navegador -
// THREE.Scene, buildBlockMesh/buildItemMesh/tintByLight (mallas y texturas),
// el wireframe de debug, el spin/bob cosmético (el cliente lo hace solo, ver
// multiplayer-game.ts) y la persistencia vía DroppedItemsStore (que usa
// IndexedDB - del lado servidor la persistencia va a DO storage, y queda para
// la Fase 12 del plan). Lo que SÍ se mantiene idéntico es la física y las
// constantes: gravedad, drag, hitbox, rango/delay de pickup, merge y despawn -
// si eso divergiera, un ítem se sentiría distinto en multiplayer que en
// singleplayer, que es justo lo que no se quiere.

import * as THREE from 'three';

const GRAVITY = 20;
const AIR_DRAG = 0.98;
const GROUND_DRAG = 0.12;
const HALF = 0.125;
const PICKUP_RANGE = 1.5;
const PICKUP_DELAY = 0.5;
const MERGE_RANGE = 0.7;
const DESPAWN = 60;
const MAX_ENTITIES = 256;

type Entity = {
  /** Server-assigned, stable for this item's whole lifetime - the client keys its meshes by it. */
  entityId: number;
  /** BlockId/ItemId of what's on the ground. */
  itemId: number;
  count: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  restY: number;
  age: number;
  grounded: boolean;
};

export type DroppedItemSnapshot = {
  entityId: number;
  itemId: number;
  count: number;
  pos: { x: number; y: number; z: number };
};

export type DroppedItemsDeps = {
  isSolid: (x: number, y: number, z: number) => boolean;
  /** Everyone who could vacuum an item up. `pos` is EYE height (PlayerPhysics' convention) - update() converts to body centre itself, same -0.9 the singleplayer version applies. */
  players: { id: number; pos: THREE.Vector3 }[];
  /** Merge a stack into that player's inventory; returns the count that did NOT fit (stays on the ground). */
  collect: (playerId: number, itemId: number, count: number) => number;
  /** Called when a player actually picked something up, so the caller can push them a fresh inventory. */
  onPickup?: (playerId: number) => void;
};

/**
 * Ítems tirados en el suelo, autoritativos del lado servidor: romper un bloque
 * o tirar un stack con Q spawnea una entidad real que cae, colisiona con el
 * terreno y es aspirada por el jugador que se le acerque - en vez de ir directo
 * al inventario de quien lo rompió (que era la simplificación del primer pase
 * del multiplayer).
 *
 * El servidor es dueño de la física y del pickup; el cliente solo recibe
 * posiciones y dibuja. El giro y el rebote vertical del ítem son puramente
 * cosméticos y se calculan en el cliente, así no hay que mandarlos por red.
 */
export class ServerDroppedItems {
  private readonly entities: Entity[] = [];
  private nextEntityId = 1;

  /** Drop `count` of `itemId` at `pos`, thrown along `dir` (need not be normalised) - same arc/spread as the singleplayer version. */
  spawn(itemId: number | null, count: number, pos: THREE.Vector3, dir?: THREE.Vector3): void {
    if (itemId == null || count <= 0) return;
    if (this.entities.length >= MAX_ENTITIES) this.entities.shift();

    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 1.5,
      3 + Math.random() * 1.5,
      (Math.random() - 0.5) * 1.5,
    );
    if (dir && dir.lengthSq() > 0) {
      const d = dir.clone().normalize();
      vel.x += d.x * 5;
      vel.z += d.z * 5;
      vel.y += d.y * 3 + 1;
    }

    this.entities.push({
      entityId: this.nextEntityId++,
      itemId,
      count,
      pos: pos.clone(),
      vel,
      restY: pos.y,
      age: 0,
      grounded: false,
    });
  }

  /** Advance physics, pickup and merging by `delta` seconds. */
  update(delta: number, deps: DroppedItemsDeps): void {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];

      e.age += delta;
      if (e.age >= DESPAWN) { this.entities.splice(i, 1); continue; }

      const p = e.pos;
      if (e.grounded) p.y = e.restY;

      // --- physics: integrate & collide one axis at a time ---
      e.vel.y -= GRAVITY * delta;
      const hitX = this.sweep(p, 'x', e.vel.x * delta, deps.isSolid);
      const hitZ = this.sweep(p, 'z', e.vel.z * delta, deps.isSolid);
      const hitY = this.sweep(p, 'y', e.vel.y * delta, deps.isSolid);
      if (hitX) e.vel.x = 0;
      if (hitZ) e.vel.z = 0;
      e.grounded = false;
      if (hitY) {
        if (e.vel.y < 0) { e.grounded = true; e.restY = p.y; }
        e.vel.y = 0;
      }

      const drag = e.grounded ? GROUND_DRAG ** delta : AIR_DRAG ** (delta * 60);
      e.vel.x *= drag;
      e.vel.z *= drag;

      // --- pickup: nearest eligible player wins ---
      if (e.age >= PICKUP_DELAY) {
        let picked = false;
        for (const player of deps.players) {
          // Player body centre is roughly 0.9 below the eye (same offset the singleplayer version applies to the camera position).
          const dx = p.x - player.pos.x;
          const dy = p.y - (player.pos.y - 0.9);
          const dz = p.z - player.pos.z;
          if (dx * dx + dy * dy + dz * dz > PICKUP_RANGE * PICKUP_RANGE) continue;

          const leftover = deps.collect(player.id, e.itemId, e.count);
          if (leftover < e.count) deps.onPickup?.(player.id);
          if (leftover <= 0) { this.entities.splice(i, 1); picked = true; break; }
          e.count = leftover;
        }
        if (picked) continue;
      }

      // --- merge with a nearby like stack ---
      for (let j = i - 1; j >= 0; j--) {
        const o = this.entities[j];
        if (o.itemId !== e.itemId) continue;
        if (e.pos.distanceToSquared(o.pos) > MERGE_RANGE * MERGE_RANGE) continue;
        o.count += e.count;
        o.age = Math.min(o.age, e.age);
        this.entities.splice(i, 1);
        break;
      }
    }
  }

  /** Wire view of every ground item - what goes out in the `state` message. */
  snapshots(): DroppedItemSnapshot[] {
    return this.entities.map((e) => ({
      entityId: e.entityId,
      itemId: e.itemId,
      count: e.count,
      pos: { x: e.pos.x, y: e.grounded ? e.restY : e.pos.y, z: e.pos.z },
    }));
  }

  // --- collision -----------------------------------------------------------

  /** Move `p` by `d` along `axis`, stopping at the first solid block face. */
  private sweep(
    p: THREE.Vector3, axis: 'x' | 'y' | 'z', d: number,
    isSolid: (x: number, y: number, z: number) => boolean,
  ): boolean {
    if (d === 0) return false;
    const before = p[axis];
    p[axis] = before + d;
    if (!this.overlapsSolid(p, isSolid)) return false;

    // Binary-search back toward the last free position so the item rests flush
    // against the block face instead of clipping into it.
    let lo = 0;
    let hi = d;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      p[axis] = before + mid;
      if (this.overlapsSolid(p, isSolid)) hi = mid;
      else lo = mid;
    }
    p[axis] = before + lo;
    return true;
  }

  private overlapsSolid(p: THREE.Vector3, isSolid: (x: number, y: number, z: number) => boolean): boolean {
    const x0 = Math.round(p.x - HALF), x1 = Math.round(p.x + HALF);
    const y0 = Math.round(p.y - HALF), y1 = Math.round(p.y + HALF);
    const z0 = Math.round(p.z - HALF), z1 = Math.round(p.z + HALF);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }
}

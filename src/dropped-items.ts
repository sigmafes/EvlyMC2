import * as THREE from 'three';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh, tintByLight } from './block-preview';
import { makeStack } from './item-stack';
import { isBlock, maxStackOf } from './item';
import type { InventorySlot } from './inventory';
import { DroppedItemsStore, type DroppedItemRecord } from './dropped-items-store';

/**
 * LCE-style dropped items: breaking a block (or pressing the drop key) spawns a
 * small spinning entity that arcs out, falls under gravity, collides with blocks
 * on every axis (square 0.25 hitbox) and is sucked into the player when they
 * come close. Overflow the inventory can't take stays on the ground.
 */

const GRAVITY = 20;
const AIR_DRAG = 0.98;      // per-frame-ish horizontal retention in the air
const GROUND_DRAG = 0.12;   // much stronger friction once resting
const HALF = 0.125;         // half-extent of the cubic item hitbox (0.25 block)
const PICKUP_RANGE = 1.5;
const PICKUP_DELAY = 0.5;   // seconds before an item can be collected
const MERGE_RANGE = 0.7;
const DESPAWN = 60;         // 1 minute
const MAX_ENTITIES = 256;
const SAVE_INTERVAL = 5;    // seconds between periodic persistence snapshots

type Entity = {
  group: THREE.Group;
  box: THREE.LineSegments;
  vel: THREE.Vector3;
  restY: number;
  id: number;
  count: number;
  age: number;
  grounded: boolean;
  /** Restored from a save whose chunk hasn't finished loading yet: physics is
   *  skipped (frozen in place) until it has, so it doesn't free-fall through
   *  not-yet-generated terrain and end up buried once the real ground appears. */
  pendingChunk: boolean;
};

export class DroppedItems {
  private readonly entities: Entity[] = [];
  private debug = false;
  private readonly boxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2));
  private readonly boxMat = new THREE.LineBasicMaterial({ color: 0xffee44 });
  private readonly store?: DroppedItemsStore;
  private saveAccum = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly isSolid: (x: number, y: number, z: number) => boolean,
    /** Merge a stack into the inventory; returns the count that did not fit. */
    private readonly collect: (slot: InventorySlot) => number,
    private readonly onPickup?: () => void,
    seed?: number,
    private readonly isChunkLoaded?: (x: number, z: number) => boolean,
  ) {
    if (seed != null) {
      this.store = new DroppedItemsStore(seed);
      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => { void this.flush(); });
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') void this.flush();
        });
      }
    }
  }

  /** Restore ground items saved from a previous session (call once, before the first update()). */
  async loadPersisted(): Promise<void> {
    if (!this.store) return;
    const records = await this.store.load();
    for (const rec of records) {
      this.spawnEntity(rec.id, rec.count, new THREE.Vector3(rec.x, rec.y, rec.z), new THREE.Vector3(0, 0, 0), rec.age, true);
    }
  }

  /** Toggle the wireframe hitboxes (bound to the same key as the debug overlay). */
  setDebug(on: boolean): void {
    this.debug = on;
    for (const e of this.entities) e.box.visible = on;
  }

  /** Drop `count` of `id` at `pos`, thrown along `dir` (need not be normalised). */
  spawn(id: number | null, count: number, pos: THREE.Vector3, dir?: THREE.Vector3): void {
    if (id == null || count <= 0) return;

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

    this.spawnEntity(id, count, pos, vel, 0, false);
  }

  private spawnEntity(
    id: number, count: number, pos: THREE.Vector3, vel: THREE.Vector3, age: number, pendingChunk: boolean,
  ): void {
    if (this.entities.length >= MAX_ENTITIES) this.removeAt(0);

    const slot = makeStack(id, count);
    const block = isBlock(id);
    const group = block ? buildBlockMesh(slot) : buildItemMesh(slot.sideTexture ?? '');
    group.scale.setScalar(block ? 0.17 : 0.4);
    group.position.copy(pos);
    this.scene.add(group);

    const box = new THREE.LineSegments(this.boxGeo, this.boxMat);
    box.visible = this.debug;
    box.position.copy(pos);
    this.scene.add(box);

    this.entities.push({ group, box, vel, restY: pos.y, id, count, age, grounded: false, pendingChunk });
  }

  /**
   * Advance physics and handle pickup. `playerPos` is the camera/eye position;
   * `getLight` returns the 0..15 world brightness at a block so entities are
   * shaded like the terrain around them.
   */
  update(delta: number, playerPos: THREE.Vector3, getLight?: (x: number, y: number, z: number) => number): void {
    // Player body centre is roughly 0.9 below the eye.
    const body = playerPos.clone();
    body.y -= 0.9;

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];

      if (e.pendingChunk) {
        if (!this.isChunkLoaded || !this.isChunkLoaded(Math.round(e.group.position.x), Math.round(e.group.position.z))) {
          continue; // stay frozen (no gravity/age) until its terrain actually exists
        }
        e.pendingChunk = false;
      }

      e.age += delta;
      if (e.age >= DESPAWN) { this.removeAt(i); continue; }

      const p = e.group.position;
      // Undo last frame's cosmetic idle bob before running physics against blocks.
      if (e.grounded) p.y = e.restY;

      // --- physics: integrate & collide one axis at a time ---
      e.vel.y -= GRAVITY * delta;
      const hitX = this.sweep(p, 'x', e.vel.x * delta);
      const hitZ = this.sweep(p, 'z', e.vel.z * delta);
      const hitY = this.sweep(p, 'y', e.vel.y * delta);
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

      // --- spin + idle bob (cosmetic only) ---
      // The bob rides entirely ABOVE the resting height so the low point sits
      // flush on the block instead of sinking through it.
      e.group.rotation.y += delta * 1.6;
      if (e.grounded) e.group.position.y = e.restY + 0.06 + Math.sin(e.age * 3) * 0.06;
      e.box.position.set(p.x, e.grounded ? e.restY : p.y, p.z);

      // --- world lighting ---
      if (getLight) {
        const level = getLight(Math.round(p.x), Math.round(p.y), Math.round(p.z));
        tintByLight(e.group, level / 15);
      }

      // --- pickup ---
      if (e.age >= PICKUP_DELAY) {
        const dx = p.x - body.x;
        const dy = p.y - body.y;
        const dz = p.z - body.z;
        if (dx * dx + dy * dy + dz * dz <= PICKUP_RANGE * PICKUP_RANGE) {
          const leftover = this.collect(makeStack(e.id, e.count));
          if (leftover < e.count) this.onPickup?.();
          if (leftover <= 0) { this.removeAt(i); continue; }
          e.count = leftover;
        }
      }

      // --- merge with a nearby like stack ---
      for (let j = i - 1; j >= 0; j--) {
        const o = this.entities[j];
        if (o.id !== e.id) continue;
        if (e.count + o.count > maxStackOf(e.id)) continue;
        if (e.group.position.distanceToSquared(o.group.position) > MERGE_RANGE * MERGE_RANGE) continue;
        o.count += e.count;
        o.age = Math.min(o.age, e.age);
        this.removeAt(i);
        break;
      }
    }

    if (this.store) {
      this.saveAccum += delta;
      if (this.saveAccum >= SAVE_INTERVAL) {
        this.saveAccum = 0;
        void this.store.save(this.snapshot());
      }
    }
  }

  private snapshot(): DroppedItemRecord[] {
    return this.entities.map((e) => ({
      id: e.id,
      count: e.count,
      x: e.group.position.x,
      y: e.grounded ? e.restY : e.group.position.y,
      z: e.group.position.z,
      age: e.age,
    }));
  }

  /** Write the current entity list now (leaving the world, tab hidden, unload). */
  async flush(): Promise<void> {
    if (!this.store) return;
    await this.store.save(this.snapshot());
  }

  /** Remove every entity (leaving the world). Call flush() first if it should persist. */
  clear(): void {
    for (let i = this.entities.length - 1; i >= 0; i--) this.removeAt(i);
  }

  // --- collision -----------------------------------------------------------

  /** Move `p` by `d` along `axis`, stopping at the first solid block face. */
  private sweep(p: THREE.Vector3, axis: 'x' | 'y' | 'z', d: number): boolean {
    if (d === 0) return false;
    const before = p[axis];
    p[axis] = before + d;
    if (!this.overlapsSolid(p)) return false;

    // Binary-search back toward the last free position so the item rests flush
    // against the block face instead of clipping into it.
    let lo = 0;
    let hi = d;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      p[axis] = before + mid;
      if (this.overlapsSolid(p)) hi = mid;
      else lo = mid;
    }
    p[axis] = before + lo;
    return true;
  }

  private overlapsSolid(p: THREE.Vector3): boolean {
    const x0 = Math.round(p.x - HALF), x1 = Math.round(p.x + HALF);
    const y0 = Math.round(p.y - HALF), y1 = Math.round(p.y + HALF);
    const z0 = Math.round(p.z - HALF), z1 = Math.round(p.z + HALF);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  private removeAt(i: number): void {
    const e = this.entities[i];
    if (!e) return;
    this.scene.remove(e.group);
    this.scene.remove(e.box);
    disposeBlockMesh(e.group);
    this.entities.splice(i, 1);
  }
}

import * as THREE from 'three';
import { buildItemMesh, disposeBlockMesh, tintByLight } from './block-preview';
import { ItemId } from './item';
import { makeStack } from './item-stack';
import type { InventorySlot } from './inventory';
import type { MobManager } from './mob-manager';
import type { SoundManager } from './sound-manager';

/**
 * LCE-style arrow entity (Arrow.cpp): flies under gravity, embeds in the first
 * solid block it touches instead of settling on the ground like a dropped
 * item, does a single hit-or-miss check against whatever it can damage (mobs
 * for a player-shot arrow, the player for a mob-shot one - LCE arrows can hit
 * either, but with only skeletons as a ranged shooter today "mob shoots the
 * player" / "player shoots mobs" covers every real case), and can be picked
 * back up once it's stuck.
 */

const GRAVITY = 20;          // matches dropped-items.ts's world-gravity feel
const DRAG = 0.99;           // per-frame-ish velocity retention while flying (LCE 0.99/tick)
const HALF = 0.15;           // collision half-extent while flying
const PLAYER_HIT_RADIUS = 0.6;
const PICKUP_RANGE = 1.2;
const PICKUP_DELAY = 0.3;    // seconds an embedded arrow waits before it can be collected
const BASE_DAMAGE = 2.0;     // LCE Arrow::ARROW_BASE_DAMAGE
const EMBEDDED_DESPAWN = 60; // seconds stuck before it vanishes unclaimed (LCE 20*60 ticks)
const OWNER_IGNORE_TIME = 5 / 20; // ~5 ticks - an arrow can't hit its own shooter for its first instant of flight

// LCE's "power" (BowItem/ArrowAttackGoal, 0..2.0-ish) is a velocity in
// blocks/TICK (20 ticks/sec) - transplanted as a raw number it would be an
// absurdly fast blocks/SECOND value in EvlyMC's units, so it's rescaled by
// this tuned-by-feel factor instead. Adjust this one constant to make arrows
// faster/slower overall without touching the draw-power curve itself.
const POWER_TO_SPEED = 15; // blocks/second per unit of LCE "power"

/** Converts an LCE-style "power" (bow draw 0..1 scaled by *2, or a mob's fixed 1.60) into an EvlyMC blocks/second speed. */
export function powerToSpeed(power: number): number {
  return power * POWER_TO_SPEED;
}

type Arrow = {
  group: THREE.Group;
  vel: THREE.Vector3;
  fromPlayer: boolean;
  crit: boolean;
  embedded: boolean;
  embedTimer: number;
  flightTime: number;
};

export type ArrowSpawnOptions = {
  /** True if the player fired it (checks mobs for a hit); false if a mob fired it (checks the player). */
  fromPlayer: boolean;
  /** LCE dmg = ceil(velocityMagnitude * baseDamage); crit adds a random bonus on top. */
  crit?: boolean;
};

export type ArrowProjectilesDeps = {
  scene: THREE.Scene;
  isSolid: (x: number, y: number, z: number) => boolean;
  mobManager: MobManager;
  /** Player eye position, and a way to damage them (arrow shot by a mob) / collect a recovered arrow into their inventory. */
  getPlayerPos: () => THREE.Vector3;
  onHitPlayer?: (damage: number, fromPos: THREE.Vector3) => void;
  collect: (slot: InventorySlot) => number;
  onPickup?: () => void;
  soundManager?: SoundManager;
  getLight?: (x: number, y: number, z: number) => number;
};

export class ArrowProjectiles {
  private readonly arrows: Arrow[] = [];

  constructor(private readonly deps: ArrowProjectilesDeps) {}

  /** Fire an arrow from `pos` with the given world-space velocity (blocks/second). */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, opts: ArrowSpawnOptions): void {
    const group = buildItemMesh('items/arrow.png');
    group.scale.setScalar(0.35);
    group.position.copy(pos);
    this.orient(group, vel);
    this.deps.scene.add(group);

    this.arrows.push({
      group,
      vel: vel.clone(),
      fromPlayer: opts.fromPlayer,
      crit: opts.crit ?? false,
      embedded: false,
      embedTimer: 0,
      flightTime: 0,
    });
  }

  private orient(group: THREE.Group, vel: THREE.Vector3): void {
    const horiz = Math.hypot(vel.x, vel.z);
    group.rotation.y = Math.atan2(-vel.x, -vel.z);
    group.rotation.x = Math.atan2(vel.y, horiz);
  }

  update(delta: number): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];

      if (a.embedded) {
        a.embedTimer += delta;
        if (a.embedTimer >= EMBEDDED_DESPAWN) { this.removeAt(i); continue; }
        this.tryPickup(a, i);
        continue;
      }

      a.flightTime += delta;
      const from = a.group.position.clone();

      a.vel.y -= GRAVITY * delta;
      const step = a.vel.clone().multiplyScalar(delta);
      const to = from.clone().add(step);

      // Entity hit check along this frame's travel segment - a single
      // ray/point test is plenty at this scale (arrows move fast, frames are
      // short, matches LCE's own per-tick segment check).
      if (this.checkEntityHit(a, from, to)) { this.removeAt(i); continue; }

      // Block collision: stop at the first solid cell and embed there.
      if (this.overlapsSolid(to)) {
        a.embedded = true;
        a.vel.set(0, 0, 0);
        a.group.position.copy(to);
        this.playHitSound('block', to);
        continue;
      }

      a.group.position.copy(to);
      a.vel.x *= DRAG;
      a.vel.z *= DRAG;
      this.orient(a.group, a.vel);

      if (this.deps.getLight) {
        const level = this.deps.getLight(Math.round(to.x), Math.round(to.y), Math.round(to.z));
        tintByLight(a.group, level / 15);
      }
    }
  }

  /** Checks the player (mob-shot arrow) or the nearest mob (player-shot arrow) along this frame's segment. */
  private checkEntityHit(a: Arrow, from: THREE.Vector3, to: THREE.Vector3): boolean {
    if (a.flightTime < OWNER_IGNORE_TIME) return false;
    const speed = a.vel.length();
    const dmgBase = Math.ceil(speed * BASE_DAMAGE);
    const dmg = a.crit ? dmgBase + Math.floor(Math.random() * (dmgBase / 2 + 2)) : dmgBase;

    if (a.fromPlayer) {
      const dir = to.clone().sub(from);
      const dist = dir.length();
      if (dist < 1e-6) return false;
      dir.normalize();
      const hit = this.deps.mobManager.raycastMobs(from, dir, dist);
      if (!hit) return false;
      this.deps.mobManager.damage(hit.mobId, dmg, from);
      this.playHitSound('entity', to);
      return true;
    }

    const playerPos = this.deps.getPlayerPos();
    const closest = closestPointOnSegment(from, to, playerPos);
    if (closest.distanceTo(playerPos) > PLAYER_HIT_RADIUS) return false;
    this.deps.onHitPlayer?.(dmg, from);
    this.playHitSound('entity', to);
    return true;
  }

  private tryPickup(a: Arrow, index: number): void {
    if (a.embedTimer < PICKUP_DELAY) return;
    const playerPos = this.deps.getPlayerPos();
    if (a.group.position.distanceTo(playerPos) > PICKUP_RANGE) return;
    const leftover = this.deps.collect(makeStack(ItemId.ARROW, 1));
    if (leftover > 0) return; // inventory full - stays on the ground
    this.deps.onPickup?.();
    this.deps.soundManager?.playOne('player/Pop', 0.5);
    this.removeAt(index);
  }

  private playHitSound(kind: 'block' | 'entity', pos: THREE.Vector3): void {
    if (!this.deps.soundManager) return;
    if (kind === 'block') this.deps.soundManager.playRandom('items/Arrow_hit', 4, 0.7);
    else this.deps.soundManager.playOne('items/Successful_hit', 0.8);
  }

  private overlapsSolid(p: THREE.Vector3): boolean {
    const x0 = Math.round(p.x - HALF), x1 = Math.round(p.x + HALF);
    const y0 = Math.round(p.y - HALF), y1 = Math.round(p.y + HALF);
    const z0 = Math.round(p.z - HALF), z1 = Math.round(p.z + HALF);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.deps.isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  private removeAt(i: number): void {
    const a = this.arrows[i];
    if (!a) return;
    this.deps.scene.remove(a.group);
    disposeBlockMesh(a.group);
    this.arrows.splice(i, 1);
  }
}

/** Nearest point on segment [a,b] to point p. */
function closestPointOnSegment(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-9) return a.clone();
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1);
  return a.clone().add(ab.multiplyScalar(t));
}

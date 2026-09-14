import * as THREE from 'three';
import { BlockId } from './block';
import { MobModel, BipedMobModel, type QuadrupedSpec, type BipedSpec } from './mob-model';
import { playMobSound } from './mob-sounds';
import type { SoundManager } from './sound-manager';
import type { PathPoint } from './mob-pathfinding';
import { rollDrops } from './mob-drops';
import { overlapsSolid, tryEscapeStuck, updatePhysics } from './mob-physics';
import { updateAI, type MobAiDeps } from './mob-ai';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie' | 'skeleton';
export type MobSpec = QuadrupedSpec | BipedSpec;

/** Biped mobs (rendered/animated via BipedMobModel) - zombie and skeleton today. Exported so the multiplayer client picks the same model class per kind instead of keeping its own copy of this list, which would silently go stale the day a third biped is added. */
export function isBipedKind(kind: MobKind): boolean {
  return kind === 'zombie' || kind === 'skeleton';
}

/** Common surface both MobModel (quadruped) and BipedMobModel (zombie) expose - all MobManager needs. */
export type AnyMobModel = {
  getGroup(): THREE.Group;
  setWalking(walking: boolean): void;
  setLightLevel(level01: number): void;
  hurt(): void;
  setDying(on: boolean): void;
  setOnFire(on: boolean): void;
  update(delta: number): void;
  setAttacking?(on: boolean): void;
};

const HOSTILE_KINDS: MobKind[] = ['zombie', 'skeleton'];
export function isHostileKind(kind: MobKind): boolean {
  return HOSTILE_KINDS.includes(kind);
}

const ri = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Per-species stats, ballpark-matched to LCE (Minecraft Legacy Console
 * Edition) values for these long-unchanged passive mobs: cow/pig 10 HP
 * (5 hearts), sheep 8 HP (4 hearts); pig a little faster than cow/sheep,
 * matching LCE's own relative movement-speed attributes. Flee (panic) speed
 * and duration are LCE's PanicGoal behaviour - sprint away for a few seconds
 * after being hurt, ignoring the wander target until it expires.
 */
export const MOB_STATS: Record<MobKind, { maxHealth: number; walkSpeed: number; fleeSpeedMult: number; radius: number; height: number }> = {
  // Animals: 0.9x0.9 footprint, 1.3 tall (radius is the half-width overlapsSolid uses).
  pig: { maxHealth: 10, walkSpeed: 2.3, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  cow: { maxHealth: 10, walkSpeed: 2.0, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  sheep: { maxHealth: 8, walkSpeed: 2.0, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  // LCE zombie: 20 HP (10 hearts). No flee behaviour, fleeSpeedMult unused.
  zombie: { maxHealth: 20, walkSpeed: 2.3, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
  // LCE skeleton: 20 HP, runSpeed 0.25 (a bit slower than the zombie's 0.3-ish
  // equivalent) - it mostly stands and shoots rather than closing distance.
  skeleton: { maxHealth: 20, walkSpeed: 2.0, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
};

const BURN_DAMAGE_INTERVAL = 1;  // seconds between fire-damage ticks
const BURN_DAMAGE = 1;
const FIRE_AFTERBURN_TICKS = 8;  // ticks of damage that still land after losing contact with lava/fire/sun, then it goes out
const SKY_SCAN_MAX_Y = 156;      // above chunk.ts's CHUNK_HEIGHT (152) - a column open all the way up here really has no roof
const STEP_INTERVAL = 0.45;
const IDLE_SOUND_MIN = 4;
const IDLE_SOUND_MAX = 9;
const MOB_SOUND_RADIUS = 4; // mob sounds (idle/step/hurt/death) only carry this far
const KNOCKBACK_SPEED = 5;
const KNOCKBACK_UP = 4;
// How long a melee hostile mob's AI holds off re-zeroing horizontal velocity
// after a hit, so the shove above is actually visible before the anti-hop
// snap in updateHostileAI() clamps it back down.
const KNOCKBACK_LOCK_DURATION = 0.3;
const FLEE_DURATION = 3; // seconds, LCE PanicGoal-style - starts here (damage()), ticked down and re-picked by mob-ai.ts's updateAI
const DEATH_SPIN_DURATION = 0.75; // seconds toppling over its Z axis before vanishing

// Shared wireframe box geometry/material for the debug hitbox (R key) - one
// GPU resource, scaled per mob instance, same pattern as DroppedItems' boxes.
const hitboxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const hitboxMat = new THREE.LineBasicMaterial({ color: 0x00ffff });

export type Mob = {
  id: number;
  kind: MobKind;
  model: AnyMobModel;
  // Authoritative position - a plain Vector3 with no scene attachment, NOT
  // the render mesh's transform. AI/physics (mob-ai.ts/mob-physics.ts) read
  // and write this directly; MobManager.update() is the single place that
  // copies it onto model.getGroup().position afterward for rendering. This
  // split (state independent of any THREE.Scene/mesh) is what would let a
  // future server run mob simulation headless, the same way player-physics.ts
  // already does for the player.
  pos: THREE.Vector3;
  velocity: THREE.Vector3;
  health: number;
  maxHealth: number;
  walkSpeed: number;
  fleeSpeedMult: number;
  radius: number;
  height: number;
  grounded: boolean;
  facingYaw: number;
  // AI
  fleeTimer: number;
  fleeDir: THREE.Vector3; // unit vector away from the last thing that hurt this mob
  path: PathPoint[] | null;
  pathIndex: number;
  decisionTimer: number; // seconds until the next wander decision (8-12s cadence)
  idleLookTimer: number; // seconds until the next look-around turn while stationary (3s cadence)
  lookTimer: number; // >0 while easing toward lookTargetYaw
  lookTargetYaw: number;
  inWater: boolean;
  waterCheckTimer: number;
  // Hostile AI (zombie): chase the player within CHASE_RADIUS, attack on contact.
  chasing: boolean;
  chaseRepathTimer: number;
  attackTimer: number;
  // Seconds left before a zombie can attempt another leap toward a player
  // standing above it - see LEAP_COOLDOWN in mob-ai.ts.
  leapCooldown: number;
  // Seconds left where a fresh knockback shove should be allowed to decay
  // naturally (friction) instead of being zeroed by the melee AI's anti-hop
  // snap - see updateHostileAI() in mob-ai.ts.
  knockbackTimer: number;
  // Ranged hostile AI (skeleton): seconds of continuous line-of-sight on the
  // target, accumulated toward RANGED_SIGHT_REQUIRED before the first shot.
  rangedSeeTimer: number;
  // Fire (sunlight for zombie/skeleton, or lava/fire contact for any mob):
  // ticks damage while exposed AND for fireTicksLeft ticks after losing
  // exposure (the "after-burn"), independent of combat. `onFire` also drives
  // the model's orange tint + flame overlay and (dead) whether drops cook.
  onFire: boolean;
  fireTicksLeft: number;
  burnTimer: number;
  // Death
  dying: boolean;
  deathTimer: number;
  // Sound
  stepTimer: number;
  idleSoundTimer: number;
  // Debug
  box: THREE.LineSegments;
};

export type MobRaycastHit = { mobId: number; kind: MobKind; distance: number };

/**
 * Fase H+: mobs with real (if simple) AI - wander a random reachable block
 * every 8-12s (with a brief look-around first), flee to a random reachable
 * block when hurt, float and seek shore if they end up in water, jump over
 * 1-block obstacles, and play a short death spin + smoke poof on death - plus
 * health, combat knockback and drops.
 */
export class MobManager {
  private readonly mobs: Mob[] = [];
  private nextId = 1;
  private debug = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly isSolid: (x: number, y: number, z: number) => boolean,
    private readonly onDrop?: (id: number, count: number, pos: THREE.Vector3) => void,
    private readonly soundManager?: SoundManager,
    private readonly isWater?: (x: number, y: number, z: number) => boolean,
    private readonly onDeath?: (pos: THREE.Vector3) => void,
    /** Hostile mobs (zombie) attack the player when in range - damage + the attacker's position (for knockback direction) flow back through this. */
    private readonly onAttackPlayer?: (damage: number, fromPos: THREE.Vector3) => void,
    /** Player position, for hostile mobs to detect/chase - undefined disables chasing entirely. */
    private readonly getPlayerPos?: () => THREE.Vector3,
    /** Ranged hostile mobs (skeleton) fire an arrow instead of a direct hit - the actual projectile is spawned by whoever provides this (main.ts's arrow-projectiles). */
    private readonly onShootArrow?: (fromPos: THREE.Vector3, targetPos: THREE.Vector3) => void,
  ) {
    this.aiDeps = { isSolid, isWater, onAttackPlayer, getPlayerPos, onShootArrow };
  }

  /** Bundled for updateAI() (mob-ai.ts) - built once since the underlying callbacks never change. */
  private readonly aiDeps: MobAiDeps;

  spawn(kind: MobKind, spec: MobSpec, pos: THREE.Vector3, yaw: number): number {
    const stats = MOB_STATS[kind];
    const hitbox = { radius: stats.radius, height: stats.height };
    const model: AnyMobModel = isBipedKind(kind) ? new BipedMobModel(spec as BipedSpec, hitbox) : new MobModel(spec as QuadrupedSpec, hitbox);
    const group = model.getGroup();
    group.position.copy(pos);
    group.rotation.y = yaw;
    this.scene.add(group);

    const box = new THREE.LineSegments(hitboxGeo, hitboxMat);
    box.scale.set(stats.radius * 2, stats.height, stats.radius * 2);
    box.visible = this.debug;
    box.position.set(pos.x, pos.y + stats.height / 2, pos.z);
    this.scene.add(box);

    const id = this.nextId++;
    this.mobs.push({
      id,
      kind,
      model,
      pos: pos.clone(),
      velocity: new THREE.Vector3(),
      health: stats.maxHealth,
      maxHealth: stats.maxHealth,
      walkSpeed: stats.walkSpeed,
      fleeSpeedMult: stats.fleeSpeedMult,
      radius: stats.radius,
      height: stats.height,
      grounded: false,
      facingYaw: yaw,
      fleeTimer: 0,
      fleeDir: new THREE.Vector3(),
      path: null,
      pathIndex: 0,
      decisionTimer: ri(0, 120) / 10, // stagger initial wander so a group doesn't move in lockstep
      idleLookTimer: ri(0, 30) / 10,
      lookTimer: 0,
      lookTargetYaw: yaw,
      inWater: false,
      waterCheckTimer: 0,
      chasing: false,
      chaseRepathTimer: 0,
      attackTimer: 0,
      leapCooldown: 0,
      knockbackTimer: 0,
      rangedSeeTimer: 0,
      onFire: false,
      fireTicksLeft: 0,
      burnTimer: 0,
      dying: false,
      deathTimer: 0,
      stepTimer: 0,
      idleSoundTimer: ri(IDLE_SOUND_MIN * 10, IDLE_SOUND_MAX * 10) / 10,
      box,
    });
    return id;
  }

  /** True if a mob with this id is still alive (dying ones included - not gone until removeAt). */
  isAlive(id: number): boolean {
    return this.mobs.some((m) => m.id === id);
  }

  /** Current world position of a mob by id, or null if it's gone. */
  getPosition(id: number): THREE.Vector3 | null {
    const mob = this.mobs.find((m) => m.id === id);
    return mob ? mob.pos : null;
  }

  /** Silent despawn (no drops, no death animation) - for a mob that wandered into an unloaded chunk. */
  forceRemove(id: number): void {
    const index = this.mobs.findIndex((m) => m.id === id);
    if (index >= 0) this.removeAt(index);
  }

  /** Toggle the wireframe hitboxes (same key as the dropped-item debug boxes). */
  setDebug(on: boolean): void {
    this.debug = on;
    for (const mob of this.mobs) mob.box.visible = on;
  }

  /** Total live mobs (dying ones included - they're still despawning, not free capacity yet). */
  get count(): number {
    return this.mobs.length;
  }

  /**
   * How many live mobs currently sit within `radius` blocks of `pos`
   * (horizontal distance). `filter`, when given, restricts the count to mobs
   * matching a predicate (e.g. kind==='zombie' AND above/below the surface),
   * so passive and hostile spawn caps can be tracked independently.
   */
  countNear(pos: THREE.Vector3, radius: number, filter?: (mob: { kind: MobKind; pos: THREE.Vector3 }) => boolean): number {
    let n = 0;
    for (const mob of this.mobs) {
      if (Math.hypot(mob.pos.x - pos.x, mob.pos.z - pos.z) > radius) continue;
      if (filter && !filter({ kind: mob.kind, pos: mob.pos })) continue;
      n++;
    }
    return n;
  }

  /** Total live mobs matching `filter` (dying ones included), for a spawn cap tracked independently of `count`. */
  countAll(filter: (mob: { kind: MobKind; pos: THREE.Vector3 }) => boolean): number {
    let n = 0;
    for (const mob of this.mobs) {
      if (filter({ kind: mob.kind, pos: mob.pos })) n++;
    }
    return n;
  }

  /**
   * Nearest mob a ray from `origin` toward `dir` (normalised) hits within
   * `maxDist`, or null. Tests the mob's full vertical hitbox (feet to head),
   * not just a single sphere at mid-height - a lone mid-height sphere left
   * tall mobs (zombie/skeleton, height 1.9) with no hit volume covering their
   * head or legs, so shots/swings that visually connected there passed
   * straight through. Used by both arrows (arrow-projectiles.ts) and melee
   * (interaction.ts's hitTestMob), so this one fix covers both.
   */
  raycastMobs(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): MobRaycastHit | null {
    let best: MobRaycastHit | null = null;
    for (const mob of this.mobs) {
      if (mob.dying) continue;
      const hit = rayCapsuleDistance(origin, dir, mob.pos, mob.height, mob.radius);
      if (hit !== null && hit <= maxDist && (!best || hit < best.distance)) {
        best = { mobId: mob.id, kind: mob.kind, distance: hit };
      }
    }
    return best;
  }

  /** Apply damage; on death, starts the death-spin animation (drops/removal happen once it finishes). Returns true if it died.
   * `knockback` (default true) - fire-tick damage passes false since there's
   * no real attacker to shove away from. This only skips the velocity
   * shove/hop below, NOT the flee (Panic) trigger further down - a burning
   * animal still needs to run, it just shouldn't also get flung by a knockback
   * that doesn't correspond to a real hit. */
  damage(mobId: number, amount: number, fromPos: THREE.Vector3, knockback = true): boolean {
    const index = this.mobs.findIndex((m) => m.id === mobId);
    if (index === -1) return false;
    const mob = this.mobs[index];
    if (mob.dying) return false;
    mob.health -= amount;

    if (mob.health <= 0) {
      if (this.soundManager && this.inSoundRange(mob, fromPos)) playMobSound(this.soundManager, mob.kind, 'death', 0.8);
      mob.dying = true;
      mob.deathTimer = DEATH_SPIN_DURATION;
      mob.path = null;
      mob.velocity.x = 0;
      mob.velocity.z = 0;
      mob.model.setDying(true);
      return true;
    }
    if (this.soundManager && this.inSoundRange(mob, fromPos)) playMobSound(this.soundManager, mob.kind, 'hurt', 0.7);
    mob.model.hurt(); // 0.2s red flash

    const pushDir = new THREE.Vector2(mob.pos.x - fromPos.x, mob.pos.z - fromPos.z);
    if (pushDir.lengthSq() < 1e-6) pushDir.set(Math.random() - 0.5, Math.random() - 0.5);
    pushDir.normalize();

    if (knockback) {
      // An instant shove away from the attacker plus a small hop, decaying
      // over the next few frames (see updatePhysics). Every mob gets this,
      // hostile or not - a skeleton standing its ground to shoot still needs
      // to feel a melee hit, not just visually flash.
      mob.velocity.x = pushDir.x * KNOCKBACK_SPEED;
      mob.velocity.z = pushDir.y * KNOCKBACK_SPEED;
      mob.velocity.y = KNOCKBACK_UP;
      mob.grounded = false;
      mob.knockbackTimer = KNOCKBACK_LOCK_DURATION;
    }

    // Hostile mobs (zombie, skeleton) never flee - they keep chasing/aiming
    // through the hit. Panic (LCE PanicGoal) only applies to passive mobs:
    // forget whatever it was doing and start pathing to a random reachable
    // point away from whatever hurt it - runs regardless of `knockback` so a
    // burning animal (fire-tick damage, knockback=false) still flees instead
    // of standing still while it takes 8 more ticks of damage.
    if (isHostileKind(mob.kind)) return false;

    mob.fleeDir.set(pushDir.x, 0, pushDir.y);
    mob.fleeTimer = FLEE_DURATION;
    mob.path = null;

    return false;
  }

  update(
    delta: number,
    getLight?: (x: number, y: number, z: number) => number,
    listenerPos?: THREE.Vector3,
    /** Raw sky exposure 0..15 (sun only, ignores torches) at a position - drives zombie/skeleton sunlight burn. */
    getSkyExposure?: (x: number, y: number, z: number) => number,
    /** Block id at a position - drives lava/fire contact catching any mob on fire. */
    getBlockId?: (x: number, y: number, z: number) => BlockId,
  ): void {
    // Reverse iteration: updateDeath() may splice a finished mob out mid-loop.
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];

      if (mob.dying) {
        this.updateDeath(mob, delta, i);
        continue;
      }

      tryEscapeStuck(mob, this.isSolid);
      updateAI(mob, delta, this.aiDeps);
      updatePhysics(mob, delta, this.isSolid, this.isWater);
      this.updateFire(mob, delta, getSkyExposure, getBlockId);
      if (mob.dying) continue; // fire just killed it this frame - death handled next tick

      // Sync the render mesh from the authoritative plain position that AI/
      // physics just updated - mob.pos is the source of truth, the mesh
      // transform is a pure mirror of it from here on.
      mob.model.getGroup().position.copy(mob.pos);

      const moving = mob.path !== null && mob.pathIndex < mob.path.length;
      mob.model.setWalking(moving);

      if (getLight) {
        const level = getLight(Math.round(mob.pos.x), Math.round(mob.pos.y + mob.height / 2), Math.round(mob.pos.z));
        mob.model.setLightLevel(level / 15);
      }
      mob.model.setOnFire(mob.onFire);
      mob.model.update(delta); // resolves this frame's colour (light tint, or a hurt/fire tint on top)
      this.updateSounds(mob, delta, moving, listenerPos);

      mob.box.position.set(mob.pos.x, mob.pos.y + mob.height / 2, mob.pos.z);
    }
  }

  /**
   * True if any part of the mob's hitbox column overlaps a LAVA or FIRE
   * block - same idea as overlapsSolid() in mob-physics.ts, just checking
   * for two specific block ids instead of "is solid".
   */
  private touchesFireOrLava(mob: Mob, getBlockId: (x: number, y: number, z: number) => BlockId): boolean {
    const p = mob.pos;
    const x0 = Math.round(p.x - mob.radius), x1 = Math.round(p.x + mob.radius);
    const z0 = Math.round(p.z - mob.radius), z1 = Math.round(p.z + mob.radius);
    const y0 = Math.round(p.y + 0.05), y1 = Math.round(p.y + mob.height - 0.05);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        for (let y = y0; y <= y1; y++) {
          const id = getBlockId(x, y, z);
          if (id === BlockId.LAVA || id === BlockId.FIRE) return true;
        }
      }
    }
    return false;
  }

  /**
   * Fire: sunlight (zombie/skeleton only, once sky exposure at its head hits
   * the burn threshold - see main.ts's getSkyExposure) or lava/fire block
   * contact (any mob). Keeps ticking BURN_DAMAGE every BURN_DAMAGE_INTERVAL
   * for FIRE_AFTERBURN_TICKS after exposure ends, then goes out - same
   * "still burning a few seconds after leaving the fire" behaviour as the
   * player (see main.ts's playerOnFire). Independent of combat - reuses the
   * same damage() path so hurt sound/flash/knockback-free death all just
   * work. Water douses it immediately (mob.inWater, already tracked by
   * updatePhysics), and any solid block directly overhead blocks the sun
   * outright regardless of how exposed the sky is laterally.
   */
  private updateFire(
    mob: Mob,
    delta: number,
    getSkyExposure?: (x: number, y: number, z: number) => number,
    getBlockId?: (x: number, y: number, z: number) => BlockId,
  ): void {
    const p = mob.pos;

    const sunBurning = isHostileKind(mob.kind) && !!getSkyExposure
      && getSkyExposure(Math.round(p.x), Math.round(p.y + mob.height), Math.round(p.z)) >= 12
      && !mob.inWater && !this.hasSolidCoverAbove(mob);
    const touchingFire = !mob.inWater && !!getBlockId && this.touchesFireOrLava(mob, getBlockId);

    // Exposed right now - top the after-burn counter back up so it doesn't
    // start ticking down until contact is actually lost.
    if (sunBurning || touchingFire) mob.fireTicksLeft = FIRE_AFTERBURN_TICKS;

    mob.onFire = mob.fireTicksLeft > 0;
    if (!mob.onFire) { mob.burnTimer = 0; return; }

    mob.burnTimer -= delta;
    if (mob.burnTimer <= 0) {
      mob.burnTimer = BURN_DAMAGE_INTERVAL;
      mob.fireTicksLeft -= 1;
      // Passing the mob's own position as "fromPos" made every burn tick's
      // hurt/death sound check (damage() -> inSoundRange(mob, fromPos)) measure
      // a distance of zero, so it was always "audible" no matter how far the
      // player actually was - every burning mob on the map could be heard at
      // once. The real player position is what that range check needs; it's
      // unused for anything else here since knockback=false skips the
      // shove-direction code that fromPos would otherwise feed.
      this.damage(mob.id, BURN_DAMAGE, this.getPlayerPos?.() ?? p, false);
    }
  }

  /**
   * True if any solid block sits directly above this mob's own column, all
   * the way up to the top of the world - a literal roof, not just "the
   * lateral skylight happens to be a bit lower here" (which getSkyExposure
   * alone can't tell apart from actual shade, since light still leaks in
   * sideways around a small overhang). Only called once exposure already
   * cleared the burn threshold, so this bounded scan runs for at most a
   * handful of already-sunlit zombies per frame, not every zombie.
   */
  private hasSolidCoverAbove(mob: Mob): boolean {
    const p = mob.pos;
    const x = Math.round(p.x);
    const z = Math.round(p.z);
    for (let y = Math.round(p.y + mob.height) + 1; y < SKY_SCAN_MAX_Y; y += 1) {
      if (this.isSolid(x, y, z)) return true;
    }
    return false;
  }

  /** True if `pos` is within MOB_SOUND_RADIUS of `mob` (horizontal + vertical distance). No listener position given -> always audible (e.g. no player reference available). */
  private inSoundRange(mob: Mob, pos?: THREE.Vector3): boolean {
    if (!pos) return true;
    return mob.pos.distanceTo(pos) <= MOB_SOUND_RADIUS;
  }

  /** Death animation (topples over its Z axis, red-tinted), then drops + a smoke burst + removal. */
  private updateDeath(mob: Mob, delta: number, index: number): void {
    updatePhysics(mob, delta, this.isSolid, this.isWater); // still falls/lands, just no AI movement
    mob.model.getGroup().position.copy(mob.pos); // sync - see the comment in update()
    mob.model.setWalking(false);
    mob.model.update(delta);

    mob.deathTimer -= delta;
    const t = Math.min(1, 1 - Math.max(mob.deathTimer, 0) / DEATH_SPIN_DURATION);
    mob.model.getGroup().rotation.z = (Math.PI / 2) * t;
    mob.box.position.set(mob.pos.x, mob.pos.y + mob.height / 2, mob.pos.z);

    if (mob.deathTimer <= 0) {
      const pos = mob.pos.clone();
      pos.y += mob.height / 2;
      for (const drop of rollDrops(mob.kind, mob.onFire)) this.onDrop?.(drop.id, drop.count, pos);
      this.onDeath?.(pos);
      this.removeAt(index);
    }
  }

  /** Footstep while moving (grounded only) + a random ambient idle bark - both muted beyond MOB_SOUND_RADIUS of `listenerPos`. */
  private updateSounds(mob: Mob, delta: number, moving: boolean, listenerPos?: THREE.Vector3): void {
    if (!this.soundManager) return;
    const audible = this.inSoundRange(mob, listenerPos);

    if (moving && mob.grounded) {
      mob.stepTimer -= delta;
      if (mob.stepTimer <= 0) {
        mob.stepTimer = STEP_INTERVAL;
        if (audible) playMobSound(this.soundManager, mob.kind, 'step', 0.4);
      }
    } else {
      mob.stepTimer = 0; // next step plays immediately once it starts moving again
    }

    // Timers still tick down out of range, so a mob doesn't "catch up" with
    // a burst of overdue sounds the moment the player walks back within range.
    mob.idleSoundTimer -= delta;
    if (mob.idleSoundTimer <= 0) {
      mob.idleSoundTimer = ri(IDLE_SOUND_MIN * 10, IDLE_SOUND_MAX * 10) / 10;
      if (audible) playMobSound(this.soundManager, mob.kind, 'idle', 0.5);
    }
  }

  private removeAt(index: number): void {
    const mob = this.mobs[index];
    this.scene.remove(mob.model.getGroup());
    this.scene.remove(mob.box);
    this.mobs.splice(index, 1);
  }
}

/** Distance along the ray to the nearest intersection with a sphere, or null if it misses. */
function raySphereDistance(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): number | null {
  const oc = origin.clone().sub(center);
  const b = oc.dot(dir);
  const c = oc.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

// How many spheres to stack along the mob's vertical axis for rayCapsuleDistance.
// Cheap approximation of a true ray-vs-capsule test: with `radius` around
// 0.4-0.45 and heights of 1.3-1.9, 5 evenly-spaced spheres overlap enough to
// cover the whole column with no gaps, without writing exact capsule math.
const CAPSULE_SAMPLES: number = 5;

/**
 * Distance along the ray to the nearest intersection with a vertical capsule
 * spanning the mob's whole hitbox - from `feet.y + radius` up to
 * `feet.y + height - radius` (so the rounded caps land right at the actual
 * feet/head), radius `radius`. Returns null if the ray misses every sample.
 */
function rayCapsuleDistance(origin: THREE.Vector3, dir: THREE.Vector3, feet: THREE.Vector3, height: number, radius: number): number | null {
  const bottomY = feet.y + radius;
  const topY = feet.y + Math.max(height - radius, radius);
  let best: number | null = null;
  for (let i = 0; i < CAPSULE_SAMPLES; i++) {
    const t = CAPSULE_SAMPLES === 1 ? 0 : i / (CAPSULE_SAMPLES - 1);
    const center = new THREE.Vector3(feet.x, THREE.MathUtils.lerp(bottomY, topY, t), feet.z);
    const hit = raySphereDistance(origin, dir, center, radius);
    if (hit !== null && (best === null || hit < best)) best = hit;
  }
  return best;
}

export type { QuadrupedSpec };

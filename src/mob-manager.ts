import * as THREE from 'three';
import { MobModel, BipedMobModel, type QuadrupedSpec, type BipedSpec } from './mob-model';
import { playMobSound } from './mob-sounds';
import type { SoundManager } from './sound-manager';
import type { PathPoint } from './mob-pathfinding';
import { rollDrops } from './mob-drops';
import { overlapsSolid, tryEscapeStuck, updatePhysics } from './mob-physics';
import { updateAI, type MobAiDeps } from './mob-ai';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie' | 'skeleton';
export type MobSpec = QuadrupedSpec | BipedSpec;

/** Biped mobs (rendered/animated via BipedMobModel) - zombie and skeleton today. */
function isBipedKind(kind: MobKind): boolean {
  return kind === 'zombie' || kind === 'skeleton';
}

/** Common surface both MobModel (quadruped) and BipedMobModel (zombie) expose - all MobManager needs. */
type AnyMobModel = {
  getGroup(): THREE.Group;
  setWalking(walking: boolean): void;
  setLightLevel(level01: number): void;
  hurt(): void;
  setDying(on: boolean): void;
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
const MOB_STATS: Record<MobKind, { maxHealth: number; walkSpeed: number; fleeSpeedMult: number; radius: number; height: number }> = {
  pig: { maxHealth: 10, walkSpeed: 2.3, fleeSpeedMult: 1.6, radius: 0.45, height: 0.9 },
  cow: { maxHealth: 10, walkSpeed: 2.0, fleeSpeedMult: 1.6, radius: 0.5, height: 1.4 },
  sheep: { maxHealth: 8, walkSpeed: 2.0, fleeSpeedMult: 1.6, radius: 0.45, height: 1.3 },
  // LCE zombie: 20 HP (10 hearts). No flee behaviour, fleeSpeedMult unused.
  zombie: { maxHealth: 20, walkSpeed: 2.3, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
  // LCE skeleton: 20 HP, runSpeed 0.25 (a bit slower than the zombie's 0.3-ish
  // equivalent) - it mostly stands and shoots rather than closing distance.
  skeleton: { maxHealth: 20, walkSpeed: 2.0, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
};

const BURN_DAMAGE_INTERVAL = 1;  // seconds between sunlight-burn ticks
const BURN_DAMAGE = 1;
const SKY_SCAN_MAX_Y = 156;      // above chunk.ts's CHUNK_HEIGHT (152) - a column open all the way up here really has no roof
const STEP_INTERVAL = 0.45;
const IDLE_SOUND_MIN = 4;
const IDLE_SOUND_MAX = 9;
const MOB_SOUND_RADIUS = 4; // mob sounds (idle/step/hurt/death) only carry this far
const KNOCKBACK_SPEED = 5;
const KNOCKBACK_UP = 4;
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
  // Ranged hostile AI (skeleton): seconds of continuous line-of-sight on the
  // target, accumulated toward RANGED_SIGHT_REQUIRED before the first shot.
  rangedSeeTimer: number;
  // Sunlight burn (zombie/skeleton): ticks damage while exposed, independent of combat.
  burning: boolean;
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
    const model: AnyMobModel = isBipedKind(kind) ? new BipedMobModel(spec as BipedSpec) : new MobModel(spec as QuadrupedSpec);
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
      rangedSeeTimer: 0,
      burning: false,
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
    return mob ? mob.model.getGroup().position : null;
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
      const p = mob.model.getGroup().position;
      if (Math.hypot(p.x - pos.x, p.z - pos.z) > radius) continue;
      if (filter && !filter({ kind: mob.kind, pos: p })) continue;
      n++;
    }
    return n;
  }

  /** Total live mobs matching `filter` (dying ones included), for a spawn cap tracked independently of `count`. */
  countAll(filter: (mob: { kind: MobKind; pos: THREE.Vector3 }) => boolean): number {
    let n = 0;
    for (const mob of this.mobs) {
      if (filter({ kind: mob.kind, pos: mob.model.getGroup().position })) n++;
    }
    return n;
  }

  /** Nearest mob a ray from `origin` toward `dir` (normalised) hits within `maxDist`, or null. */
  raycastMobs(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): MobRaycastHit | null {
    let best: MobRaycastHit | null = null;
    for (const mob of this.mobs) {
      if (mob.dying) continue;
      const center = mob.model.getGroup().position.clone();
      center.y += mob.height / 2;
      const hit = raySphereDistance(origin, dir, center, mob.radius);
      if (hit !== null && hit <= maxDist && (!best || hit < best.distance)) {
        best = { mobId: mob.id, kind: mob.kind, distance: hit };
      }
    }
    return best;
  }

  /** Apply damage; on death, starts the death-spin animation (drops/removal happen once it finishes). Returns true if it died. */
  damage(mobId: number, amount: number, fromPos: THREE.Vector3): boolean {
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

    // Hostile mobs (zombie) never flee - they keep chasing through the hit.
    // Panic (LCE PanicGoal) only applies to passive mobs: forget whatever it
    // was doing and start pathing to a random reachable point away from the attacker.
    if (isHostileKind(mob.kind)) return false;

    const pos = mob.model.getGroup().position;
    mob.fleeDir.set(pos.x - fromPos.x, 0, pos.z - fromPos.z);
    if (mob.fleeDir.lengthSq() < 1e-6) mob.fleeDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    mob.fleeDir.normalize();
    mob.fleeTimer = FLEE_DURATION;
    mob.path = null;

    // Knockback: an instant shove away from the attacker plus a small hop,
    // decaying over the next few frames (see updatePhysics) - independent of
    // (and on top of) the flee movement that starts the same frame.
    mob.velocity.x = mob.fleeDir.x * KNOCKBACK_SPEED;
    mob.velocity.z = mob.fleeDir.z * KNOCKBACK_SPEED;
    mob.velocity.y = KNOCKBACK_UP;
    mob.grounded = false;

    return false;
  }

  update(
    delta: number,
    getLight?: (x: number, y: number, z: number) => number,
    listenerPos?: THREE.Vector3,
    /** Raw sky exposure 0..15 (sun only, ignores torches) at a position - drives zombie sunlight burn. */
    getSkyExposure?: (x: number, y: number, z: number) => number,
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
      if ((mob.kind === 'zombie' || mob.kind === 'skeleton') && getSkyExposure) this.updateBurn(mob, delta, getSkyExposure);
      if (mob.dying) continue; // burn just killed it this frame - death handled next tick

      const group = mob.model.getGroup();
      const moving = mob.path !== null && mob.pathIndex < mob.path.length;
      mob.model.setWalking(moving);

      if (getLight) {
        const p = group.position;
        const level = getLight(Math.round(p.x), Math.round(p.y + mob.height / 2), Math.round(p.z));
        mob.model.setLightLevel(level / 15);
      }
      mob.model.update(delta); // resolves this frame's colour (light tint, or a hurt flash on top)
      this.updateSounds(mob, delta, moving, listenerPos);

      mob.box.position.set(group.position.x, group.position.y + mob.height / 2, group.position.z);
    }
  }

  /**
   * Sunlight burn (zombie): catches fire once sky exposure at its head hits
   * BURN_LIGHT_THRESHOLD (dawn - see main.ts's getSkyExposure), ticking
   * BURN_DAMAGE every BURN_DAMAGE_INTERVAL until it dies or steps back into
   * shade/underground. Independent of combat - reuses the same damage() path
   * so hurt sound/flash/knockback-free death all just work. Water douses it
   * immediately (mob.inWater, already tracked by updatePhysics), and any
   * solid block directly overhead blocks the sun outright regardless of how
   * exposed the sky is laterally - checked last since it's the only one of
   * the three gates that isn't a cheap flag/lookup already in hand.
   */
  private updateBurn(mob: Mob, delta: number, getSkyExposure: (x: number, y: number, z: number) => number): void {
    const p = mob.model.getGroup().position;
    const exposure = getSkyExposure(Math.round(p.x), Math.round(p.y + mob.height), Math.round(p.z));
    mob.burning = exposure >= 12 && !mob.inWater && !this.hasSolidCoverAbove(mob);
    if (!mob.burning) { mob.burnTimer = 0; return; }
    mob.burnTimer -= delta;
    if (mob.burnTimer <= 0) {
      mob.burnTimer = BURN_DAMAGE_INTERVAL;
      this.damage(mob.id, BURN_DAMAGE, p);
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
    const p = mob.model.getGroup().position;
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
    const p = mob.model.getGroup().position;
    return p.distanceTo(pos) <= MOB_SOUND_RADIUS;
  }

  /** Death animation (topples over its Z axis, red-tinted), then drops + a smoke burst + removal. */
  private updateDeath(mob: Mob, delta: number, index: number): void {
    updatePhysics(mob, delta, this.isSolid, this.isWater); // still falls/lands, just no AI movement
    mob.model.setWalking(false);
    mob.model.update(delta);

    mob.deathTimer -= delta;
    const t = Math.min(1, 1 - Math.max(mob.deathTimer, 0) / DEATH_SPIN_DURATION);
    const group = mob.model.getGroup();
    group.rotation.z = (Math.PI / 2) * t;
    mob.box.position.set(group.position.x, group.position.y + mob.height / 2, group.position.z);

    if (mob.deathTimer <= 0) {
      const pos = group.position.clone();
      pos.y += mob.height / 2;
      for (const drop of rollDrops(mob.kind)) this.onDrop?.(drop.id, drop.count, pos);
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

export type { QuadrupedSpec };

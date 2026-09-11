import * as THREE from 'three';
import { MobModel, BipedMobModel, type QuadrupedSpec, type BipedSpec } from './mob-model';
import { BlockId } from './block';
import { ItemId } from './item';
import { playMobSound } from './mob-sounds';
import type { SoundManager } from './sound-manager';
import { findPath, type PathPoint } from './mob-pathfinding';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie';
export type MobSpec = QuadrupedSpec | BipedSpec;

/** Common surface both MobModel (quadruped) and BipedMobModel (zombie) expose - all MobManager needs. */
type AnyMobModel = {
  getGroup(): THREE.Group;
  setWalking(walking: boolean): void;
  setLightLevel(level01: number): void;
  hurt(): void;
  setDying(on: boolean): void;
  update(delta: number): void;
};

const HOSTILE_KINDS: MobKind[] = ['zombie'];
export function isHostileKind(kind: MobKind): boolean {
  return HOSTILE_KINDS.includes(kind);
}

type DropStack = { id: number; count: number };

const ri = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Drop tables (exact ranges as specified): cow gives 0-2 raw beef + 0-1
 * leather, pig gives 0-2 raw porkchop, sheep gives a flat 1 wool + 1 raw
 * mutton. Rolled independently per item, same "may give nothing" pattern as
 * getDrops() in drops.ts.
 */
function rollDrops(kind: MobKind): DropStack[] {
  switch (kind) {
    case 'cow': {
      const out: DropStack[] = [];
      const beef = ri(0, 2);
      if (beef > 0) out.push({ id: ItemId.RAW_BEEF, count: beef });
      const leather = ri(0, 1);
      if (leather > 0) out.push({ id: ItemId.LEATHER, count: leather });
      return out;
    }
    case 'pig': {
      const out: DropStack[] = [];
      const pork = ri(0, 2);
      if (pork > 0) out.push({ id: ItemId.RAW_PORKCHOP, count: pork });
      return out;
    }
    case 'sheep':
      return [{ id: BlockId.WOOL, count: 1 }, { id: ItemId.RAW_MUTTON, count: 1 }];
    case 'zombie': {
      const out: DropStack[] = [];
      const flesh = ri(0, 2);
      if (flesh > 0) out.push({ id: ItemId.ROTTEN_FLESH, count: flesh });
      if (Math.random() < 0.005) {
        const rare = [ItemId.FLINT, ItemId.FEATHER, ItemId.POTATO, ItemId.CARROT, ItemId.IRON_INGOT];
        out.push({ id: rare[Math.floor(Math.random() * rare.length)], count: 1 });
      }
      return out;
    }
  }
}

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
};

const CHASE_RADIUS = 16;         // blocks - zombie notices/keeps chasing the player within this range
const CHASE_REPATH_INTERVAL = 1; // seconds between chase path re-plans
const ATTACK_RANGE = 2.2;        // blocks, centre-to-centre (a bit past melee-adjacent so it doesn't need to be pixel-perfect on top of the player)
const ATTACK_INTERVAL = 1;       // seconds between hits while in range
const ZOMBIE_ATTACK_DAMAGE = 3;  // LCE zombie base melee damage
const ZOMBIE_STEP_UP = 1;        // jump height is physical (JUMP_FORCE/GRAVITY), same as animals - widening this would plan climbs it can't execute
const ZOMBIE_STEP_DOWN = 3;      // a zombie will drop off a 3-block ledge chasing the player; gravity handles the descent, no jump needed
const BURN_DAMAGE_INTERVAL = 1;  // seconds between sunlight-burn ticks
const BURN_DAMAGE = 1;
const SKY_SCAN_MAX_Y = 156;      // above chunk.ts's CHUNK_HEIGHT (152) - a column open all the way up here really has no roof

const GRAVITY = 24;
const JUMP_FORCE = 8; // matches the player's own jump impulse (player-physics.ts)
const FLEE_DURATION = 3; // seconds, LCE PanicGoal-style
const WANDER_RADIUS_MIN = 6; // "de minimo 6 bloques"
const WANDER_RADIUS_MAX = 12; // "un bloque aleatorio en un radio de 12 bloques"
const WANDER_INTERVAL_MIN = 8; // "se moverán cada 8-12s"
const WANDER_INTERVAL_MAX = 12;
const IDLE_LOOK_INTERVAL = 4; // "girar para mirar cada 4s si están quietos"
const LOOK_DURATION_MIN = 1.2; // slower look-around turn than a walking turn
const LOOK_DURATION_MAX = 2.0;
const FLEE_RADIUS_MIN = 4; // "correrán hacia un bloque aleatorio en un radio de 8 bloques"
const FLEE_RADIUS_MAX = 8;
const FLEE_REPATH_CONE = Math.PI / 2; // random point within +-90 deg of "away from the attacker"
const WAYPOINT_REACH_DIST = 0.3;
const TURN_RATE = 10; // yaw-easing rate while walking; higher = snappier turning
const LOOK_TURN_RATE = 2.5; // slower easing rate for an idle look-around turn
const STEP_INTERVAL = 0.45;
const IDLE_SOUND_MIN = 4;
const IDLE_SOUND_MAX = 9;
const MOB_SOUND_RADIUS = 4; // mob sounds (idle/step/hurt/death) only carry this far
const KNOCKBACK_SPEED = 5;
const KNOCKBACK_UP = 4;
// Same feel as the player (player-physics.ts): velocity ramps toward the AI's
// target speed instead of snapping to it, and decays via friction instead of
// stopping dead - so a mob accelerates, and skids/drifts when it turns or
// stops, the same way the player does. Knockback is just an impulse added to
// the same velocity, so it blends into (or gets overridden by) that ramp
// instead of needing its own separate decay.
const MOB_ACCELERATION = 35;
const MOB_FRICTION = 15;
const MOB_AIR_ACCEL_MULT = 0.15; // much less control while airborne, matches the player
const WATER_BUOYANCY = 18; // upward accel while submerged, LCE-ish "float up" feel
const WATER_RISE_SPEED = 2.2; // cap on how fast a mob bobs upward
const WATER_RECHECK_INTERVAL = 1; // how often a swimming mob looks for shore
const DEATH_SPIN_DURATION = 0.75; // seconds toppling over its Z axis before vanishing

// Shared wireframe box geometry/material for the debug hitbox (R key) - one
// GPU resource, scaled per mob instance, same pattern as DroppedItems' boxes.
const hitboxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const hitboxMat = new THREE.LineBasicMaterial({ color: 0x00ffff });

type Mob = {
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
  // Sunlight burn (zombie): ticks damage while exposed, independent of combat.
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
  ) {}

  spawn(kind: MobKind, spec: MobSpec, pos: THREE.Vector3, yaw: number): void {
    const stats = MOB_STATS[kind];
    const model: AnyMobModel = kind === 'zombie' ? new BipedMobModel(spec as BipedSpec) : new MobModel(spec as QuadrupedSpec);
    const group = model.getGroup();
    group.position.copy(pos);
    group.rotation.y = yaw;
    this.scene.add(group);

    const box = new THREE.LineSegments(hitboxGeo, hitboxMat);
    box.scale.set(stats.radius * 2, stats.height, stats.radius * 2);
    box.visible = this.debug;
    box.position.set(pos.x, pos.y + stats.height / 2, pos.z);
    this.scene.add(box);

    this.mobs.push({
      id: this.nextId++,
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
      burning: false,
      burnTimer: 0,
      dying: false,
      deathTimer: 0,
      stepTimer: 0,
      idleSoundTimer: ri(IDLE_SOUND_MIN * 10, IDLE_SOUND_MAX * 10) / 10,
      box,
    });
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

      this.updateAI(mob, delta);
      this.updatePhysics(mob, delta);
      if (mob.kind === 'zombie' && getSkyExposure) this.updateBurn(mob, delta, getSkyExposure);
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
    this.updatePhysics(mob, delta); // still falls/lands, just no AI movement
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

  private updateAI(mob: Mob, delta: number): void {
    if (isHostileKind(mob.kind) && this.updateHostileAI(mob, delta)) return;

    if (mob.fleeTimer > 0) {
      mob.fleeTimer -= delta;
      if (!mob.path || mob.pathIndex >= mob.path.length) this.pickFleeTarget(mob);
      this.followPath(mob, mob.walkSpeed * mob.fleeSpeedMult, delta);
      return;
    }

    // In water: mostly avoided by wander/flee (findPath only lays a ground
    // node on solid, non-submerged footing), but a mob can still end up here
    // by falling in - float and beeline for the nearest dry footing.
    if (mob.inWater) {
      mob.waterCheckTimer -= delta;
      if ((!mob.path || mob.pathIndex >= mob.path.length) && mob.waterCheckTimer <= 0) {
        mob.waterCheckTimer = WATER_RECHECK_INTERVAL;
        this.trySwimToShore(mob);
      }
      if (mob.path) this.followPath(mob, mob.walkSpeed, delta);
      else this.applyGroundFriction(mob, delta);
      return;
    }

    if (mob.path && mob.pathIndex < mob.path.length) {
      this.followPath(mob, mob.walkSpeed, delta);
      return;
    }

    // Idle: no path to walk, so friction bleeds off any residual velocity
    // (knockback, or momentum from having just arrived). Two independent
    // timers also run while stationary - a periodic look-around turn every
    // IDLE_LOOK_INTERVAL seconds, and the WANDER_INTERVAL_MIN..MAX cadence
    // that picks the next place to walk to.
    this.applyGroundFriction(mob, delta);
    if (mob.lookTimer > 0) {
      mob.lookTimer -= delta;
      this.easeYawTo(mob, mob.lookTargetYaw, delta, LOOK_TURN_RATE);
    }
    mob.idleLookTimer -= delta;
    if (mob.idleLookTimer <= 0) {
      mob.idleLookTimer = IDLE_LOOK_INTERVAL;
      mob.lookTimer = LOOK_DURATION_MIN + Math.random() * (LOOK_DURATION_MAX - LOOK_DURATION_MIN);
      mob.lookTargetYaw = Math.random() * Math.PI * 2 - Math.PI;
    }

    mob.decisionTimer -= delta;
    if (mob.decisionTimer <= 0) this.pickWanderTarget(mob);
  }

  /**
   * Hostile targeting (zombie): while the player is within CHASE_RADIUS,
   * chase and melee them, re-pathing every CHASE_REPATH_INTERVAL; returns
   * true to tell updateAI() this frame's movement is already handled. Once
   * the player leaves range, returns false so the mob falls through to the
   * exact same wander/idle-look behaviour animals use (per the design:
   * hostile idle == animal idle).
   */
  private updateHostileAI(mob: Mob, delta: number): boolean {
    const playerPos = this.getPlayerPos?.();
    const pos = mob.model.getGroup().position;
    if (!playerPos) {
      mob.chasing = false;
      mob.attackTimer = 0;
      return false;
    }

    // Horizontal distance only: playerPos is the player's EYE position (see
    // main.ts spawn/attack wiring), roughly 1.6 blocks above their feet, so a
    // 3D distanceTo() here made a zombie standing right next to the player
    // read as ~1.6+ blocks away and never enter ATTACK_RANGE - the bug behind
    // "the zombie doesn't attack". Horizontal distance is what actually
    // matters for melee reach; a generous vertical gate below just keeps a
    // zombie on a completely different floor from "reaching through" it.
    const dx = playerPos.x - pos.x;
    const dz = playerPos.z - pos.z;
    const dy = playerPos.y - pos.y;
    const dist = Math.hypot(dx, dz);
    if (dist > CHASE_RADIUS || Math.abs(dy) > CHASE_RADIUS) {
      mob.chasing = false;
      mob.attackTimer = 0;
      return false;
    }
    mob.chasing = true;

    if (dist <= ATTACK_RANGE && Math.abs(dy) <= mob.height + 1) {
      mob.path = null;
      this.applyGroundFriction(mob, delta);
      this.easeYawTo(mob, Math.atan2(-dx, -dz), delta, TURN_RATE);
      mob.attackTimer -= delta;
      if (mob.attackTimer <= 0) {
        mob.attackTimer = ATTACK_INTERVAL;
        this.onAttackPlayer?.(ZOMBIE_ATTACK_DAMAGE, pos.clone());
      }
      return true;
    }

    mob.attackTimer = 0;
    mob.chaseRepathTimer -= delta;
    if (!mob.path || mob.pathIndex >= mob.path.length || mob.chaseRepathTimer <= 0) {
      mob.chaseRepathTimer = CHASE_REPATH_INTERVAL;
      const path = findPath(this.isSolid, pos, playerPos.x, playerPos.z, 150, ZOMBIE_STEP_UP, ZOMBIE_STEP_DOWN);
      if (path) {
        mob.path = path;
        mob.pathIndex = 1;
      } else {
        // No graph path (e.g. the zombie itself fell into a pit deeper than
        // ZOMBIE_STEP_UP/DOWN can bridge) - walk straight at the player anyway.
        // updatePhysics's collision + auto-step jump still runs on this raw
        // movement, so it can climb out through any ledge/step A* missed,
        // the same "boxed in" fallback pickFleeTarget already uses.
        mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: playerPos.x, y: pos.y, z: playerPos.z }];
        mob.pathIndex = 1;
      }
    }
    if (mob.path) this.followPath(mob, mob.walkSpeed, delta);
    else this.applyGroundFriction(mob, delta);
    return true;
  }

  /**
   * Path::A* (mob-pathfinding.ts) to a random reachable point within
   * WANDER_RADIUS_MIN..MAX blocks. When A* finds nothing at all - most
   * commonly a mob that fell into a hole deeper than a single jump can
   * bridge in the graph search - walk straight toward that random point
   * anyway instead of standing still forever. That raw movement still goes
   * through updatePhysics's collision + auto-step jump, so it keeps
   * bumping/hopping against whatever's blocking it each time this gets
   * re-picked, which is enough to climb out of a shallow (~1 block) pit or
   * over a step the graph search missed, even though it can't guarantee an
   * escape from a hole deeper than a mob can physically jump.
   */
  private pickWanderTarget(mob: Mob): void {
    const pos = mob.model.getGroup().position;
    const angle = Math.random() * Math.PI * 2;
    const radius = WANDER_RADIUS_MIN + Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN);
    const goalX = pos.x + Math.sin(angle) * radius;
    const goalZ = pos.z + Math.cos(angle) * radius;
    const path = findPath(this.isSolid, pos, goalX, goalZ);
    if (path) {
      mob.path = path;
      mob.pathIndex = 1; // path[0] is the mob's own current cell
    } else {
      mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: goalX, y: pos.y, z: goalZ }];
      mob.pathIndex = 1;
    }
  }

  /**
   * LCE/loro PanicGoal-style: a random reachable point within FLEE_RADIUS,
   * biased away from whatever last hurt this mob, re-picked whenever the
   * current escape path runs out while still panicking.
   */
  private pickFleeTarget(mob: Mob): void {
    const pos = mob.model.getGroup().position;
    const baseAngle = Math.atan2(mob.fleeDir.x, mob.fleeDir.z);
    const angle = baseAngle + (Math.random() - 0.5) * FLEE_REPATH_CONE;
    const radius = FLEE_RADIUS_MIN + Math.random() * (FLEE_RADIUS_MAX - FLEE_RADIUS_MIN);
    const goalX = pos.x + Math.sin(angle) * radius;
    const goalZ = pos.z + Math.cos(angle) * radius;
    const path = findPath(this.isSolid, pos, goalX, goalZ);
    if (path) {
      mob.path = path;
      mob.pathIndex = 1;
    } else {
      // Boxed in / nothing reachable - shuffle directly away for a moment
      // rather than standing still and panicking in place.
      mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: pos.x + mob.fleeDir.x * 2, y: pos.y, z: pos.z + mob.fleeDir.z * 2 }];
      mob.pathIndex = 1;
    }
  }

  /** Scans a handful of random nearby spots for dry, standable footing and heads straight there. */
  private trySwimToShore(mob: Mob): void {
    if (!this.isWater) return;
    const pos = mob.model.getGroup().position;
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 3 + Math.random() * 3;
      const gx = pos.x + Math.sin(angle) * radius;
      const gz = pos.z + Math.cos(angle) * radius;
      const gxr = Math.round(gx);
      const gzr = Math.round(gz);
      for (let dy = 2; dy >= -2; dy--) {
        const by = Math.round(pos.y) + dy;
        if (
          this.isSolid(gxr, by, gzr) &&
          !this.isWater(gxr, by, gzr) &&
          !this.isSolid(gxr, by + 1, gzr) &&
          !this.isSolid(gxr, by + 2, gzr)
        ) {
          mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: gx, y: by + 0.5, z: gz }];
          mob.pathIndex = 1;
          return;
        }
      }
    }
  }

  /** Steps `mob` toward its current path waypoint, advancing to the next one once close enough. */
  private followPath(mob: Mob, speed: number, delta: number): void {
    if (!mob.path || mob.pathIndex >= mob.path.length) return;
    const group = mob.model.getGroup();
    const wp = mob.path[mob.pathIndex];
    const dx = wp.x - group.position.x;
    const dz = wp.z - group.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < WAYPOINT_REACH_DIST) {
      mob.pathIndex++;
      if (mob.pathIndex >= mob.path.length) {
        mob.path = null;
        mob.decisionTimer = ri(WANDER_INTERVAL_MIN * 10, WANDER_INTERVAL_MAX * 10) / 10;
      }
      return;
    }
    this.moveHorizontal(mob, dx / dist, dz / dist, speed, delta);
  }

  /**
   * Ramps `mob.velocity`.x/z toward (dirX,dirZ)*speed - same acceleration
   * curve as the player (moveTowards, capped by MOB_ACCELERATION*delta, with
   * reduced air control) instead of snapping straight to it, so a mob picks
   * up speed and skids/drifts when it changes direction. The actual position
   * integration, collision and auto-step jumping happen once for all of a
   * mob's horizontal velocity (AI movement AND any leftover knockback) in
   * updatePhysics. Also eases the facing yaw toward the direction of travel.
   */
  private moveHorizontal(mob: Mob, dirX: number, dirZ: number, speed: number, delta: number): void {
    const accel = MOB_ACCELERATION * (mob.grounded ? 1 : MOB_AIR_ACCEL_MULT);
    const maxStep = accel * delta;
    mob.velocity.x = this.moveTowards(mob.velocity.x, dirX * speed, maxStep);
    mob.velocity.z = this.moveTowards(mob.velocity.z, dirZ * speed, maxStep);

    // Object3D at rotation.y=θ has local -Z (this model's "front" - see
    // mob-model.ts) pointing world (-sinθ,-cosθ), so the target yaw is the
    // negated atan2 - the un-negated form points the model's BACK the way
    // it's walking (a moonwalk).
    this.easeYawTo(mob, Math.atan2(-dirX, -dirZ), delta, TURN_RATE);
  }

  /** Decays `mob.velocity`.x/z toward 0 (ground friction) - called instead of moveHorizontal whenever the AI has nowhere to walk to right now. */
  private applyGroundFriction(mob: Mob, delta: number): void {
    const frictionFactor = Math.max(0, 1 - MOB_FRICTION * delta);
    mob.velocity.x *= frictionFactor;
    mob.velocity.z *= frictionFactor;
  }

  /** Move a value toward a target by at most maxStep - linear, frame-rate independent, never overshoots. */
  private moveTowards(current: number, target: number, maxStep: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxStep) return target;
    return current + Math.sign(diff) * maxStep;
  }

  /** Eases `mob`'s facing yaw toward `targetYaw` by the shortest angular path at `rate` and applies it to the model. */
  private easeYawTo(mob: Mob, targetYaw: number, delta: number, rate: number): void {
    let deltaYaw = targetYaw - mob.facingYaw;
    deltaYaw = ((deltaYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    mob.facingYaw += deltaYaw * Math.min(1, rate * delta);
    mob.model.getGroup().rotation.y = mob.facingYaw;
  }

  /** Does mob's hitbox (a `radius`-wide, `height`-tall column centred on x,z with feet at feetY) overlap any solid block? */
  private overlapsSolid(x: number, feetY: number, z: number, radius: number, height: number): boolean {
    const x0 = Math.round(x - radius), x1 = Math.round(x + radius);
    const z0 = Math.round(z - radius), z1 = Math.round(z + radius);
    const y0 = Math.round(feetY + 0.05), y1 = Math.round(feetY + height - 0.05);
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        for (let by = y0; by <= y1; by++) {
          if (this.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Integrates `mob.velocity` for one frame: horizontal (whatever combination
   * of AI-ramped movement, ground/air friction and knockback moveHorizontal /
   * applyGroundFriction / damage() left in velocity.x/z) resolved per-axis
   * against collision with auto-step jumping, then gravity/buoyancy and a
   * ground snap (sample the block below, land on its top) for velocity.y.
   */
  private updatePhysics(mob: Mob, delta: number): void {
    const group = mob.model.getGroup();
    const y = group.position.y;

    if (Math.abs(mob.velocity.x) > 0.001 || Math.abs(mob.velocity.z) > 0.001) {
      // Only a block that's still solid one step higher counts as "truly
      // stuck" - a block that's merely solid at foot height but clear above
      // is jumped instead. While airborne mid-jump (grounded false), a
      // horizontal block is expected for the frame or two before the arc
      // clears it, so it must NOT abandon the path - that was the bug where a
      // mob would hop in place forever: each jump attempt still found itself
      // blocked the very next frame (still mid-arc) and immediately threw
      // the path away before it ever got the chance to clear the obstacle.
      let stuckGrounded = false;

      const tryX = group.position.x + mob.velocity.x * delta;
      if (!this.overlapsSolid(tryX, y, group.position.z, mob.radius, mob.height)) {
        group.position.x = tryX;
      } else if (mob.grounded && !this.overlapsSolid(tryX, y + 1, group.position.z, mob.radius, mob.height)) {
        mob.velocity.y = JUMP_FORCE;
        mob.grounded = false;
      } else {
        mob.velocity.x = 0;
        if (mob.grounded) stuckGrounded = true;
      }

      const tryZ = group.position.z + mob.velocity.z * delta;
      if (!this.overlapsSolid(group.position.x, y, tryZ, mob.radius, mob.height)) {
        group.position.z = tryZ;
      } else if (mob.grounded && !this.overlapsSolid(group.position.x, y + 1, tryZ, mob.radius, mob.height)) {
        mob.velocity.y = JUMP_FORCE;
        mob.grounded = false;
      } else {
        mob.velocity.z = 0;
        if (mob.grounded) stuckGrounded = true;
      }

      if (stuckGrounded && mob.path) {
        // Genuinely blocked on solid ground with no step to hop -
        // pathfinding missed it, or the world changed under it. Drop the
        // path and take a short beat before re-deciding, instead of
        // grinding against the wall every frame.
        mob.path = null;
        mob.decisionTimer = 0.3;
      }
    }

    const feetX = Math.round(group.position.x);
    const feetZ = Math.round(group.position.z);
    const feetBlockYNow = Math.round(group.position.y);
    mob.inWater = !!this.isWater && (this.isWater(feetX, feetBlockYNow, feetZ) || this.isWater(feetX, feetBlockYNow + 1, feetZ));

    if (mob.inWater) {
      // Float toward the surface instead of sinking, and skip the normal
      // ground-snap while submerged.
      mob.velocity.y = Math.min(mob.velocity.y + WATER_BUOYANCY * delta, WATER_RISE_SPEED);
      group.position.y += mob.velocity.y * delta;
      mob.grounded = false;
      return;
    }

    mob.velocity.y -= GRAVITY * delta;
    const nextY = group.position.y + mob.velocity.y * delta;

    // Blocks are centred on integer coordinates (span [n-0.5, n+0.5] - see
    // chunk.ts's BlockCollider), so the ground block's top surface sits at
    // its own index + 0.5, not +1.
    const feetBlockY = Math.floor(nextY - 0.05);
    if (mob.velocity.y <= 0 && this.isSolid(Math.round(group.position.x), feetBlockY, Math.round(group.position.z))) {
      group.position.y = feetBlockY + 0.5;
      mob.velocity.y = 0;
      mob.grounded = true;
    } else {
      group.position.y = nextY;
      mob.grounded = false;
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

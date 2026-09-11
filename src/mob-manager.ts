import * as THREE from 'three';
import { MobModel, type QuadrupedSpec } from './mob-model';
import { BlockId } from './block';
import { ItemId } from './item';
import { playMobSound } from './mob-sounds';
import type { SoundManager } from './sound-manager';
import { findPath, type PathPoint } from './mob-pathfinding';

export type MobKind = 'pig' | 'cow' | 'sheep';

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
};

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
const DEATH_SPIN_DURATION = 0.5; // seconds toppling over its Z axis before vanishing

// Shared wireframe box geometry/material for the debug hitbox (R key) - one
// GPU resource, scaled per mob instance, same pattern as DroppedItems' boxes.
const hitboxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const hitboxMat = new THREE.LineBasicMaterial({ color: 0x00ffff });

type Mob = {
  id: number;
  kind: MobKind;
  model: MobModel;
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
  ) {}

  spawn(kind: MobKind, spec: QuadrupedSpec, pos: THREE.Vector3, yaw: number): void {
    const stats = MOB_STATS[kind];
    const model = new MobModel(spec);
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
      if (this.soundManager) playMobSound(this.soundManager, mob.kind, 'death', 0.8);
      mob.dying = true;
      mob.deathTimer = DEATH_SPIN_DURATION;
      mob.path = null;
      mob.velocity.x = 0;
      mob.velocity.z = 0;
      mob.model.setDying(true);
      return true;
    }
    if (this.soundManager) playMobSound(this.soundManager, mob.kind, 'hurt', 0.7);
    mob.model.hurt(); // 0.2s red flash

    // Panic (LCE PanicGoal): forget whatever it was doing and start pathing
    // to a random reachable point biased away from the attacker.
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

  update(delta: number, getLight?: (x: number, y: number, z: number) => number): void {
    // Reverse iteration: updateDeath() may splice a finished mob out mid-loop.
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];

      if (mob.dying) {
        this.updateDeath(mob, delta, i);
        continue;
      }

      this.updateAI(mob, delta);
      this.updatePhysics(mob, delta);

      const group = mob.model.getGroup();
      const moving = mob.path !== null && mob.pathIndex < mob.path.length;
      mob.model.setWalking(moving);

      if (getLight) {
        const p = group.position;
        const level = getLight(Math.round(p.x), Math.round(p.y + mob.height / 2), Math.round(p.z));
        mob.model.setLightLevel(level / 15);
      }
      mob.model.update(delta); // resolves this frame's colour (light tint, or a hurt flash on top)
      this.updateSounds(mob, delta, moving);

      mob.box.position.set(group.position.x, group.position.y + mob.height / 2, group.position.z);
    }
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

  /** Footstep while moving (grounded only) + a random ambient idle bark. */
  private updateSounds(mob: Mob, delta: number, moving: boolean): void {
    if (!this.soundManager) return;

    if (moving && mob.grounded) {
      mob.stepTimer -= delta;
      if (mob.stepTimer <= 0) {
        mob.stepTimer = STEP_INTERVAL;
        playMobSound(this.soundManager, mob.kind, 'step', 0.4);
      }
    } else {
      mob.stepTimer = 0; // next step plays immediately once it starts moving again
    }

    mob.idleSoundTimer -= delta;
    if (mob.idleSoundTimer <= 0) {
      mob.idleSoundTimer = ri(IDLE_SOUND_MIN * 10, IDLE_SOUND_MAX * 10) / 10;
      playMobSound(this.soundManager, mob.kind, 'idle', 0.5);
    }
  }

  private updateAI(mob: Mob, delta: number): void {
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

  /** Path::A* (mob-pathfinding.ts) to a random reachable point within WANDER_RADIUS_MIN..MAX blocks. */
  private pickWanderTarget(mob: Mob): void {
    const pos = mob.model.getGroup().position;
    const angle = Math.random() * Math.PI * 2;
    const radius = WANDER_RADIUS_MIN + Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN);
    const path = findPath(this.isSolid, pos, pos.x + Math.sin(angle) * radius, pos.z + Math.cos(angle) * radius);
    if (path) {
      mob.path = path;
      mob.pathIndex = 1; // path[0] is the mob's own current cell
    } else {
      mob.path = null;
      mob.decisionTimer = 1; // nowhere reachable - try again shortly
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

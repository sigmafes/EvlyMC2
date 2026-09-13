import * as THREE from 'three';
import { findPath } from './mob-pathfinding';
import type { Mob } from './mob-manager';
import { isHostileKind } from './mob-manager';
import { followPath, applyGroundFriction, easeYawTo, moveHorizontal, TURN_RATE, type IsSolidFn, type IsWaterFn } from './mob-physics';

const CHASE_RADIUS = 16;         // blocks - zombie notices/keeps chasing the player within this range
const CHASE_REPATH_INTERVAL = 1; // seconds between chase path re-plans
const ATTACK_RANGE = 1.8;        // blocks, centre-to-centre (a bit past melee-adjacent so it doesn't need to be pixel-perfect on top of the player)
const LEAP_RANGE = 4;            // blocks, horizontal - close enough to attempt a leap up toward a player standing above
const LEAP_MIN_HEIGHT_DIFF = 1.2; // blocks - player has to be genuinely above, not just on a half-slab-ish bump
const LEAP_UP_FORCE = 11;        // higher arc than JUMP_FORCE (8) - clears ~2.5 blocks instead of ~1.3
const ATTACK_INTERVAL = 1;       // seconds between hits while in range
const ZOMBIE_ATTACK_DAMAGE = 3;  // LCE zombie base melee damage
const ZOMBIE_STEP_UP = 1;        // jump height is physical (JUMP_FORCE/GRAVITY), same as animals - widening this would plan climbs it can't execute
const ZOMBIE_STEP_DOWN = 3;      // a zombie will drop off a 3-block ledge chasing the player; gravity handles the descent, no jump needed

const RANGED_SHOT_HEIGHT_FRACTION = 0.55; // fraction of mob.height the arrow leaves from (torso, not feet - pos is the feet-level group origin)
const RANGED_ATTACK_RADIUS = 10;      // blocks - LCE ArrowAttackGoal attackRadiusSqr (skeleton)
const RANGED_ATTACK_INTERVAL = 3;     // seconds between shots (LCE TICKS_PER_SECOND * 3)
const RANGED_SIGHT_REQUIRED = 1;      // seconds of continuous line-of-sight required before the first shot (LCE seeTime >= 20 ticks)
const RANGED_STEP_UP = 1;
const RANGED_STEP_DOWN = 3;
const LOS_SAMPLE_STEP = 0.5;          // blocks between line-of-sight samples

const WANDER_RADIUS_MIN = 6; // "de minimo 6 bloques"
const WANDER_RADIUS_MAX = 12; // "un bloque aleatorio en un radio de 12 bloques"
const IDLE_LOOK_INTERVAL = 4; // "girar para mirar cada 4s si están quietos"
const LOOK_DURATION_MIN = 1.2; // slower look-around turn than a walking turn
const LOOK_DURATION_MAX = 2.0;
const FLEE_RADIUS_MIN = 4; // "correrán hacia un bloque aleatorio en un radio de 8 bloques"
const FLEE_RADIUS_MAX = 8;
const FLEE_REPATH_CONE = Math.PI / 2; // random point within +-90 deg of "away from the attacker"
const LOOK_TURN_RATE = 2.5; // slower easing rate for an idle look-around turn
const WATER_RECHECK_INTERVAL = 1; // how often a swimming mob looks for shore

export type MobAiDeps = {
  isSolid: IsSolidFn;
  isWater?: IsWaterFn;
  /** Hostile mobs (zombie) attack the player when in range - damage + the attacker's position (for knockback direction) flow back through this. */
  onAttackPlayer?: (damage: number, fromPos: THREE.Vector3) => void;
  /** Player position, for hostile mobs to detect/chase - undefined disables chasing entirely. */
  getPlayerPos?: () => THREE.Vector3;
  /** Ranged hostile mobs (skeleton) fire an arrow through this instead of a direct hit. */
  onShootArrow?: (fromPos: THREE.Vector3, targetPos: THREE.Vector3) => void;
};

export function updateAI(mob: Mob, delta: number, deps: MobAiDeps): void {
  if (mob.kind === 'skeleton') {
    if (updateRangedHostileAI(mob, delta, deps)) return;
  } else if (isHostileKind(mob.kind) && updateHostileAI(mob, delta, deps)) {
    return;
  }

  if (mob.fleeTimer > 0) {
    mob.fleeTimer -= delta;
    if (!mob.path || mob.pathIndex >= mob.path.length) pickFleeTarget(mob, deps);
    followPath(mob, mob.walkSpeed * mob.fleeSpeedMult, delta);
    return;
  }

  // In water: mostly avoided by wander/flee (findPath only lays a ground
  // node on solid, non-submerged footing), but a mob can still end up here
  // by falling in - float and beeline for the nearest dry footing.
  if (mob.inWater) {
    mob.waterCheckTimer -= delta;
    if ((!mob.path || mob.pathIndex >= mob.path.length) && mob.waterCheckTimer <= 0) {
      mob.waterCheckTimer = WATER_RECHECK_INTERVAL;
      trySwimToShore(mob, deps);
    }
    if (mob.path) followPath(mob, mob.walkSpeed, delta);
    else applyGroundFriction(mob, delta);
    return;
  }

  if (mob.path && mob.pathIndex < mob.path.length) {
    followPath(mob, mob.walkSpeed, delta);
    return;
  }

  // Idle: no path to walk, so friction bleeds off any residual velocity
  // (knockback, or momentum from having just arrived). Two independent
  // timers also run while stationary - a periodic look-around turn every
  // IDLE_LOOK_INTERVAL seconds, and the WANDER_INTERVAL_MIN..MAX cadence
  // (mob-physics.ts's followPath) that picks the next place to walk to.
  applyGroundFriction(mob, delta);
  if (mob.lookTimer > 0) {
    mob.lookTimer -= delta;
    easeYawTo(mob, mob.lookTargetYaw, delta, LOOK_TURN_RATE);
  }
  mob.idleLookTimer -= delta;
  if (mob.idleLookTimer <= 0) {
    mob.idleLookTimer = IDLE_LOOK_INTERVAL;
    mob.lookTimer = LOOK_DURATION_MIN + Math.random() * (LOOK_DURATION_MAX - LOOK_DURATION_MIN);
    mob.lookTargetYaw = Math.random() * Math.PI * 2 - Math.PI;
  }

  mob.decisionTimer -= delta;
  if (mob.decisionTimer <= 0) pickWanderTarget(mob, deps);
}

/**
 * Hostile targeting (zombie): while the player is within CHASE_RADIUS,
 * chase and melee them, re-pathing every CHASE_REPATH_INTERVAL; returns
 * true to tell updateAI() this frame's movement is already handled. Once
 * the player leaves range, returns false so the mob falls through to the
 * exact same wander/idle-look behaviour animals use (per the design:
 * hostile idle == animal idle).
 */
function updateHostileAI(mob: Mob, delta: number, deps: MobAiDeps): boolean {
  const playerPos = deps.getPlayerPos?.();
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
    // Zero instantly, not applyGroundFriction's gradual decay: at melee range
    // `dist` can flap in and out of ATTACK_RANGE by a hair (chase re-adds
    // walkSpeed-worth of velocity, friction only bleeds a fraction of it off
    // per frame), and any leftover horizontal velocity bumping a step/ledge
    // triggers updatePhysics's auto-step jump - reads as the zombie
    // continuously hopping in place while it's supposed to just stand and
    // swing.
    mob.velocity.x = 0;
    mob.velocity.z = 0;
    easeYawTo(mob, Math.atan2(-dx, -dz), delta, TURN_RATE);
    mob.attackTimer -= delta;
    if (mob.attackTimer <= 0) {
      mob.attackTimer = ATTACK_INTERVAL;
      deps.onAttackPlayer?.(ZOMBIE_ATTACK_DAMAGE, pos.clone());
    }
    return true;
  }

  // Leap: the player is above and close but the normal walk/step-up limits
  // (ZOMBIE_STEP_UP=1) can't close that gap - e.g. player standing over a
  // hole in a cave ceiling, or up on a ledge. Throw the mob upward and
  // toward the player instead of just walking into the wall underneath
  // them; updatePhysics's own collision still governs whether it actually
  // clears the gap, this just gives it a much bigger arc to try with.
  if (mob.grounded && dy >= LEAP_MIN_HEIGHT_DIFF && dist <= LEAP_RANGE) {
    mob.path = null;
    const dirLen = Math.max(dist, 0.001);
    moveHorizontal(mob, dx / dirLen, dz / dirLen, mob.walkSpeed, delta);
    mob.velocity.y = LEAP_UP_FORCE;
    mob.grounded = false;
    return true;
  }

  mob.attackTimer = 0;
  mob.chaseRepathTimer -= delta;
  if (!mob.path || mob.pathIndex >= mob.path.length || mob.chaseRepathTimer <= 0) {
    mob.chaseRepathTimer = CHASE_REPATH_INTERVAL;
    const path = findPath(deps.isSolid, pos, playerPos.x, playerPos.z, 150, ZOMBIE_STEP_UP, ZOMBIE_STEP_DOWN);
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
  if (mob.path) followPath(mob, mob.walkSpeed, delta);
  else applyGroundFriction(mob, delta);
  return true;
}

/** Samples points along the segment from `from` to `to`, `isSolid` at any of them blocks the view. */
function hasLineOfSight(isSolid: IsSolidFn, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const steps = Math.max(1, Math.ceil(dist / LOS_SAMPLE_STEP));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    if (isSolid(Math.round(from.x + dx * t), Math.round(from.y + dy * t), Math.round(from.z + dz * t))) return false;
  }
  return true;
}

/**
 * Ranged hostile targeting (skeleton, ported from LCE ArrowAttackGoal): while
 * the player is within CHASE_RADIUS, close the distance until inside
 * RANGED_ATTACK_RADIUS; once there and having held continuous line-of-sight
 * for RANGED_SIGHT_REQUIRED, stop and fire every RANGED_ATTACK_INTERVAL
 * instead of a direct melee hit - the actual arrow entity is spawned by
 * whoever provides `onShootArrow` (main.ts's arrow-projectiles), this only
 * decides when to shoot. Same true/false contract as updateHostileAI().
 */
function updateRangedHostileAI(mob: Mob, delta: number, deps: MobAiDeps): boolean {
  const playerPos = deps.getPlayerPos?.();
  const pos = mob.model.getGroup().position;
  if (!playerPos) {
    mob.chasing = false;
    mob.attackTimer = 0;
    mob.rangedSeeTimer = 0;
    mob.model.setAttacking?.(false);
    return false;
  }

  const dx = playerPos.x - pos.x;
  const dz = playerPos.z - pos.z;
  const dy = playerPos.y - pos.y;
  const dist = Math.hypot(dx, dz);
  if (dist > CHASE_RADIUS || Math.abs(dy) > CHASE_RADIUS) {
    mob.chasing = false;
    mob.attackTimer = 0;
    mob.rangedSeeTimer = 0;
    mob.model.setAttacking?.(false);
    return false;
  }
  mob.chasing = true;

  const eyePos = new THREE.Vector3(pos.x, pos.y + mob.height * 0.85, pos.z);
  const canSee = hasLineOfSight(deps.isSolid, eyePos, playerPos);
  mob.rangedSeeTimer = canSee ? mob.rangedSeeTimer + delta : 0;

  if (dist <= RANGED_ATTACK_RADIUS && canSee && mob.rangedSeeTimer >= RANGED_SIGHT_REQUIRED) {
    mob.path = null;
    mob.model.setAttacking?.(true);
    applyGroundFriction(mob, delta);
    easeYawTo(mob, Math.atan2(-dx, -dz), delta, TURN_RATE);
    mob.attackTimer -= delta;
    if (mob.attackTimer <= 0) {
      mob.attackTimer = RANGED_ATTACK_INTERVAL;
      const shotPos = pos.clone();
      shotPos.y += mob.height * RANGED_SHOT_HEIGHT_FRACTION;
      deps.onShootArrow?.(shotPos, playerPos.clone());
    }
    return true;
  }

  // Still out of range, out of sight, or building up the sight timer - close in.
  mob.model.setAttacking?.(false);
  mob.attackTimer = 0;
  mob.chaseRepathTimer -= delta;
  if (!mob.path || mob.pathIndex >= mob.path.length || mob.chaseRepathTimer <= 0) {
    mob.chaseRepathTimer = CHASE_REPATH_INTERVAL;
    const path = findPath(deps.isSolid, pos, playerPos.x, playerPos.z, 150, RANGED_STEP_UP, RANGED_STEP_DOWN);
    if (path) {
      mob.path = path;
      mob.pathIndex = 1;
    } else {
      mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: playerPos.x, y: pos.y, z: playerPos.z }];
      mob.pathIndex = 1;
    }
  }
  if (mob.path) followPath(mob, mob.walkSpeed, delta);
  else applyGroundFriction(mob, delta);
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
function pickWanderTarget(mob: Mob, deps: MobAiDeps): void {
  const pos = mob.model.getGroup().position;
  const angle = Math.random() * Math.PI * 2;
  const radius = WANDER_RADIUS_MIN + Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN);
  const goalX = pos.x + Math.sin(angle) * radius;
  const goalZ = pos.z + Math.cos(angle) * radius;
  const path = findPath(deps.isSolid, pos, goalX, goalZ);
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
function pickFleeTarget(mob: Mob, deps: MobAiDeps): void {
  const pos = mob.model.getGroup().position;
  const baseAngle = Math.atan2(mob.fleeDir.x, mob.fleeDir.z);
  const angle = baseAngle + (Math.random() - 0.5) * FLEE_REPATH_CONE;
  const radius = FLEE_RADIUS_MIN + Math.random() * (FLEE_RADIUS_MAX - FLEE_RADIUS_MIN);
  const goalX = pos.x + Math.sin(angle) * radius;
  const goalZ = pos.z + Math.cos(angle) * radius;
  const path = findPath(deps.isSolid, pos, goalX, goalZ);
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
function trySwimToShore(mob: Mob, deps: MobAiDeps): void {
  if (!deps.isWater) return;
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
        deps.isSolid(gxr, by, gzr) &&
        !deps.isWater(gxr, by, gzr) &&
        !deps.isSolid(gxr, by + 1, gzr) &&
        !deps.isSolid(gxr, by + 2, gzr)
      ) {
        mob.path = [{ x: pos.x, y: pos.y, z: pos.z }, { x: gx, y: by + 0.5, z: gz }];
        mob.pathIndex = 1;
        return;
      }
    }
  }
}

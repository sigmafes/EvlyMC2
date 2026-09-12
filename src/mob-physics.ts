import type { Mob } from './mob-manager';

export type IsSolidFn = (x: number, y: number, z: number) => boolean;
export type IsWaterFn = (x: number, y: number, z: number) => boolean;

const GRAVITY = 24;
const JUMP_FORCE = 8; // matches the player's own jump impulse (player-physics.ts)
const WAYPOINT_REACH_DIST = 0.3;
export const TURN_RATE = 10; // yaw-easing rate while walking; higher = snappier turning - also used directly by mob-ai.ts for the attack-facing turn
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
const WANDER_INTERVAL_MIN = 8; // "se moverán cada 8-12s" - re-rolled here whenever ANY path (wander/flee/chase/swim) finishes
const WANDER_INTERVAL_MAX = 12;

const ri = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/** Does mob's hitbox (a `radius`-wide, `height`-tall column centred on x,z with feet at feetY) overlap any solid block? */
export function overlapsSolid(isSolid: IsSolidFn, x: number, feetY: number, z: number, radius: number, height: number): boolean {
  const x0 = Math.round(x - radius), x1 = Math.round(x + radius);
  const z0 = Math.round(z - radius), z1 = Math.round(z + radius);
  const y0 = Math.round(feetY + 0.05), y1 = Math.round(feetY + height - 0.05);
  for (let bx = x0; bx <= x1; bx++) {
    for (let bz = z0; bz <= z1; bz++) {
      for (let by = y0; by <= y1; by++) {
        if (isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * A cave-hostile spawn point is only checked at its exact centre column, so
 * an edge-case (a spawn candidate found valid a frame before terrain around
 * it finished settling, or just an unlucky pocket) can still leave a mob
 * embedded in solid terrain, stuck in place with nowhere for the AI to walk
 * it out to. Mirrors the player's own isEmbedded/tryEscapeStuck
 * (player-physics.ts): scan straight up for the first clear 2-block gap and
 * teleport there, zeroing velocity, instead of leaving it wedged forever.
 */
export function tryEscapeStuck(mob: Mob, isSolid: IsSolidFn): boolean {
  const group = mob.model.getGroup();
  if (!overlapsSolid(isSolid, group.position.x, group.position.y, group.position.z, mob.radius, mob.height)) return false;
  const x = Math.round(group.position.x);
  const z = Math.round(group.position.z);
  const startY = Math.floor(group.position.y);
  const MAX_SCAN = 256;
  for (let y = startY; y < startY + MAX_SCAN; y += 1) {
    if (!isSolid(x, y, z) && !isSolid(x, y + 1, z)) {
      group.position.set(x, y + 0.5, z);
      mob.velocity.set(0, 0, 0);
      mob.grounded = false;
      return true;
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
export function updatePhysics(mob: Mob, delta: number, isSolid: IsSolidFn, isWater?: IsWaterFn): void {
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
    if (!overlapsSolid(isSolid, tryX, y, group.position.z, mob.radius, mob.height)) {
      group.position.x = tryX;
    } else if (mob.grounded && !overlapsSolid(isSolid, tryX, y + 1, group.position.z, mob.radius, mob.height)) {
      mob.velocity.y = JUMP_FORCE;
      mob.grounded = false;
    } else {
      mob.velocity.x = 0;
      if (mob.grounded) stuckGrounded = true;
    }

    const tryZ = group.position.z + mob.velocity.z * delta;
    if (!overlapsSolid(isSolid, group.position.x, y, tryZ, mob.radius, mob.height)) {
      group.position.z = tryZ;
    } else if (mob.grounded && !overlapsSolid(isSolid, group.position.x, y + 1, tryZ, mob.radius, mob.height)) {
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
  mob.inWater = !!isWater && (isWater(feetX, feetBlockYNow, feetZ) || isWater(feetX, feetBlockYNow + 1, feetZ));

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
  if (mob.velocity.y <= 0 && isSolid(Math.round(group.position.x), feetBlockY, Math.round(group.position.z))) {
    group.position.y = feetBlockY + 0.5;
    mob.velocity.y = 0;
    mob.grounded = true;
  } else {
    group.position.y = nextY;
    mob.grounded = false;
  }
}

/** Move a value toward a target by at most maxStep - linear, frame-rate independent, never overshoots. */
export function moveTowards(current: number, target: number, maxStep: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/** Eases `mob`'s facing yaw toward `targetYaw` by the shortest angular path at `rate` and applies it to the model. */
export function easeYawTo(mob: Mob, targetYaw: number, delta: number, rate: number): void {
  let deltaYaw = targetYaw - mob.facingYaw;
  deltaYaw = ((deltaYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  mob.facingYaw += deltaYaw * Math.min(1, rate * delta);
  mob.model.getGroup().rotation.y = mob.facingYaw;
}

/** Decays `mob.velocity`.x/z toward 0 (ground friction) - called instead of moveHorizontal whenever the AI has nowhere to walk to right now. */
export function applyGroundFriction(mob: Mob, delta: number): void {
  const frictionFactor = Math.max(0, 1 - MOB_FRICTION * delta);
  mob.velocity.x *= frictionFactor;
  mob.velocity.z *= frictionFactor;
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
export function moveHorizontal(mob: Mob, dirX: number, dirZ: number, speed: number, delta: number): void {
  const accel = MOB_ACCELERATION * (mob.grounded ? 1 : MOB_AIR_ACCEL_MULT);
  const maxStep = accel * delta;
  mob.velocity.x = moveTowards(mob.velocity.x, dirX * speed, maxStep);
  mob.velocity.z = moveTowards(mob.velocity.z, dirZ * speed, maxStep);

  // Object3D at rotation.y=θ has local -Z (this model's "front" - see
  // mob-model.ts) pointing world (-sinθ,-cosθ), so the target yaw is the
  // negated atan2 - the un-negated form points the model's BACK the way
  // it's walking (a moonwalk).
  easeYawTo(mob, Math.atan2(-dirX, -dirZ), delta, TURN_RATE);
}

/** Steps `mob` toward its current path waypoint, advancing to the next one once close enough. */
export function followPath(mob: Mob, speed: number, delta: number): void {
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
  moveHorizontal(mob, dx / dist, dz / dist, speed, delta);
}

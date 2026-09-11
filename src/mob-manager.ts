import * as THREE from 'three';
import { MobModel, type QuadrupedSpec } from './mob-model';
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
      return [{ id: ItemId.WOOL, count: 1 }, { id: ItemId.RAW_MUTTON, count: 1 }];
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
const FLEE_DURATION = 3; // seconds, LCE PanicGoal-style
const WANDER_PAUSE_MIN = 1;
const WANDER_PAUSE_MAX = 2.5;
const WANDER_RADIUS_MIN = 3;
const WANDER_RADIUS_MAX = 6;
const FLEE_RADIUS_MIN = 5;
const FLEE_RADIUS_MAX = 8;
const FLEE_REPATH_CONE = Math.PI / 2; // random point within +-90 deg of "away from the attacker"
const WAYPOINT_REACH_DIST = 0.3;
const TURN_RATE = 10; // yaw-easing rate; higher = snappier turning
const STEP_INTERVAL = 0.45;
const IDLE_SOUND_MIN = 4;
const IDLE_SOUND_MAX = 9;
const KNOCKBACK_SPEED = 5;
const KNOCKBACK_UP = 4;
const KNOCKBACK_DECAY = 8; // per second, exponential

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
  pauseTimer: number; // >0 while idling with no path, counts down
  // Sound
  stepTimer: number;
  idleSoundTimer: number;
  // Debug
  box: THREE.LineSegments;
};

export type MobRaycastHit = { mobId: number; kind: MobKind; distance: number };

/**
 * Fase H+: mobs with real (if simple) AI - wander when idle, flee in a
 * straight line away from whatever last hurt them - plus health, death and
 * drops. Still no pathfinding/obstacle avoidance (a blocked mob just picks a
 * new direction sooner) and no persistence.
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
      pauseTimer: ri(0, 20) / 10, // stagger initial wander so a group doesn't move in lockstep
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
      const center = mob.model.getGroup().position.clone();
      center.y += mob.height / 2;
      const hit = raySphereDistance(origin, dir, center, mob.radius);
      if (hit !== null && hit <= maxDist && (!best || hit < best.distance)) {
        best = { mobId: mob.id, kind: mob.kind, distance: hit };
      }
    }
    return best;
  }

  /** Apply damage; on death, spawns drops and removes the mob. Returns true if it died. */
  damage(mobId: number, amount: number, fromPos: THREE.Vector3): boolean {
    const index = this.mobs.findIndex((m) => m.id === mobId);
    if (index === -1) return false;
    const mob = this.mobs[index];
    mob.health -= amount;

    if (mob.health <= 0) {
      if (this.soundManager) playMobSound(this.soundManager, mob.kind, 'death', 0.8);
      const pos = mob.model.getGroup().position.clone();
      pos.y += mob.height / 2;
      for (const drop of rollDrops(mob.kind)) this.onDrop?.(drop.id, drop.count, pos);
      this.removeAt(index);
      return true;
    }
    if (this.soundManager) playMobSound(this.soundManager, mob.kind, 'hurt', 0.7);
    mob.model.hurt(); // 0.2s red flash

    // Panic (LCE PanicGoal): forget whatever it was doing and start pathing
    // to random points biased away from the attacker for a few seconds - see
    // pickFleeTarget(), called from updateAI() once `path` is cleared here.
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
    for (const mob of this.mobs) {
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

    if (mob.path && mob.pathIndex < mob.path.length) {
      this.followPath(mob, mob.walkSpeed, delta);
      return;
    }

    mob.pauseTimer -= delta;
    if (mob.pauseTimer <= 0) {
      this.pickWanderTarget(mob);
      if (!mob.path) mob.pauseTimer = 0.5; // nowhere reachable found - try again shortly
    }
  }

  /** Path::A* (mob-pathfinding.ts) to a random reachable point a few blocks away. */
  private pickWanderTarget(mob: Mob): void {
    const pos = mob.model.getGroup().position;
    const angle = Math.random() * Math.PI * 2;
    const radius = WANDER_RADIUS_MIN + Math.random() * (WANDER_RADIUS_MAX - WANDER_RADIUS_MIN);
    const path = findPath(this.isSolid, pos, pos.x + Math.sin(angle) * radius, pos.z + Math.cos(angle) * radius);
    mob.path = path;
    mob.pathIndex = path ? 1 : 0; // path[0] is the mob's own current cell
  }

  /**
   * LCE/loro PanicGoal-style: a random reachable point biased away from
   * whatever last hurt this mob (not a rigid straight line), re-picked
   * whenever the current escape path runs out while still panicking.
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
        mob.pauseTimer = ri(WANDER_PAUSE_MIN * 10, WANDER_PAUSE_MAX * 10) / 10;
      }
      return;
    }
    this.moveHorizontal(mob, dx / dist, dz / dist, speed, delta);
  }

  /** Moves `mob` by (dirX,dirZ) (normalised) at `speed`, resolving collisions per-axis (so it can slide along a wall) using its actual hitbox instead of a single point - and eases its facing yaw toward the direction of travel instead of snapping. */
  private moveHorizontal(mob: Mob, dirX: number, dirZ: number, speed: number, delta: number): void {
    const group = mob.model.getGroup();
    const step = speed * delta;
    const y = group.position.y;

    let blocked = false;
    const tryX = group.position.x + dirX * step;
    if (!this.overlapsSolid(tryX, y, group.position.z, mob.radius, mob.height)) {
      group.position.x = tryX;
    } else {
      blocked = true;
    }

    const tryZ = group.position.z + dirZ * step;
    if (!this.overlapsSolid(group.position.x, y, tryZ, mob.radius, mob.height)) {
      group.position.z = tryZ;
    } else {
      blocked = true;
    }

    if (blocked) {
      // Unexpected obstruction mid-path (pathfinding missed it, or the world
      // changed under it) - drop the path and take a short beat before
      // re-deciding, instead of grinding against the wall every frame.
      mob.path = null;
      mob.pauseTimer = 0.3;
    }

    // Object3D at rotation.y=θ has local -Z (this model's "front" - see
    // mob-model.ts) pointing world (-sinθ,-cosθ), so the target yaw is the
    // negated atan2 - the un-negated form points the model's BACK the way
    // it's walking (a moonwalk). Eased instead of snapped so turning reads
    // as an actual turn, not an instant flip, now that pathfinding changes
    // direction more often than the old straight-line wander did.
    const targetYaw = Math.atan2(-dirX, -dirZ);
    let deltaYaw = targetYaw - mob.facingYaw;
    deltaYaw = ((deltaYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    mob.facingYaw += deltaYaw * Math.min(1, TURN_RATE * delta);
    group.rotation.y = mob.facingYaw;
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

  /** Gravity + knockback decay + a simple ground snap (sample the block below, land on its top). */
  private updatePhysics(mob: Mob, delta: number): void {
    const group = mob.model.getGroup();

    // Knockback: an exponentially-decaying horizontal shove, independent of
    // the AI's own movement (moveHorizontal sets position directly, this adds
    // a delta on top of it).
    if (Math.abs(mob.velocity.x) > 0.01 || Math.abs(mob.velocity.z) > 0.01) {
      group.position.x += mob.velocity.x * delta;
      group.position.z += mob.velocity.z * delta;
      const decay = Math.exp(-KNOCKBACK_DECAY * delta);
      mob.velocity.x *= decay;
      mob.velocity.z *= decay;
    } else {
      mob.velocity.x = 0;
      mob.velocity.z = 0;
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

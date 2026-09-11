import * as THREE from 'three';
import { MobModel, type QuadrupedSpec } from './mob-model';
import { ItemId } from './item';

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
const WANDER_MOVE_MIN = 1.5;
const WANDER_MOVE_MAX = 3.5;
const WANDER_PAUSE_MIN = 1;
const WANDER_PAUSE_MAX = 2.5;

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
  // AI
  fleeTimer: number;
  fleeDir: THREE.Vector3;
  wanderDir: THREE.Vector3;
  wanderTimer: number; // >0 while walking toward wanderDir, counts down
  pauseTimer: number;  // >0 while idling, counts down
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly isSolid: (x: number, y: number, z: number) => boolean,
    private readonly onDrop?: (id: number, count: number, pos: THREE.Vector3) => void,
  ) {}

  spawn(kind: MobKind, spec: QuadrupedSpec, pos: THREE.Vector3, yaw: number): void {
    const stats = MOB_STATS[kind];
    const model = new MobModel(spec);
    const group = model.getGroup();
    group.position.copy(pos);
    group.rotation.y = yaw;
    this.scene.add(group);

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
      fleeTimer: 0,
      fleeDir: new THREE.Vector3(),
      wanderDir: new THREE.Vector3(),
      wanderTimer: 0,
      pauseTimer: ri(0, 20) / 10, // stagger initial wander so a group doesn't move in lockstep
    });
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
      const pos = mob.model.getGroup().position.clone();
      pos.y += mob.height / 2;
      for (const drop of rollDrops(mob.kind)) this.onDrop?.(drop.id, drop.count, pos);
      this.removeAt(index);
      return true;
    }

    // Flee straight away from the hit's source (LCE PanicGoal picks a random
    // direction biased away from the attacker - this is the simplified
    // straight-away version).
    const pos = mob.model.getGroup().position;
    mob.fleeDir.set(pos.x - fromPos.x, 0, pos.z - fromPos.z);
    if (mob.fleeDir.lengthSq() < 1e-6) mob.fleeDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    mob.fleeDir.normalize();
    mob.fleeTimer = FLEE_DURATION;
    return false;
  }

  update(delta: number, getLight?: (x: number, y: number, z: number) => number): void {
    for (const mob of this.mobs) {
      this.updateAI(mob, delta);
      this.updatePhysics(mob, delta);

      const group = mob.model.getGroup();
      const moving = mob.fleeTimer > 0 || mob.wanderTimer > 0;
      mob.model.setWalking(moving);
      mob.model.update(delta);

      if (getLight) {
        const p = group.position;
        const level = getLight(Math.round(p.x), Math.round(p.y + mob.height / 2), Math.round(p.z));
        mob.model.setLightLevel(level / 15);
      }
    }
  }

  private updateAI(mob: Mob, delta: number): void {
    if (mob.fleeTimer > 0) {
      mob.fleeTimer -= delta;
      this.moveHorizontal(mob, mob.fleeDir, mob.walkSpeed * mob.fleeSpeedMult, delta);
      return;
    }

    if (mob.wanderTimer > 0) {
      mob.wanderTimer -= delta;
      this.moveHorizontal(mob, mob.wanderDir, mob.walkSpeed, delta);
      if (mob.wanderTimer <= 0) mob.pauseTimer = ri(WANDER_PAUSE_MIN * 10, WANDER_PAUSE_MAX * 10) / 10;
      return;
    }

    mob.pauseTimer -= delta;
    if (mob.pauseTimer <= 0) {
      const angle = Math.random() * Math.PI * 2;
      mob.wanderDir.set(Math.sin(angle), 0, Math.cos(angle));
      mob.wanderTimer = ri(WANDER_MOVE_MIN * 10, WANDER_MOVE_MAX * 10) / 10;
    }
  }

  /** Walks `mob` along `dir` (world-space, normalised) at `speed`; stops (without falling back to idle) if the way ahead is blocked. */
  private moveHorizontal(mob: Mob, dir: THREE.Vector3, speed: number, delta: number): void {
    if (dir.lengthSq() < 1e-6) return;
    const group = mob.model.getGroup();
    const step = speed * delta;
    const nextX = group.position.x + dir.x * step;
    const nextZ = group.position.z + dir.z * step;

    const feetY = Math.round(group.position.y + 0.1);
    const blocked = this.isSolid(Math.round(nextX), feetY, Math.round(nextZ))
      || this.isSolid(Math.round(nextX), feetY + 1, Math.round(nextZ));
    if (blocked) {
      mob.wanderTimer = 0; // give up this direction early instead of pushing into the wall
      mob.pauseTimer = 0.3;
      return;
    }

    group.position.x = nextX;
    group.position.z = nextZ;
    group.rotation.y = Math.atan2(dir.x, dir.z);
  }

  /** Gravity + a simple ground snap (sample the block below, land on its top). No horizontal collision resolution beyond moveHorizontal's blocked-ahead check. */
  private updatePhysics(mob: Mob, delta: number): void {
    const group = mob.model.getGroup();
    mob.velocity.y -= GRAVITY * delta;
    const nextY = group.position.y + mob.velocity.y * delta;

    const feetBlockY = Math.floor(nextY - 0.05);
    if (mob.velocity.y <= 0 && this.isSolid(Math.round(group.position.x), feetBlockY, Math.round(group.position.z))) {
      group.position.y = feetBlockY + 1;
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

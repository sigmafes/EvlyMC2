import * as THREE from 'three';
import { MOB_STATS, isHostileKind, type Mob, type MobKind } from './game/mob-manager';
import { updateAI, type MobAiDeps } from './game/mob-ai';
import { tryEscapeStuck, updatePhysics } from './game/mob-physics';
import { rollDrops, type DropStack } from '../../src/mob-drops';
import type { EntitySnapshot } from '../../src/net/protocol';
import { BlockId, isSolidBlock } from '../../src/block';

// Mirrors mob-manager.ts's own (private) tuning constants for damage/knockback/
// flee - kept in sync by eye since they're not exported. Small, stable
// numbers unlikely to drift; if they ever do, singleplayer and multiplayer
// combat just feel slightly different, nothing breaks.
const KNOCKBACK_SPEED = 6.5;
const KNOCKBACK_UP = 4.5;
/** Mirrors mob-manager.ts's own KNOCKBACK_LOCK_DURATION - mob-ai.ts's updateHostileAI zeroes velocity.x/z every tick while chasing UNLESS knockbackTimer > 0 (game/mob-ai.ts's chase branch), so a hit that never set this timer got its shove cancelled the very same/next tick, before the mob could visibly move. Missing here was why hostile knockback looked like it did nothing in multiplayer even though the velocity itself was being set correctly below. */
const KNOCKBACK_LOCK_DURATION = 0.3;
const FLEE_DURATION = 3;
const DEATH_SPIN_DURATION = 0.75; // seconds toppling before vanishing - same as mob-manager.ts's own
// Sunlight/fire burn tuning, mirroring mob-manager.ts's own private constants (see updateFireAndSun below).
const BURN_DAMAGE_INTERVAL = 1;
const BURN_DAMAGE = 1;
const FIRE_AFTERBURN_TICKS = 8;
/**
 * Global safety net, not a gameplay rule: singleplayer's 16-slot cap only
 * ever needed to bound ONE player's population. Fase 9 runs one independent
 * 16-slot spawner PER connected player (game/mob-spawning.ts), so several
 * players spread across a world could otherwise sum to far more mobs than
 * this server has ever had to simulate at once. Past this, spawning just
 * stops - existing mobs are unaffected, same pattern as the fire engine's
 * own MAX_FIRE_CELLS (game/fire-engine.ts).
 */
const MAX_MOBS = 200;

/** A mob as persisted to Durable Object storage: only what respawning it needs, never the AI/path/timer scratch state (all of which is fine to start fresh). */
export type MobRecord = { id: number; kind: MobKind; x: number; y: number; z: number; yaw: number; health: number };
/** One connected player, as far as a mob deciding what to chase/attack needs to know. */
export type PlayerTarget = { id: number; pos: THREE.Vector3 };
export type MobCombatDeps = {
  isSolid: MobAiDeps['isSolid'];
  isWater?: MobAiDeps['isWater'];
  players: PlayerTarget[];
  /** A hostile mob landed a melee hit - which player and how much. */
  onAttackPlayer: (playerId: number, damage: number, fromPos: THREE.Vector3) => void;
  /** A skeleton fired: `targetPos` is mob-ai.ts's already-gravity-compensated aim point, so the caller only has to turn it into a velocity and spawn a real projectile. */
  onShootArrow: (fromPos: THREE.Vector3, targetPos: THREE.Vector3) => void;
  /** A mob finished toppling and is about to be removed: its loot, already rolled, at the height it should spawn from. */
  onDeath: (drops: DropStack[], pos: THREE.Vector3) => void;
  /** False for a mob standing in a chunk nobody is near - it's frozen this tick (see game/active-region.ts). */
  isActiveAt: (x: number, z: number) => boolean;
  /** The world block at this column - used only for sunlight exposure (is there open sky above?) and fire/lava contact, see updateFireAndSun below. */
  getBlockAt: (x: number, y: number, z: number) => BlockId;
  /** True while it's currently daytime server-side - this DO has no real skylight/voxel light engine (see mob-spawning.ts's approxBrightnessAt doc comment), so sunlight exposure here is approximated as "is it day AND is there no solid block directly overhead", not a real 0..15 skylight falloff like singleplayer's getSkyExposure. */
  isDay: () => boolean;
};

/**
 * Mobs, server-side. Reuses mob-ai.ts's updateAI() and mob-physics.ts's
 * updatePhysics()/tryEscapeStuck() completely unmodified - the exact same
 * wander/flee/chase AI and physics singleplayer's MobManager runs, since
 * Fase 1 of the migration already made a `Mob`'s position/velocity/AI state
 * plain data independent of any THREE.Scene or mesh.
 *
 * What this deliberately does NOT reuse is MobManager/MobModel/BipedMobModel
 * themselves: those construct real mesh geometry and load textures via
 * `new THREE.TextureLoader().load(...)`, which needs `Image`/`document` -
 * neither exists in the Workers runtime, so calling that constructor here
 * would throw immediately. Instead each Mob gets a tiny stub `model` that
 * satisfies the interface mob-ai.ts/mob-physics.ts expect (just a
 * `THREE.Group` for easeYawTo() to write rotation into, and no-op methods
 * for the rest - hurt flashes, walk animation, fire tint: all purely visual,
 * meaningless without a client-side mesh to show them on anyway).
 *
 * Combat: each hostile mob targets whichever connected player is nearest TO
 * IT specifically (not one global "the" player like singleplayer only ever
 * had) - update() builds a fresh per-mob MobAiDeps every tick with that
 * mob's own nearest-player closure, so mob-ai.ts's existing single-target
 * chase/attack logic works unmodified even with several players connected.
 * A skeleton's shot is a real projectile with travel time (see
 * game/arrow-projectiles.ts), spawned by whoever provides `onShootArrow` -
 * it can miss, be dodged, or be stopped by a wall, exactly like in
 * singleplayer.
 *
 * Death: a mob at 0 HP topples for DEATH_SPIN_DURATION (still falling, no
 * longer deciding anything) and then drops its loot via mob-drops.ts's
 * rollDrops() - the same table singleplayer rolls - before vanishing. The
 * smoke burst and red tint stay client-side; `dying` already rides along in
 * EntitySnapshot, so no extra protocol message is needed to trigger them.
 */
export class ServerMobManager {
  private readonly mobs: Mob[] = [];
  private nextId = -1; // negative ids - never collide with Session ids (positive, from WorldDO.nextId)

  /** Returns the new mob's id, or null if the global cap (MAX_MOBS) is already reached and nothing was spawned. */
  spawn(kind: MobKind, pos: THREE.Vector3, yaw: number): number | null {
    if (this.mobs.length >= MAX_MOBS) return null;
    const stats = MOB_STATS[kind];
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = yaw;

    const id = this.nextId--;
    this.mobs.push({
      id,
      kind,
      model: {
        getGroup: () => group,
        setWalking: () => {},
        setLightLevel: () => {},
        hurt: () => {},
        setDying: () => {},
        setOnFire: () => {},
        update: () => {},
        setAttacking: () => {},
      },
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
      decisionTimer: Math.random() * 12,
      idleLookTimer: Math.random() * 3,
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
      sightMemory: 0,
      aiming: false,
      onFire: false,
      fireTicksLeft: 0,
      burnTimer: 0,
      dying: false,
      deathTimer: 0,
      stepTimer: 0,
      idleSoundTimer: Math.random() * 9,
      box: new THREE.LineSegments(),
    });
    return id;
  }

  update(delta: number, ctx: MobCombatDeps): void {
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      // Frozen: a mob nobody is near keeps its exact state (position, health,
      // path, whatever it was mid-decision about) and simply doesn't think
      // this tick. Pathfinding and AI are the most expensive per-entity work
      // this server does, and none of it is observable with no one in range.
      if (!ctx.isActiveAt(mob.pos.x, mob.pos.z)) continue;
      if (mob.dying) { this.updateDying(mob, i, delta, ctx); continue; }

      const nearest = this.nearestPlayer(mob.pos, ctx.players);
      const deps: MobAiDeps = {
        isSolid: ctx.isSolid,
        isWater: ctx.isWater,
        getPlayerPos: nearest ? () => nearest.pos : undefined,
        onAttackPlayer: nearest ? (damage) => ctx.onAttackPlayer(nearest.id, damage, mob.pos) : undefined,
        onShootArrow: nearest ? (fromPos, targetPos) => ctx.onShootArrow(fromPos, targetPos) : undefined,
      };

      tryEscapeStuck(mob, ctx.isSolid);
      updateAI(mob, delta, deps);
      updatePhysics(mob, delta, ctx.isSolid, ctx.isWater);
      this.updateFireAndSun(mob, delta, ctx);
    }
  }

  /**
   * Port of mob-manager.ts's own updateFire() - hostile mobs (zombie/
   * skeleton) burn in daylight the same way singleplayer's do, and any mob
   * standing in fire/lava burns regardless of kind. Approximated sunlight
   * exposure (see MobCombatDeps.isDay's doc comment) instead of a real
   * skylight value, since this server has none; the "solid block directly
   * overhead blocks the sun" and "water douses it" and "after-burn ticks
   * once exposure ends" behaviour is otherwise unchanged.
   */
  private updateFireAndSun(mob: Mob, delta: number, ctx: MobCombatDeps): void {
    const p = mob.pos;
    const sunBurning = isHostileKind(mob.kind) && mob.kind !== 'spider' && ctx.isDay() && !mob.inWater && !this.hasSolidCoverAbove(mob, ctx.getBlockAt);
    const touchingFire = !mob.inWater && this.touchesFireOrLava(mob, ctx.getBlockAt);

    if (sunBurning || touchingFire) mob.fireTicksLeft = FIRE_AFTERBURN_TICKS;

    mob.onFire = mob.fireTicksLeft > 0;
    if (!mob.onFire) { mob.burnTimer = 0; return; }

    mob.burnTimer -= delta;
    if (mob.burnTimer <= 0) {
      mob.burnTimer = BURN_DAMAGE_INTERVAL;
      mob.fireTicksLeft -= 1;
      this.damage(mob.id, BURN_DAMAGE, p, false);
    }
  }

  /** True if any solid block sits directly above this mob's own column, up to build height - blocks the sun outright regardless of lateral sky exposure. Mirrors mob-manager.ts's own hasSolidCoverAbove. */
  private hasSolidCoverAbove(mob: Mob, getBlockAt: MobCombatDeps['getBlockAt']): boolean {
    const x = Math.round(mob.pos.x);
    const z = Math.round(mob.pos.z);
    for (let y = Math.ceil(mob.pos.y + mob.height); y < 256; y++) {
      if (isSolidBlock(getBlockAt(x, y, z))) return true;
    }
    return false;
  }

  /** True if the mob's feet or chest cell is FIRE/LAVA - mirrors mob-manager.ts's own touchesFireOrLava (same two sample heights as the player's own environment-damage check). */
  private touchesFireOrLava(mob: Mob, getBlockAt: MobCombatDeps['getBlockAt']): boolean {
    const x = Math.round(mob.pos.x);
    const z = Math.round(mob.pos.z);
    const feet = getBlockAt(x, Math.round(mob.pos.y), z);
    const chest = getBlockAt(x, Math.round(mob.pos.y + mob.height * 0.6), z);
    return feet === BlockId.FIRE || feet === BlockId.LAVA || chest === BlockId.FIRE || chest === BlockId.LAVA;
  }

  /**
   * A mob that has already run out of health: it keeps falling/landing but
   * stops deciding anything, and vanishes once its topple finishes - the same
   * DEATH_SPIN_DURATION window singleplayer's mob-manager.ts gives it. The
   * delay isn't cosmetic padding: the client needs the mob to still be in the
   * snapshot (with `dying: true`, which EntitySnapshot already carries) for
   * long enough to play the topple, otherwise a killed mob just blinks out.
   *
   * Loot is rolled HERE rather than at the killing blow, matching
   * singleplayer, so a mob that dies while on fire drops cooked meat based on
   * whether it was still burning when it actually finished dying.
   */
  private updateDying(mob: Mob, index: number, delta: number, ctx: MobCombatDeps): void {
    updatePhysics(mob, delta, ctx.isSolid, ctx.isWater); // still falls/lands, just no AI
    mob.deathTimer -= delta;
    if (mob.deathTimer > 0) return;

    const pos = mob.pos.clone();
    pos.y += mob.height / 2; // drops burst from the body's middle, not its feet
    ctx.onDeath(rollDrops(mob.kind, mob.onFire), pos);
    this.mobs.splice(index, 1);
  }

  private nearestPlayer(pos: THREE.Vector3, players: PlayerTarget[]): PlayerTarget | null {
    let best: PlayerTarget | null = null;
    let bestDist = Infinity;
    for (const p of players) {
      const d = pos.distanceToSquared(p.pos);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  /**
   * Apply damage from a player's attack. Returns true if it landed on a live
   * mob. Mirrors mob-manager.ts's own damage() (knockback shove + flee
   * trigger for non-hostiles, health<=0 = dead) without the sound/hurt-flash
   * calls, which are purely visual and meaningless without a client mesh here.
   */
  damage(id: number, amount: number, fromPos: THREE.Vector3, knockback = true): boolean {
    const mob = this.mobs.find((m) => m.id === id);
    if (!mob || mob.dying) return false;
    mob.health -= amount;
    if (mob.health <= 0) {
      mob.dying = true;
      mob.deathTimer = DEATH_SPIN_DURATION;
      return true;
    }
    if (!knockback) return true;

    const pushDir = new THREE.Vector2(mob.pos.x - fromPos.x, mob.pos.z - fromPos.z);
    if (pushDir.lengthSq() < 1e-6) pushDir.set(Math.random() - 0.5, Math.random() - 0.5);
    pushDir.normalize();
    mob.velocity.x = pushDir.x * KNOCKBACK_SPEED;
    mob.velocity.z = pushDir.y * KNOCKBACK_SPEED;
    mob.velocity.y = KNOCKBACK_UP;
    mob.grounded = false;
    mob.knockbackTimer = KNOCKBACK_LOCK_DURATION;

    if (!isHostileKind(mob.kind)) {
      mob.fleeDir.set(pushDir.x, 0, pushDir.y);
      mob.fleeTimer = FLEE_DURATION;
      mob.path = null;
    }
    return true;
  }

  /** For a caller (e.g. WorldDO's melee reach check) that needs a mob's position without going through a full snapshot. */
  getPos(id: number): THREE.Vector3 | null {
    return this.mobs.find((m) => m.id === id)?.pos ?? null;
  }

  /** True if a mob with this id is still around (dying ones included - not gone until the topple finishes), for a per-player spawn slot (game/mob-spawning.ts) to know its mob is still its own to track. Same "dying still counts" rule as mob-manager.ts's own isAlive(). */
  isAlive(id: number): boolean {
    return this.mobs.some((m) => m.id === id);
  }

  /** Silent despawn (no drops, no death animation, no loot) - for a mob whose spawn slot decided it wandered out of anyone's active region, mirroring mob-manager.ts's own forceRemove() for a mob that left the loaded area. */
  forceRemove(id: number): void {
    const index = this.mobs.findIndex((m) => m.id === id);
    if (index >= 0) this.mobs.splice(index, 1);
  }

  /** Nearest mob along a ray within `maxDist`, or null - what an in-flight arrow tests against. Same stacked-spheres approximation mob-manager.ts's own raycastMobs() uses (its helpers are private there, so the math is mirrored here, same as the tuning constants at the top of this file). */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null {
    let bestId: number | null = null;
    let bestDist = Infinity;
    for (const mob of this.mobs) {
      if (mob.dying) continue;
      const hit = rayCapsuleDistance(origin, dir, mob.pos, mob.height, mob.radius);
      if (hit !== null && hit <= maxDist && hit < bestDist) {
        bestDist = hit;
        bestId = mob.id;
      }
    }
    return bestId;
  }

  /**
   * Compact view for Durable Object storage. Dying mobs are left out on
   * purpose: their loot hasn't been rolled yet, so persisting one would mean
   * either dropping it twice (once now, once after a restore) or silently
   * swallowing it - and a mob mid-topple is under a second from gone anyway.
   */
  toRecords(): MobRecord[] {
    return this.mobs
      .filter((mob) => !mob.dying)
      .map((mob) => ({
        id: mob.id, kind: mob.kind,
        x: mob.pos.x, y: mob.pos.y, z: mob.pos.z,
        yaw: mob.facingYaw, health: mob.health,
      }));
  }

  /** Rebuild from storage after this Durable Object was evicted and woke up again. Ids are preserved so a client that was mid-attack doesn't suddenly find its target renumbered. */
  restore(records: MobRecord[]): void {
    for (const rec of records) {
      this.spawn(rec.kind, new THREE.Vector3(rec.x, rec.y, rec.z), rec.yaw);
      const mob = this.mobs[this.mobs.length - 1];
      mob.id = rec.id;
      mob.health = rec.health;
    }
    // Keep handing out ids below every restored one, so a mob spawned after a
    // restore can't collide with one that was already saved.
    const lowest = Math.min(-1, ...records.map((r) => r.id));
    this.nextId = lowest - 1;
  }

  get count(): number {
    return this.mobs.length;
  }

  snapshots(): EntitySnapshot[] {
    return this.mobs.map((mob) => ({
      id: mob.id,
      kind: mob.kind,
      pos: { x: mob.pos.x, y: mob.pos.y, z: mob.pos.z },
      yaw: mob.facingYaw,
      health: mob.health,
      maxHealth: mob.maxHealth,
      onFire: mob.onFire,
      dying: mob.dying,
      aiming: mob.aiming,
    }));
  }
}

/** How many spheres to stack along a mob's vertical axis for rayCapsuleDistance - mirrors mob-manager.ts's own CAPSULE_SAMPLES. */
const CAPSULE_SAMPLES: number = 5;

function raySphereDistance(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): number | null {
  const oc = origin.clone().sub(center);
  const b = oc.dot(dir);
  const c = oc.lengthSq() - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : null;
}

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

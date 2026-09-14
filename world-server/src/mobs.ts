import * as THREE from 'three';
import { MOB_STATS, isHostileKind, type Mob, type MobKind } from './game/mob-manager';
import { updateAI, type MobAiDeps } from './game/mob-ai';
import { tryEscapeStuck, updatePhysics } from './game/mob-physics';
import type { EntitySnapshot } from '../../src/net/protocol';

// Mirrors mob-manager.ts's own (private) tuning constants for damage/knockback/
// flee - kept in sync by eye since they're not exported. Small, stable
// numbers unlikely to drift; if they ever do, singleplayer and multiplayer
// combat just feel slightly different, nothing breaks.
const KNOCKBACK_SPEED = 5;
const KNOCKBACK_UP = 4;
const FLEE_DURATION = 3;
/** One connected player, as far as a mob deciding what to chase/attack needs to know. */
export type PlayerTarget = { id: number; pos: THREE.Vector3 };
export type MobCombatDeps = {
  isSolid: MobAiDeps['isSolid'];
  isWater?: MobAiDeps['isWater'];
  players: PlayerTarget[];
  /** A hostile mob landed a melee hit - which player and how much. */
  onAttackPlayer: (playerId: number, damage: number, fromPos: THREE.Vector3) => void;
  /** A skeleton "fired" - simplified as a guaranteed hit for this first pass (no real travel-time projectile synced over the network yet, see the class doc comment). */
  onShootArrow: (playerId: number, damage: number) => void;
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
 * A skeleton's shot is simplified to a guaranteed hit the instant it fires -
 * no real arrow entity with travel time synced over the network yet (that
 * needs new protocol messages + client-side rendering, real follow-up).
 *
 * Still out of scope: drops/death effects (damage() below just removes a
 * mob outright at 0 HP, no death animation/smoke/loot - all purely visual/
 * inventory concerns that don't exist server-side yet either).
 */
export class ServerMobManager {
  private readonly mobs: Mob[] = [];
  private nextId = -1; // negative ids - never collide with Session ids (positive, from WorldDO.nextId)

  spawn(kind: MobKind, pos: THREE.Vector3, yaw: number): void {
    const stats = MOB_STATS[kind];
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = yaw;

    this.mobs.push({
      id: this.nextId--,
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
      onFire: false,
      fireTicksLeft: 0,
      burnTimer: 0,
      dying: false,
      deathTimer: 0,
      stepTimer: 0,
      idleSoundTimer: Math.random() * 9,
      box: new THREE.LineSegments(),
    });
  }

  update(delta: number, ctx: MobCombatDeps): void {
    for (let i = this.mobs.length - 1; i >= 0; i--) {
      const mob = this.mobs[i];
      if (mob.dying) { this.mobs.splice(i, 1); continue; } // no death animation - see class doc comment, just gone next tick

      const nearest = this.nearestPlayer(mob.pos, ctx.players);
      const deps: MobAiDeps = {
        isSolid: ctx.isSolid,
        isWater: ctx.isWater,
        getPlayerPos: nearest ? () => nearest.pos : undefined,
        onAttackPlayer: nearest ? (damage) => ctx.onAttackPlayer(nearest.id, damage, mob.pos) : undefined,
        onShootArrow: nearest ? () => ctx.onShootArrow(nearest.id, SKELETON_ARROW_DAMAGE) : undefined,
      };

      tryEscapeStuck(mob, ctx.isSolid);
      updateAI(mob, delta, deps);
      updatePhysics(mob, delta, ctx.isSolid, ctx.isWater);
    }
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
  damage(id: number, amount: number, fromPos: THREE.Vector3): boolean {
    const mob = this.mobs.find((m) => m.id === id);
    if (!mob || mob.dying) return false;
    mob.health -= amount;
    if (mob.health <= 0) {
      mob.dying = true;
      return true;
    }

    const pushDir = new THREE.Vector2(mob.pos.x - fromPos.x, mob.pos.z - fromPos.z);
    if (pushDir.lengthSq() < 1e-6) pushDir.set(Math.random() - 0.5, Math.random() - 0.5);
    pushDir.normalize();
    mob.velocity.x = pushDir.x * KNOCKBACK_SPEED;
    mob.velocity.z = pushDir.y * KNOCKBACK_SPEED;
    mob.velocity.y = KNOCKBACK_UP;
    mob.grounded = false;

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
    }));
  }
}

const SKELETON_ARROW_DAMAGE = 4; // matches the client's own fixedDamage for a skeleton's shot (arrow-projectiles.ts)

import * as THREE from 'three';
import { MOB_STATS, type Mob, type MobKind } from '../../src/mob-manager';
import { updateAI, type MobAiDeps } from '../../src/mob-ai';
import { tryEscapeStuck, updatePhysics } from '../../src/mob-physics';
import type { EntitySnapshot } from '../../src/net/protocol';

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
 * Also out of scope for this first pass: combat (no onAttackPlayer/
 * onShootArrow wiring - hostile mobs currently just wander like passive
 * ones, since `getPlayerPos` being unset disables chasing entirely per
 * mob-ai.ts's own design) and drops/death (mobs never take damage yet, so
 * they never die). Real follow-up, once player health is tracked
 * server-side too.
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

  update(delta: number, deps: MobAiDeps): void {
    for (const mob of this.mobs) {
      if (mob.dying) continue; // no death animation/removal yet - see class doc comment
      tryEscapeStuck(mob, deps.isSolid);
      updateAI(mob, delta, deps);
      updatePhysics(mob, delta, deps.isSolid, deps.isWater);
    }
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

// Copiado de src/arrow-projectiles.ts - ver world-server/src/game/README.md
// para el criterio de qué se copia vs qué sigue compartido con singleplayer.
// Cambios acá NO se reflejan automáticamente en src/arrow-projectiles.ts.
//
// Qué se sacó: todo el renderizado - la malla de "cruz billboard", la textura
// de entidad, el wireframe de debug, el tintado por luz y los sonidos. El
// cliente arma su propia malla con la posición/orientación que el servidor
// manda (ver multiplayer-game.ts). Lo que SÍ se mantiene idéntico es la
// física y las constantes: gravedad, drag, hitbox, radio de impacto, fórmula
// de daño, delay/margen de pickup y despawn.
//
// Diferencias propias del multiplayer (no son divergencias accidentales):
// - Una flecha sabe QUIÉN la disparó (`ownerId`), cosa que en singleplayer no
//   hace falta porque solo hay un jugador. Eso permite que el daño y el
//   recupero se atribuyan a la persona correcta.
// - Una flecha de jugador chequea contra mobs y una de mob contra jugadores,
//   igual que singleplayer. Jugador contra jugador queda para la Fase 7 (PvP),
//   que hoy está deshabilitado en world-do.ts.

import * as THREE from 'three';

export const ARROW_GRAVITY = 20;
const GRAVITY = ARROW_GRAVITY;
const DRAG = 0.99;
const HALF = 0.15;
const PLAYER_HIT_RADIUS = 0.6;
const PICKUP_MARGIN = 0.5;
const PICKUP_DELAY = 0.3;
const BASE_DAMAGE = 2.0;      // LCE Arrow::ARROW_BASE_DAMAGE
const EMBEDDED_DESPAWN = 60;  // seconds stuck before it vanishes unclaimed
const MAX_ARROWS = 128;

/** Player hitbox used for both the in-flight hit check and pickup reach - the server has no PlayerController to ask, so these mirror player-physics.ts's own dimensions. */
const PLAYER_RADIUS = 0.3;
const PLAYER_HEIGHT = 1.8;
const PLAYER_EYE_HEIGHT = 1.75;

const POWER_TO_SPEED = 15;

/** Converts an LCE-style "power" (bow draw 0..1 scaled by *2, or a mob's fixed 1.60) into an EvlyMC blocks/second speed. */
export function powerToSpeed(power: number): number {
  return power * POWER_TO_SPEED;
}

type Arrow = {
  entityId: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Session id of the player who fired it, or null for a mob's shot. Drives who it can hit and who gets credit. */
  ownerId: number | null;
  crit: boolean;
  fixedDamage?: number;
  embedded: boolean;
  embedTimer: number;
  /** Heading, recomputed from velocity every tick while flying and then frozen on impact - an embedded arrow has zero velocity, so deriving it from the vector at that point would snap it to a meaningless fixed direction instead of leaving it sticking out the way it struck. */
  yaw: number;
  pitch: number;
};

function headingYaw(vel: THREE.Vector3): number {
  return Math.atan2(-vel.x, -vel.z);
}

function headingPitch(vel: THREE.Vector3): number {
  return Math.atan2(vel.y, Math.hypot(vel.x, vel.z));
}

export type ArrowSnapshot = {
  entityId: number;
  pos: { x: number; y: number; z: number };
  /** Orientation, precomputed server-side so the client doesn't need the velocity vector just to point the mesh. An embedded arrow keeps the heading it struck at. */
  yaw: number;
  pitch: number;
};

export type ArrowDeps = {
  isSolid: (x: number, y: number, z: number) => boolean;
  players: { id: number; pos: THREE.Vector3 }[];
  /** Ray/segment test against mobs for a player-shot arrow - returns the mob it hit, if any. */
  raycastMobs: (from: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => number | null;
  onHitMob: (mobId: number, damage: number, fromPos: THREE.Vector3) => void;
  onHitPlayer: (playerId: number, damage: number) => void;
  /** Recover a spent arrow into that player's inventory; returns true if it fit. */
  collect: (playerId: number) => boolean;
};

/**
 * Flechas, autoritativas del lado servidor. La física, el impacto y el
 * recupero los decide el servidor; el cliente solo dibuja lo que recibe.
 */
export class ServerArrows {
  private readonly arrows: Arrow[] = [];
  private nextEntityId = 1;

  /** Fire an arrow from `pos` with the given world-space velocity (blocks/second). */
  spawn(
    pos: THREE.Vector3, vel: THREE.Vector3,
    opts: { ownerId: number | null; crit?: boolean; fixedDamage?: number },
  ): void {
    if (this.arrows.length >= MAX_ARROWS) this.arrows.shift();
    this.arrows.push({
      entityId: this.nextEntityId++,
      pos: pos.clone(),
      vel: vel.clone(),
      ownerId: opts.ownerId,
      crit: opts.crit ?? false,
      fixedDamage: opts.fixedDamage,
      embedded: false,
      embedTimer: 0,
      yaw: headingYaw(vel),
      pitch: headingPitch(vel),
    });
  }

  update(delta: number, deps: ArrowDeps): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];

      if (a.embedded) {
        a.embedTimer += delta;
        if (a.embedTimer >= EMBEDDED_DESPAWN) { this.arrows.splice(i, 1); continue; }
        // Only a player's own missed shots can be recovered - a skeleton's
        // arrow sticks around uncollectible until it despawns.
        if (a.ownerId !== null) this.tryPickup(a, i, deps);
        continue;
      }

      const from = a.pos.clone();
      a.vel.y -= GRAVITY * delta;
      const to = from.clone().addScaledVector(a.vel, delta);

      if (this.checkEntityHit(a, from, to, deps)) { this.arrows.splice(i, 1); continue; }

      // Block collision: stop at the first solid cell and embed there.
      if (this.overlapsSolid(to, deps.isSolid)) {
        a.embedded = true;
        a.vel.set(0, 0, 0);
        a.pos.copy(to);
        continue;
      }

      a.pos.copy(to);
      a.vel.x *= DRAG;
      a.vel.z *= DRAG;
      a.yaw = headingYaw(a.vel);
      a.pitch = headingPitch(a.vel);
    }
  }

  /**
   * Checks players (mob-shot arrow) or mobs (player-shot arrow) along this
   * frame's travel segment. A player's own arrow deliberately can't hit any
   * player, their own shooter included - PvP is Fase 7 of the port plan and
   * world-do.ts still rejects player-vs-player damage everywhere else too.
   */
  private checkEntityHit(a: Arrow, from: THREE.Vector3, to: THREE.Vector3, deps: ArrowDeps): boolean {
    // a.vel is in blocks/SECOND (POWER_TO_SPEED-scaled for travel feel), but
    // LCE's damage formula expects the original blocks/TICK "power" - undo the
    // scale so damage doesn't come out ~15x too high.
    const speed = a.vel.length() / POWER_TO_SPEED;
    const dmgBase = a.fixedDamage ?? Math.ceil(speed * BASE_DAMAGE);
    const dmg = a.crit ? dmgBase + Math.floor(Math.random() * (dmgBase / 2 + 2)) : dmgBase;

    if (a.ownerId !== null) {
      const dir = to.clone().sub(from);
      const dist = dir.length();
      if (dist < 1e-6) return false;
      dir.normalize();
      const mobId = deps.raycastMobs(from, dir, dist);
      if (mobId === null) return false;
      deps.onHitMob(mobId, dmg, from);
      return true;
    }

    for (const player of deps.players) {
      const closest = closestPointOnSegment(from, to, player.pos);
      if (closest.distanceTo(player.pos) > PLAYER_HIT_RADIUS) continue;
      deps.onHitPlayer(player.id, dmg);
      return true;
    }
    return false;
  }

  /** True if `point` is within PICKUP_MARGIN of that player's whole hitbox (feet to head), not just a sphere around the eye. */
  private nearPlayer(point: THREE.Vector3, playerPos: THREE.Vector3): boolean {
    const feet = playerPos.y - PLAYER_EYE_HEIGHT;
    const closest = new THREE.Vector3(
      THREE.MathUtils.clamp(point.x, playerPos.x - PLAYER_RADIUS, playerPos.x + PLAYER_RADIUS),
      THREE.MathUtils.clamp(point.y, feet, feet + PLAYER_HEIGHT),
      THREE.MathUtils.clamp(point.z, playerPos.z - PLAYER_RADIUS, playerPos.z + PLAYER_RADIUS),
    );
    return closest.distanceTo(point) <= PICKUP_MARGIN;
  }

  /** Anyone can pick a spent arrow back up, not only whoever fired it - same "loot on the ground is public" rule dropped items already follow. */
  private tryPickup(a: Arrow, index: number, deps: ArrowDeps): void {
    if (a.embedTimer < PICKUP_DELAY) return;
    for (const player of deps.players) {
      if (!this.nearPlayer(a.pos, player.pos)) continue;
      if (!deps.collect(player.id)) continue; // inventory full - stays stuck in the wall
      this.arrows.splice(index, 1);
      return;
    }
  }

  private overlapsSolid(p: THREE.Vector3, isSolid: ArrowDeps['isSolid']): boolean {
    const x0 = Math.round(p.x - HALF), x1 = Math.round(p.x + HALF);
    const y0 = Math.round(p.y - HALF), y1 = Math.round(p.y + HALF);
    const z0 = Math.round(p.z - HALF), z1 = Math.round(p.z + HALF);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  snapshots(): ArrowSnapshot[] {
    return this.arrows.map((a) => ({
      entityId: a.entityId,
      pos: { x: a.pos.x, y: a.pos.y, z: a.pos.z },
      yaw: a.yaw,
      pitch: a.pitch,
    }));
  }
}

/** Nearest point on segment [a,b] to point p. */
function closestPointOnSegment(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3): THREE.Vector3 {
  const ab = b.clone().sub(a);
  const lenSq = ab.lengthSq();
  if (lenSq < 1e-9) return a.clone();
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1);
  return a.clone().add(ab.multiplyScalar(t));
}

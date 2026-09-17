// Extraído (no un copy-paste completo) de src/mob-manager.ts el 2026-09-14 -
// ver world-server/src/game/README.md para el criterio de qué se copia vs
// qué sigue compartido con singleplayer. Cambios acá NO se reflejan
// automáticamente en src/mob-manager.ts, y viceversa.
//
// El mob-manager.ts real (592 líneas) trae consigo MobModel/BipedMobModel -
// mallas 3D reales con carga de texturas (necesitan document/Image, que no
// existen en el runtime de Workers). Antes de esta carpeta, mobs.ts
// importaba el archivo real completo solo para sacarle MOB_STATS/Mob/
// isHostileKind, lo cual arrastraba esa cadena pesada y obligó a dos parches
// de compatibilidad en block-preview.ts/custom-cursor.ts para que no
// crashease en el Worker. Esta versión solo tiene lo que mobs.ts/mob-ai.ts/
// mob-physics.ts realmente usan: los tipos y las stats, nada de render.

import * as THREE from 'three';
import type { PathPoint } from './mob-pathfinding';

export type MobKind = 'pig' | 'cow' | 'sheep' | 'zombie' | 'skeleton';

/** Common surface both MobModel (quadruped) and BipedMobModel (zombie) expose in the real client - mobs.ts's spawn() stub only implements getGroup() for real (mob-physics.ts's easeYawTo() writes rotation into it), the rest are no-ops since there's no client-side mesh here to animate. */
export type AnyMobModel = {
  getGroup(): THREE.Group;
  setWalking(walking: boolean): void;
  setLightLevel(level01: number): void;
  hurt(): void;
  setDying(on: boolean): void;
  setOnFire(on: boolean): void;
  update(delta: number): void;
  setAttacking?(on: boolean): void;
};

const HOSTILE_KINDS: MobKind[] = ['zombie', 'skeleton'];
export function isHostileKind(kind: MobKind): boolean {
  return HOSTILE_KINDS.includes(kind);
}

/**
 * Per-species stats, ballpark-matched to LCE (Minecraft Legacy Console
 * Edition) values for these long-unchanged passive mobs: cow/pig 10 HP
 * (5 hearts), sheep 8 HP (4 hearts); pig a little faster than cow/sheep,
 * matching LCE's own relative movement-speed attributes. Flee (panic) speed
 * and duration are LCE's PanicGoal behaviour - sprint away for a few seconds
 * after being hurt, ignoring the wander target until it expires.
 */
export const MOB_STATS: Record<MobKind, { maxHealth: number; walkSpeed: number; fleeSpeedMult: number; radius: number; height: number }> = {
  // Animals: 0.9x0.9 footprint, 1.3 tall (radius is the half-width overlapsSolid uses).
  pig: { maxHealth: 10, walkSpeed: 2.3, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  cow: { maxHealth: 10, walkSpeed: 2.0, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  sheep: { maxHealth: 8, walkSpeed: 2.0, fleeSpeedMult: 3.2, radius: 0.45, height: 1.3 },
  // LCE zombie: 20 HP (10 hearts). No flee behaviour, fleeSpeedMult unused.
  zombie: { maxHealth: 20, walkSpeed: 2.3, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
  // LCE skeleton: 20 HP, runSpeed 0.25 (a bit slower than the zombie's 0.3-ish
  // equivalent) - it mostly stands and shoots rather than closing distance.
  skeleton: { maxHealth: 20, walkSpeed: 2.0, fleeSpeedMult: 1, radius: 0.4, height: 1.9 },
};

export type Mob = {
  id: number;
  kind: MobKind;
  model: AnyMobModel;
  // Authoritative position - a plain Vector3 with no scene attachment, NOT
  // the render mesh's transform. AI/physics (mob-ai.ts/mob-physics.ts) read
  // and write this directly.
  pos: THREE.Vector3;
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
  // Seconds left before a zombie can attempt another leap toward a player
  // standing above it - see LEAP_COOLDOWN in mob-ai.ts.
  leapCooldown: number;
  // Seconds left where a fresh knockback shove should be allowed to decay
  // naturally (friction) instead of being zeroed by the melee AI's anti-hop
  // snap - see updateHostileAI() in mob-ai.ts.
  knockbackTimer: number;
  // Ranged hostile AI (skeleton): seconds of continuous line-of-sight on the
  // target, accumulated toward RANGED_SIGHT_REQUIRED before the first shot.
  rangedSeeTimer: number;
  // Hostile AI memory (zombie + skeleton): seconds left since the mob last
  // had line-of-sight on the player - see SIGHT_MEMORY in mob-ai.ts.
  sightMemory: number;
  // True while sighted+in-range and about to/already shooting - same value
  // mob-ai.ts already feeds into mob.model.setAttacking?.(), just also kept
  // as plain data here so it can ride along in a multiplayer EntitySnapshot
  // (the stub `model` this server gives every mob has no client mesh to
  // actually pose).
  aiming: boolean;
  // Fire (sunlight for zombie/skeleton, or lava/fire contact for any mob):
  // ticks damage while exposed AND for fireTicksLeft ticks after losing
  // exposure (the "after-burn"), independent of combat.
  onFire: boolean;
  fireTicksLeft: number;
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

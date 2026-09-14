import * as THREE from 'three';
import { tintByLight } from './block-preview';
import { ItemId } from './item';
import { makeStack } from './item-stack';
import type { InventorySlot } from './inventory';
import type { MobManager } from './mob-manager';
import type { SoundManager } from './sound-manager';

/**
 * LCE-style arrow entity (Arrow.cpp): flies under gravity, embeds in the first
 * solid block it touches instead of settling on the ground like a dropped
 * item, does a single hit-or-miss check against whatever it can damage (mobs
 * for a player-shot arrow, the player for a mob-shot one - LCE arrows can hit
 * either, but with only skeletons as a ranged shooter today "mob shoots the
 * player" / "player shoots mobs" covers every real case), and can be picked
 * back up once it's stuck.
 */

export const ARROW_GRAVITY = 20; // matches dropped-items.ts's world-gravity feel - exported for mob-ai.ts's shot-arc compensation
const GRAVITY = ARROW_GRAVITY;
const DRAG = 0.99;           // per-frame-ish velocity retention while flying (LCE 0.99/tick)
const HALF = 0.15;           // collision half-extent while flying
const PLAYER_HIT_RADIUS = 0.6;
// Extra reach beyond the player's own hitbox (see tryPickup) - the arrow just
// has to be near the player's body, not floating exactly at eye level.
const PICKUP_MARGIN = 0.5;
const PICKUP_DELAY = 0.3;    // seconds an embedded arrow waits before it can be collected
const BASE_DAMAGE = 2.0;     // LCE Arrow::ARROW_BASE_DAMAGE
const EMBEDDED_DESPAWN = 60; // seconds stuck before it vanishes unclaimed (LCE 20*60 ticks)

// LCE's "power" (BowItem/ArrowAttackGoal, 0..2.0-ish) is a velocity in
// blocks/TICK (20 ticks/sec) - transplanted as a raw number it would be an
// absurdly fast blocks/SECOND value in EvlyMC's units, so it's rescaled by
// this tuned-by-feel factor instead. Adjust this one constant to make arrows
// faster/slower overall without touching the draw-power curve itself.
const POWER_TO_SPEED = 15; // blocks/second per unit of LCE "power"

/** Converts an LCE-style "power" (bow draw 0..1 scaled by *2, or a mob's fixed 1.60) into an EvlyMC blocks/second speed. */
export function powerToSpeed(power: number): number {
  return power * POWER_TO_SPEED;
}

type Arrow = {
  group: THREE.Group;
  hitboxHelper: THREE.LineSegments;
  vel: THREE.Vector3;
  fromPlayer: boolean;
  crit: boolean;
  fixedDamage?: number;
  embedded: boolean;
  embedTimer: number;
};

// --- Dedicated entity mesh: the classic vanilla "billboard cross" - two
// quads crossed 90 degrees around the shaft's own long axis, each stretched
// across the WHOLE dedicated entity texture (textures/entity/arrow.png,
// 16x5: fletching / shaft / arrowhead laid out left-to-right in one strip),
// instead of the previous shaft-box + separate fletch-plane built from the
// item icon. This is the real MC entity texture, not the inventory icon.
const ARROW_LENGTH = 0.7;
const ARROW_THICKNESS = ARROW_LENGTH * (5 / 16); // preserves the 16:5 texture aspect

let crossGeometry: THREE.BufferGeometry | null = null;
let arrowMaterial: THREE.MeshBasicMaterial | null = null;
let tailBarGeoH: THREE.PlaneGeometry | null = null;
let tailBarGeoV: THREE.PlaneGeometry | null = null;
let tailMaterial: THREE.MeshBasicMaterial | null = null;
let hitboxGeo: THREE.BufferGeometry | null = null;
let hitboxMat: THREE.LineBasicMaterial | null = null;

function getArrowMesh(): THREE.Group {
  if (!crossGeometry) {
    // Plane built with its width (mapped to UV.u, the texture's 16-wide
    // shaft-to-tip axis) along local X, then rotated so that axis lands on
    // local Z instead - forward is local -Z (this codebase's convention, see
    // orient() below), and rotateY(+90deg) sends +X (U=1, the arrowhead) to
    // -Z, i.e. the front, with no extra flip needed.
    crossGeometry = new THREE.PlaneGeometry(ARROW_LENGTH, ARROW_THICKNESS);
    crossGeometry.rotateY(Math.PI / 2);
    crossGeometry.userData.shared = true;
  }
  if (!arrowMaterial) {
    const texture = new THREE.TextureLoader().load(new URL('../textures/entity/arrow.png', import.meta.url).href);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    arrowMaterial = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5, side: THREE.DoubleSide });
    arrowMaterial.userData.baseColor = new THREE.Color(0xffffff);
  }

  // Small white "+" marker right at the fletching end (local +Z - the back,
  // since rotateY above sent the front/arrowhead to -Z) - flat against the
  // Z axis (no rotateY, unlike the shaft crosses) so it faces straight back
  // at whoever just fired it, the same angle you're watching the arrow fly
  // away from you.
  if (!tailBarGeoH) {
    const armLen = ARROW_THICKNESS * 2.2;
    const armWidth = ARROW_THICKNESS * 0.4;
    tailBarGeoH = new THREE.PlaneGeometry(armLen, armWidth);
    tailBarGeoH.userData.shared = true;
    tailBarGeoV = new THREE.PlaneGeometry(armWidth, armLen);
    tailBarGeoV.userData.shared = true;
  }
  if (!tailMaterial) {
    tailMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  }

  const group = new THREE.Group();
  group.add(new THREE.Mesh(crossGeometry, arrowMaterial));
  const crossB = new THREE.Mesh(crossGeometry, arrowMaterial);
  crossB.rotation.z = Math.PI / 2; // crossed with the first fin, forming the "+"
  group.add(crossB);

  const tailZ = ARROW_LENGTH / 2 - 0.02; // just shy of the very tip, avoids z-fighting with the fletching texture
  const tailH = new THREE.Mesh(tailBarGeoH, tailMaterial);
  tailH.position.z = tailZ;
  const tailV = new THREE.Mesh(tailBarGeoV!, tailMaterial);
  tailV.position.z = tailZ;
  group.add(tailH, tailV);

  return group;
}

/** Visible wireframe box for the arrow's actual collision hitbox (HALF), toggled with the shared debug key (R). */
function getHitboxHelper(): THREE.LineSegments {
  if (!hitboxGeo) hitboxGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(HALF * 2, HALF * 2, HALF * 2));
  if (!hitboxMat) hitboxMat = new THREE.LineBasicMaterial({ color: 0xff2222 });
  return new THREE.LineSegments(hitboxGeo, hitboxMat);
}

export type ArrowSpawnOptions = {
  /** True if the player fired it (checks mobs for a hit); false if a mob fired it (checks the player). */
  fromPlayer: boolean;
  /** LCE dmg = ceil(velocityMagnitude * baseDamage); crit adds a random bonus on top. */
  crit?: boolean;
  /**
   * Damage this arrow deals, independent of its travel speed - use this for
   * a mob's shot so buffing its speed/range (SKELETON_SHOT_POWER in
   * mob-ai.ts) doesn't also buff its damage through the velocity-based
   * formula below. Omit to use the normal speed-derived damage (the
   * player's own shots, where more draw = more damage is the point).
   */
  fixedDamage?: number;
};

export type ArrowProjectilesDeps = {
  scene: THREE.Scene;
  isSolid: (x: number, y: number, z: number) => boolean;
  mobManager: MobManager;
  /** Player eye position, and a way to damage them (arrow shot by a mob) / collect a recovered arrow into their inventory. */
  getPlayerPos: () => THREE.Vector3;
  /** The player's current hitbox (in blocks), so pickup can reach an arrow embedded anywhere on the body, not just at eye level. */
  getPlayerHitbox: () => { radius: number; height: number; collisionEyeHeight: number };
  onHitPlayer?: (damage: number, fromPos: THREE.Vector3) => void;
  collect: (slot: InventorySlot) => number;
  onPickup?: () => void;
  soundManager?: SoundManager;
  getLight?: (x: number, y: number, z: number) => number;
};

export class ArrowProjectiles {
  private readonly arrows: Arrow[] = [];
  private debug = false;

  constructor(private readonly deps: ArrowProjectilesDeps) {}

  /** Toggle the wireframe hitboxes (bound to the same key as the rest of the debug overlay - R). */
  setDebug(on: boolean): void {
    this.debug = on;
    for (const a of this.arrows) a.hitboxHelper.visible = on;
  }

  /** Fire an arrow from `pos` with the given world-space velocity (blocks/second). */
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, opts: ArrowSpawnOptions): void {
    const group = getArrowMesh();
    group.position.copy(pos);
    this.orient(group, vel);
    this.deps.scene.add(group);

    const hitboxHelper = getHitboxHelper();
    hitboxHelper.position.copy(pos);
    hitboxHelper.visible = this.debug;
    this.deps.scene.add(hitboxHelper);

    this.arrows.push({
      group,
      hitboxHelper,
      vel: vel.clone(),
      fromPlayer: opts.fromPlayer,
      crit: opts.crit ?? false,
      fixedDamage: opts.fixedDamage,
      embedded: false,
      embedTimer: 0,
    });
  }

  private orient(group: THREE.Group, vel: THREE.Vector3): void {
    const horiz = Math.hypot(vel.x, vel.z);
    group.rotation.y = Math.atan2(-vel.x, -vel.z);
    group.rotation.x = Math.atan2(vel.y, horiz);
  }

  update(delta: number): void {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];

      if (a.embedded) {
        a.embedTimer += delta;
        if (a.embedTimer >= EMBEDDED_DESPAWN) { this.removeAt(i); continue; }
        // Only the player's own missed shots can be recovered - a skeleton's
        // arrow just sticks around (and eventually despawns) uncollectible.
        if (a.fromPlayer) this.tryPickup(a, i);
        continue;
      }

      const from = a.group.position.clone();

      a.vel.y -= GRAVITY * delta;
      const step = a.vel.clone().multiplyScalar(delta);
      const to = from.clone().add(step);

      // Entity hit check along this frame's travel segment - a single
      // ray/point test is plenty at this scale (arrows move fast, frames are
      // short, matches LCE's own per-tick segment check).
      if (this.checkEntityHit(a, from, to)) { this.removeAt(i); continue; }

      // Block collision: stop at the first solid cell and embed there.
      if (this.overlapsSolid(to)) {
        a.embedded = true;
        a.vel.set(0, 0, 0);
        a.group.position.copy(to);
        a.hitboxHelper.position.copy(to);
        this.playHitSound('block', to);
        continue;
      }

      a.group.position.copy(to);
      a.hitboxHelper.position.copy(to);
      a.vel.x *= DRAG;
      a.vel.z *= DRAG;
      this.orient(a.group, a.vel);

      if (this.deps.getLight) {
        const level = this.deps.getLight(Math.round(to.x), Math.round(to.y), Math.round(to.z));
        tintByLight(a.group, level / 15);
      }
    }
  }

  /**
   * Checks the player (mob-shot arrow) or the nearest mob (player-shot arrow)
   * along this frame's segment. No "ignore the owner briefly" gate is needed
   * here (unlike LCE's Arrow.cpp) since our shooter/target pairing never
   * overlaps: a player-shot arrow only ever checks mobs, a mob-shot one only
   * ever checks the player - the previous version's blanket gate on every
   * hit (not just self-hits) was silently swallowing close-range shots that
   * arrived before the gate's window elapsed.
   */
  private checkEntityHit(a: Arrow, from: THREE.Vector3, to: THREE.Vector3): boolean {
    // a.vel is in blocks/SECOND (POWER_TO_SPEED-scaled for travel feel), but
    // LCE's damage formula (ceil(velocity * ARROW_BASE_DAMAGE)) expects the
    // original blocks/TICK "power" - undo the scale here so damage doesn't
    // come out ~15x too high (a full-power hit was one-shotting the player).
    const speed = a.vel.length() / POWER_TO_SPEED;
    const dmgBase = a.fixedDamage ?? Math.ceil(speed * BASE_DAMAGE);
    const dmg = a.crit ? dmgBase + Math.floor(Math.random() * (dmgBase / 2 + 2)) : dmgBase;

    if (a.fromPlayer) {
      const dir = to.clone().sub(from);
      const dist = dir.length();
      if (dist < 1e-6) return false;
      dir.normalize();
      const hit = this.deps.mobManager.raycastMobs(from, dir, dist);
      if (!hit) return false;
      this.deps.mobManager.damage(hit.mobId, dmg, from);
      // Positive feedback for the player landing a hit - not played on the
      // reverse case below (a mob's arrow hitting the player already gets
      // its own hurt sound from playerHealth's damage callback in main.ts).
      this.playHitSound('entity', to);
      return true;
    }

    const playerPos = this.deps.getPlayerPos();
    const closest = closestPointOnSegment(from, to, playerPos);
    if (closest.distanceTo(playerPos) > PLAYER_HIT_RADIUS) return false;
    this.deps.onHitPlayer?.(dmg, from);
    return true;
  }

  /**
   * True if `point` is within PICKUP_MARGIN of the player's whole hitbox
   * (feet to head, not just a sphere around the eye) - an arrow stuck on the
   * ground by the player's feet is just as pickable as one at chest height.
   */
  private nearPlayerHitbox(point: THREE.Vector3): boolean {
    const playerPos = this.deps.getPlayerPos();
    const { radius, height, collisionEyeHeight } = this.deps.getPlayerHitbox();
    const feet = playerPos.y - collisionEyeHeight;
    const closest = new THREE.Vector3(
      THREE.MathUtils.clamp(point.x, playerPos.x - radius, playerPos.x + radius),
      THREE.MathUtils.clamp(point.y, feet, feet + height),
      THREE.MathUtils.clamp(point.z, playerPos.z - radius, playerPos.z + radius),
    );
    return closest.distanceTo(point) <= PICKUP_MARGIN;
  }

  private tryPickup(a: Arrow, index: number): void {
    if (a.embedTimer < PICKUP_DELAY) return;
    if (!this.nearPlayerHitbox(a.group.position)) return;
    const leftover = this.deps.collect(makeStack(ItemId.ARROW, 1));
    if (leftover > 0) return; // inventory full - stays on the ground
    this.deps.onPickup?.();
    this.deps.soundManager?.playOne('player/Pop', 0.5);
    this.removeAt(index);
  }

  private playHitSound(kind: 'block' | 'entity', pos: THREE.Vector3): void {
    if (!this.deps.soundManager) return;
    if (kind === 'block') this.deps.soundManager.playRandom('items/Arrow_hit', 4, 0.7);
    else this.deps.soundManager.playOne('items/Successful_hit', 0.8);
  }

  private overlapsSolid(p: THREE.Vector3): boolean {
    const x0 = Math.round(p.x - HALF), x1 = Math.round(p.x + HALF);
    const y0 = Math.round(p.y - HALF), y1 = Math.round(p.y + HALF);
    const z0 = Math.round(p.z - HALF), z1 = Math.round(p.z + HALF);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.deps.isSolid(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  private removeAt(i: number): void {
    const a = this.arrows[i];
    if (!a) return;
    this.deps.scene.remove(a.group);
    this.deps.scene.remove(a.hitboxHelper);
    // No dispose here: geometry/material are shared across every in-flight
    // arrow (getArrowMesh()/getHitboxHelper()), not per-instance - disposing
    // them would break every other arrow still flying.
    this.arrows.splice(i, 1);
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

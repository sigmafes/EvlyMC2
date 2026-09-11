import * as THREE from 'three';
import { BlockId } from './block';
import { ItemId } from './item';

const MAX = 700;
const GRAVITY = 16;
const DRAG = 0.86; // per-second-ish velocity retention (applied as pow(DRAG, dt))
const FAR_AWAY = -100000;

/** Rough representative colour per block/item, for dig / break / eat bits. */
const COLOR: Record<number, number> = {
  [BlockId.DIRT]: 0x775539,
  [BlockId.GRASS]: 0x5b8a3c,
  [BlockId.STONE]: 0x8a8a8a,
  [BlockId.COBBLESTONE]: 0x7d7d7d,
  [BlockId.OAK_PLANKS]: 0xa07f45,
  [BlockId.OAK_LOG]: 0x6b5330,
  [BlockId.SAND]: 0xdbcc8f,
  [BlockId.OAK_LEAVES]: 0x4a7a2a,
  [BlockId.OBSIDIAN]: 0x241a33,
  [BlockId.ICE]: 0x9cc3ff,
  [BlockId.GLASS]: 0xbfe3f0,
  [BlockId.FURNACE]: 0x6a6a6a,
  [BlockId.TORCH]: 0xffcc55,
  [BlockId.GLOWSTONE]: 0xe8c95a,
  [BlockId.BEDROCK]: 0x555555,
  [BlockId.COAL_ORE]: 0x6a6a6a,
  [BlockId.IRON_ORE]: 0x9a8a7a,
  [BlockId.GOLD_ORE]: 0xb0975a,
  [BlockId.DIAMOND_ORE]: 0x7fd3d0,
  [BlockId.EMERALD_ORE]: 0x54b060,
  [BlockId.LAPIS_ORE]: 0x2c50a0,
  [BlockId.REDSTONE_ORE]: 0x9a4a4a,
  [BlockId.WATER]: 0x3f76e4,
  [BlockId.LAVA]: 0xff6a00,
  [BlockId.FIRE]: 0xffa030,
  [ItemId.APPLE]: 0xc0392b,
};

/**
 * Minimal GPU particle pool (one THREE.Points, ring-buffer recycled). Used for
 * the bits that fly off a block while it's mined and when it breaks.
 */
export class ParticleSystem {
  private readonly pos = new Float32Array(MAX * 3);
  private readonly col = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX); // seconds left, 0 = dead
  private readonly geo = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private cursor = 0;
  private readonly tmpColor = new THREE.Color();

  constructor() {
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = FAR_AWAY;
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const material = new THREE.PointsMaterial({
      size: 0.11,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, material);
    this.points.frustumCulled = false;
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.points);
  }

  private emit(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    color: number, ttl: number, light = 1,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.tmpColor.set(color);
    const b = Math.pow(Math.min(Math.max(light, 0), 1), 1.25);
    this.col[i * 3] = this.tmpColor.r * b; this.col[i * 3 + 1] = this.tmpColor.g * b; this.col[i * 3 + 2] = this.tmpColor.b * b;
    this.life[i] = ttl;
  }

  /** Burst of bits when a block is destroyed. `light01` shades them to the world. */
  burst(pos: THREE.Vector3, id: number, light01 = 1): void {
    const color = COLOR[id] ?? 0x888888;
    for (let k = 0; k < 34; k++) {
      this.emit(
        pos.x + (Math.random() - 0.5) * 0.9,
        pos.y + (Math.random() - 0.5) * 0.9,
        pos.z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 4.5,
        Math.random() * 4 + 1.5,
        (Math.random() - 0.5) * 4.5,
        color,
        0.5 + Math.random() * 0.45,
        light01,
      );
    }
  }

  /** A few chips off the hit face while mining. `light01` shades them to the world. */
  mine(pos: THREE.Vector3, faceNormal: THREE.Vector3, id: number, light01 = 1): void {
    const color = COLOR[id] ?? 0x888888;
    for (let k = 0; k < 4; k++) {
      this.emit(
        pos.x + faceNormal.x * 0.52 + (Math.random() - 0.5) * 0.55,
        pos.y + faceNormal.y * 0.52 + (Math.random() - 0.5) * 0.55,
        pos.z + faceNormal.z * 0.52 + (Math.random() - 0.5) * 0.55,
        faceNormal.x * 1.2 + (Math.random() - 0.5) * 1.4,
        faceNormal.y * 1.2 + Math.random() * 1.8,
        faceNormal.z * 1.2 + (Math.random() - 0.5) * 1.4,
        color,
        0.3 + Math.random() * 0.2,
        light01,
      );
    }
  }

  update(dt: number): void {
    const damp = Math.pow(DRAG, dt);
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = FAR_AWAY;
        continue;
      }
      this.vel[i * 3] *= damp;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * damp - GRAVITY * dt;
      this.vel[i * 3 + 2] *= damp;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

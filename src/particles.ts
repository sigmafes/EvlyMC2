import * as THREE from 'three';
import type { BlockMaterials } from './block';
import { ITEMS, isBlock } from './item';

const MAX = 200;
const GRAVITY = 16;
const DRAG = 0.86; // per-second-ish velocity retention (applied as pow(DRAG, dt))
const FAR_AWAY = -100000;
const CHIP_UV_SIZE = 0.25; // fraction of the source texture a chip samples, like vanilla MC's particle crop
const FADE_TAIL = 0.15; // seconds of fade-out before a particle dies

/**
 * Textured-chip particle pool (one small billboard-ish plane mesh per slot,
 * ring-buffer recycled). Each particle samples a small random square out of
 * the actual block/item texture it came from (vanilla MC's own technique),
 * rather than a flat approximated colour - used for the bits that fly off a
 * block while it's mined, when it breaks, and while eating.
 */
export class ParticleSystem {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly angVel: THREE.Vector3[] = [];
  private readonly life: number[] = [];
  private cursor = 0;
  /** Cached per-id texture clones (own offset/repeat, sharing the same GPU image as the world/item texture). */
  private readonly textureCache = new Map<number, THREE.Texture | null>();
  private readonly itemLoader = new THREE.TextureLoader();

  constructor(private readonly blockMaterials: BlockMaterials) {
    const geo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < MAX; i++) {
      const material = new THREE.MeshBasicMaterial({
        transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.position.y = FAR_AWAY;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.vel.push(new THREE.Vector3());
      this.angVel.push(new THREE.Vector3());
      this.life.push(0);
    }
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** The texture to chip particles from for a block or item id, or null if there isn't one (falls back to a plain white quad). */
  private textureFor(id: number): THREE.Texture | null {
    if (this.textureCache.has(id)) return this.textureCache.get(id)!;

    let source: THREE.Texture | null = null;
    if (isBlock(id)) {
      const mat = (this.blockMaterials as Record<number, THREE.Material | THREE.Material[]>)[id];
      const base = Array.isArray(mat) ? mat[0] : mat;
      source = (base as THREE.MeshBasicMaterial | undefined)?.map ?? null;
    } else {
      const itemTexture = ITEMS[id]?.texture;
      if (itemTexture) {
        source = this.itemLoader.load(new URL(`../textures/${itemTexture}`, import.meta.url).href);
        source.magFilter = THREE.NearestFilter;
        source.minFilter = THREE.NearestFilter;
        source.colorSpace = THREE.SRGBColorSpace;
      }
    }

    // Clone so this id's random offset/repeat never fights the source's own
    // (the world mesh's texture is still animated/scrolled for water etc).
    const texture = source ? source.clone() : null;
    if (texture) {
      texture.needsUpdate = true;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.NearestFilter;
    }
    this.textureCache.set(id, texture);
    return texture;
  }

  private spawnOne(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    id: number, ttl: number, scale: number, light01: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    const mesh = this.meshes[i];
    const material = mesh.material as THREE.MeshBasicMaterial;

    const texture = this.textureFor(id);
    material.map = texture;
    if (texture) {
      const ox = Math.random() * (1 - CHIP_UV_SIZE);
      const oy = Math.random() * (1 - CHIP_UV_SIZE);
      texture.offset.set(ox, oy);
      texture.repeat.set(CHIP_UV_SIZE, CHIP_UV_SIZE);
    }
    const b = Math.pow(THREE.MathUtils.clamp(light01, 0, 1), 1.25);
    material.color.setScalar(b);
    material.opacity = 1;
    material.needsUpdate = true;

    mesh.position.set(x, y, z);
    mesh.scale.setScalar(scale);
    mesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);
    mesh.visible = true;

    this.vel[i].set(vx, vy, vz);
    this.angVel[i].set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
    this.life[i] = ttl;
  }

  /** Burst of bits when a block is destroyed. Bigger and fewer than a mine() chip. `light01` shades them to the world. */
  burst(pos: THREE.Vector3, id: number, light01 = 1): void {
    for (let k = 0; k < 16; k++) {
      this.spawnOne(
        pos.x + (Math.random() - 0.5) * 0.9,
        pos.y + (Math.random() - 0.5) * 0.9,
        pos.z + (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 4.5,
        Math.random() * 4 + 1.5,
        (Math.random() - 0.5) * 4.5,
        id,
        0.5 + Math.random() * 0.45,
        0.28 + Math.random() * 0.12,
        light01,
      );
    }
  }

  /** A few chips off the hit face while mining. `light01` shades them to the world. */
  mine(pos: THREE.Vector3, faceNormal: THREE.Vector3, id: number, light01 = 1): void {
    for (let k = 0; k < 4; k++) {
      this.spawnOne(
        pos.x + faceNormal.x * 0.52 + (Math.random() - 0.5) * 0.55,
        pos.y + faceNormal.y * 0.52 + (Math.random() - 0.5) * 0.55,
        pos.z + faceNormal.z * 0.52 + (Math.random() - 0.5) * 0.55,
        faceNormal.x * 1.2 + (Math.random() - 0.5) * 1.4,
        faceNormal.y * 1.2 + Math.random() * 1.8,
        faceNormal.z * 1.2 + (Math.random() - 0.5) * 1.4,
        id,
        0.3 + Math.random() * 0.2,
        0.22 + Math.random() * 0.08,
        light01,
      );
    }
  }

  update(dt: number): void {
    const damp = Math.pow(DRAG, dt);
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const mesh = this.meshes[i];
      if (this.life[i] <= 0) {
        mesh.visible = false;
        mesh.position.y = FAR_AWAY;
        continue;
      }
      this.vel[i].x *= damp;
      this.vel[i].y = this.vel[i].y * damp - GRAVITY * dt;
      this.vel[i].z *= damp;
      mesh.position.addScaledVector(this.vel[i], dt);
      mesh.rotation.x += this.angVel[i].x * dt;
      mesh.rotation.y += this.angVel[i].y * dt;
      mesh.rotation.z += this.angVel[i].z * dt;

      if (this.life[i] < FADE_TAIL) {
        (mesh.material as THREE.MeshBasicMaterial).opacity = this.life[i] / FADE_TAIL;
      }
    }
  }
}

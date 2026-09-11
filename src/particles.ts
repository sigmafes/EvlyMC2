import * as THREE from 'three';
import type { BlockMaterials } from './block';
import { ITEMS, isBlock } from './item';

const MAX = 200;
const GRAVITY = 16;
const DRAG = 0.86; // per-second-ish velocity retention (applied as pow(DRAG, dt))
const FAR_AWAY = -100000;
const CHIP_UV_SIZE = 0.25; // fraction of the source texture a chip samples, like vanilla MC's particle crop
const FADE_TAIL = 0.15; // seconds of fade-out before a particle dies
const MIN_TINT = 0.25; // never let the light tint multiply a chip all the way to black

/**
 * Textured-chip particle pool: each active slot is its own small quad mesh
 * (own BufferGeometry), so both its UV crop and its light-level tint can be
 * baked into that geometry (UV coords / a per-vertex colour attribute)
 * without ever touching a *shared* texture or material - mutating a shared
 * texture's offset/repeat, or a shared material's colour, for one particle
 * used to bleed into every other particle (and every chunk of the world)
 * still rendering with that same texture/material object, which is what
 * made these render solid black. Materials are cached and shared per
 * block/item id (their map is never touched after creation); each particle
 * billboards to face the camera every frame instead of tumbling. Used for
 * the bits that fly off a block while it's mined, when it breaks, and while
 * eating.
 */
export class ParticleSystem {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly life: number[] = [];
  private cursor = 0;
  private readonly materialCache = new Map<number, THREE.MeshBasicMaterial | null>();
  private readonly itemLoader = new THREE.TextureLoader();

  constructor(private readonly blockMaterials: BlockMaterials) {
    for (let i = 0; i < MAX; i++) {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(12).fill(1), 3));
      const mesh = new THREE.Mesh(geo);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.position.y = FAR_AWAY;
      this.group.add(mesh);
      this.meshes.push(mesh);
      this.vel.push(new THREE.Vector3());
      this.life.push(0);
    }
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** The (shared, never mutated) material to render chips of a block or item id with, or null if there's no texture for it. */
  private materialFor(id: number): THREE.MeshBasicMaterial | null {
    if (this.materialCache.has(id)) return this.materialCache.get(id)!;

    let source: THREE.Texture | null = null;
    let baseMaterial: THREE.MeshBasicMaterial | undefined;
    if (isBlock(id)) {
      const mat = (this.blockMaterials as Record<number, THREE.Material | THREE.Material[]>)[id];
      const base = Array.isArray(mat) ? mat[0] : mat;
      baseMaterial = base as THREE.MeshBasicMaterial | undefined;
      source = baseMaterial?.map ?? null;
    } else {
      const itemTexture = ITEMS[id]?.texture;
      if (itemTexture) {
        source = this.itemLoader.load(new URL(`../textures/${itemTexture}`, import.meta.url).href);
        source.magFilter = THREE.NearestFilter;
        source.minFilter = THREE.NearestFilter;
        source.colorSpace = THREE.SRGBColorSpace;
      }
    }

    const material = source
      ? new THREE.MeshBasicMaterial({
        map: source,
        vertexColors: true,
        transparent: true,
        // Inherit the block's own cutout threshold (leaves/glass are 0.5), so a
        // chip cropped from a see-through part of the texture drops out cleanly
        // instead of lingering as a murky half-transparent square.
        alphaTest: Math.max(0.05, baseMaterial?.alphaTest ?? 0),
        side: THREE.DoubleSide,
        depthWrite: false,
      })
      : null;
    // Carry over the block material's own tint. Leaves are the case that needs
    // it: oak_leaves.png is a greyscale/indexed texture that only becomes green
    // because its material multiplies in 0x4a8a2e, so without this its chips
    // broke off grey. (Untinted blocks have a white colour here, a no-op.)
    if (material && baseMaterial?.color) material.color.copy(baseMaterial.color);
    this.materialCache.set(id, material);
    return material;
  }

  private spawnOne(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    id: number, ttl: number, scale: number, light01: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    const mesh = this.meshes[i];

    const material = this.materialFor(id);
    if (!material) {
      mesh.visible = false;
      this.life[i] = 0;
      return;
    }
    mesh.material = material;
    material.opacity = 1;

    const geo = mesh.geometry as THREE.PlaneGeometry;
    // Random small crop of the source texture (vanilla MC's own "chip" look).
    const u0 = Math.random() * (1 - CHIP_UV_SIZE);
    const v0 = Math.random() * (1 - CHIP_UV_SIZE);
    const u1 = u0 + CHIP_UV_SIZE;
    const v1 = v0 + CHIP_UV_SIZE;
    // PlaneGeometry's default UV order: bottom-left, bottom-right, top-left, top-right.
    (geo.attributes.uv as THREE.BufferAttribute).set([u0, v0, u1, v0, u0, v1, u1, v1]);
    geo.attributes.uv.needsUpdate = true;

    // Floor the tint: a chip is a lit-from-somewhere fleck of the block, and
    // a caller that samples light from inside a solid cell (0) would
    // otherwise multiply the texture down to a pure black square.
    const b = Math.max(MIN_TINT, Math.pow(THREE.MathUtils.clamp(light01, 0, 1), 1.25));
    (geo.attributes.color as THREE.BufferAttribute).set(new Array(4).fill([b, b, b]).flat());
    geo.attributes.color.needsUpdate = true;

    mesh.position.set(x, y, z);
    mesh.scale.setScalar(scale);
    mesh.visible = true;

    this.vel[i].set(vx, vy, vz);
    this.life[i] = ttl;
  }

  /** Burst of bits when a block is destroyed. `light01` shades them to the world. */
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
        0.12 + Math.random() * 0.05,
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
        0.10 + Math.random() * 0.04,
        light01,
      );
    }
  }

  /** Advances physics and fade-out, and billboards every live particle to face `camera`. */
  update(dt: number, camera: THREE.Camera): void {
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
      mesh.quaternion.copy(camera.quaternion); // always face the camera - never rotates on its own

      if (this.life[i] < FADE_TAIL) {
        (mesh.material as THREE.MeshBasicMaterial).opacity = this.life[i] / FADE_TAIL;
      }
    }
  }
}

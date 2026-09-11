import * as THREE from 'three';
import { applyAtlasUVs, applyFaceShading, type FaceRects, type FaceFlips } from './atlas-box';

const DEG = Math.PI / 180;

/**
 * One box of a quadruped model. `pivot` is the box's centre, in blocks,
 * relative to the model's own origin - which sits at ground level, centred
 * under the body (so placing a mob in the world is just `group.position.set
 * (x, groundY, z)`, same convention as everything else placed by block coords).
 */
export type QuadrupedBoxSpec = {
  size: [number, number, number];
  pivot: [number, number, number];
  uv: FaceRects;
  /** Per-face U/V mirroring - e.g. to spin a texture crop 180° (flip both) when the art's own orientation doesn't match the face it lands on. */
  flips?: FaceFlips;
};

/** A small extra box (pig snout, etc.), positioned relative to the head or the body. */
export type QuadrupedExtraSpec = QuadrupedBoxSpec & { parent?: 'head' | 'body' };

export type QuadrupedLegSpec = {
  size: [number, number, number];
  uv: FaceRects;
};

export type QuadrupedOverlaySpec = QuadrupedBoxSpec & {
  /** Extra inflation per side, in blocks (MCPE-style shell over the base box, e.g. sheep wool). */
  inflate: number;
};

export type QuadrupedSpec = {
  texturePath: string;
  textureW: number;
  textureH: number;
  head: QuadrupedBoxSpec;
  body: QuadrupedBoxSpec;
  leg: QuadrupedLegSpec;
  /** Leg attachment points (top of each leg), order: front-left, front-right, back-left, back-right. */
  legPivots: [number, number, number][];
  /** Second inflated layer with alpha cutouts (sheep wool, etc.) - omit if the species has none. */
  overlay?: QuadrupedOverlaySpec;
  /** Small extra boxes attached to the head or body (a pig's snout, etc.). */
  extras?: QuadrupedExtraSpec[];
};

// --- Per-texture-path shared resources: the Texture (GPU-expensive, one per
// species is enough) is cached and reused, but each MobModel instance gets
// its OWN Material so setLightLevel() can tint one mob without dragging every
// other mob of the same species along with it - the exact bug that hit the
// player model/inventory doll sharing a single material (see player-model.ts).
const textureCache = new Map<string, THREE.Texture>();
function getMobTexture(texturePath: string): THREE.Texture {
  let texture = textureCache.get(texturePath);
  if (texture) return texture;
  texture = new THREE.TextureLoader().load(texturePath);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(texturePath, texture);
  return texture;
}

function buildBox(spec: QuadrupedBoxSpec, textureW: number, textureH: number, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BoxGeometry(...spec.size);
  applyAtlasUVs(geo, spec.uv, textureW, textureH, spec.flips);
  applyFaceShading(geo);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(...spec.pivot);
  return mesh;
}

const WALK_CYCLE_DURATION = 0.7; // seconds per full stride cycle
const LEG_SWING = 35 * DEG;
const WALK_HEAD_BOB = 3 * DEG;
const IDLE_HEAD_SWAY = 2 * DEG;
const EASE_RATE = 10; // higher = snappier transition between walking/idle

/**
 * Generic quadruped mob model (pig/cow/sheep share this, just different
 * QuadrupedSpecs) - the same box+UV+face-shading machinery as PlayerModel,
 * without any of the player-specific rigging (first-person hand, inventory
 * doll, sneak pose, held items) a mob doesn't need.
 */
export class MobModel {
  readonly group = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly legGroups: THREE.Group[] = [];
  private readonly material: THREE.MeshBasicMaterial;
  private readonly overlayMaterial: THREE.MeshBasicMaterial | null = null;

  private walking = false;
  private legPhase = 0;      // 0..1, advances only while walking
  private walkAmount = 0;    // eased 0..1 - drives swing amplitude, smooths start/stop
  private idleTime = 0;

  constructor(private readonly spec: QuadrupedSpec) {
    const texture = getMobTexture(spec.texturePath);
    this.material = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true });

    this.group.add(buildBox(spec.body, spec.textureW, spec.textureH, this.material));

    this.headGroup.position.set(...spec.head.pivot);
    const headMesh = buildBox({ ...spec.head, pivot: [0, 0, 0] }, spec.textureW, spec.textureH, this.material);
    this.headGroup.add(headMesh);
    this.group.add(this.headGroup);

    const legGeo = new THREE.BoxGeometry(...spec.leg.size);
    applyAtlasUVs(legGeo, spec.leg.uv, spec.textureW, spec.textureH);
    applyFaceShading(legGeo);
    for (const pivot of spec.legPivots) {
      const legGroup = new THREE.Group();
      legGroup.position.set(...pivot);
      const legMesh = new THREE.Mesh(legGeo, this.material);
      legMesh.position.set(0, -spec.leg.size[1] / 2, 0); // leg hangs down from its pivot
      legGroup.add(legMesh);
      this.group.add(legGroup);
      this.legGroups.push(legGroup);
    }

    if (spec.overlay) {
      this.overlayMaterial = new THREE.MeshBasicMaterial({
        map: texture, vertexColors: true, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
      });
      const [w, h, d] = spec.overlay.size;
      const inflate = spec.overlay.inflate;
      const overlayMesh = buildBox(
        { ...spec.overlay, size: [w + inflate * 2, h + inflate * 2, d + inflate * 2] },
        spec.textureW, spec.textureH, this.overlayMaterial,
      );
      this.group.add(overlayMesh);
    }

    for (const extra of spec.extras ?? []) {
      const mesh = buildBox(extra, spec.textureW, spec.textureH, this.material);
      if (extra.parent === 'head') this.headGroup.add(mesh);
      else this.group.add(mesh);
    }
  }

  getGroup(): THREE.Group {
    return this.group;
  }

  /** Start/stop the walk cycle; transitions ease in/out instead of snapping. */
  setWalking(walking: boolean): void {
    this.walking = walking;
  }

  /** Tint by world light level (0..1), matching the terrain/player shading curve. */
  setLightLevel(level01: number): void {
    const b = Math.pow(THREE.MathUtils.clamp(level01, 0, 1), 1.25);
    this.material.color.setScalar(b);
    if (this.overlayMaterial) this.overlayMaterial.color.setScalar(b);
  }

  /** Advance idle/walk animation. Call once per frame. */
  update(delta: number): void {
    this.idleTime += delta;

    const target = this.walking ? 1 : 0;
    const k = 1 - Math.exp(-EASE_RATE * delta);
    this.walkAmount += (target - this.walkAmount) * k;

    if (this.walking) {
      this.legPhase = (this.legPhase + delta / WALK_CYCLE_DURATION) % 1;
    }

    // Diagonal pairs swing together (front-left+back-right vs front-right+back-left).
    const swing = Math.sin(this.legPhase * Math.PI * 2) * LEG_SWING * this.walkAmount;
    const order: [number, number, number, number] = [1, -1, -1, 1]; // FL, FR, BL, BR
    this.legGroups.forEach((leg, i) => { leg.rotation.x = swing * order[i]; });

    const walkBob = Math.sin(this.legPhase * Math.PI * 4) * WALK_HEAD_BOB * this.walkAmount;
    const idleSway = Math.sin(this.idleTime * 1.5) * IDLE_HEAD_SWAY * (1 - this.walkAmount);
    this.headGroup.rotation.x = walkBob + idleSway;
  }
}

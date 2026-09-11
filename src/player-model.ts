import * as THREE from 'three';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh, tintByLight } from './block-preview';
import { BLOCK_CATALOG } from './creative-palette';
import { BlockId } from './block';
import { ITEMS, isBlock } from './item';
import {
  type FaceRects, type FaceFlips, MIRROR_U, applyAtlasUVs as applyAtlasUVsRaw, applyFaceShading,
} from './atlas-box';

export type ModelAdjustments = {
  head: { x: number; y: number; z: number };
  torso: { x: number; y: number; z: number };
  armLeft: { x: number; y: number; z: number };
  armRight: { x: number; y: number; z: number };
  legs: { x: number; y: number; z: number };
};

// --- Shared skin atlas (textures/player.png, a 64x64 Minecraft skin) ---
const ATLAS_PATH = new URL('../textures/player.png', import.meta.url).href;
const ATLAS_W = 64;
const ATLAS_H = 64;

/**
 * One material with the atlas map, shared by every body part.
 * Unlit (MeshBasicMaterial) so the skin reads at full brightness, like the
 * previous textured head — MeshStandardMaterial rendered it near-black.
 */
let sharedAtlasMaterial: THREE.MeshBasicMaterial | null = null;
function getAtlasMaterial(): THREE.MeshBasicMaterial {
  if (sharedAtlasMaterial) return sharedAtlasMaterial;
  const texture = new THREE.TextureLoader().load(ATLAS_PATH);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  sharedAtlasMaterial = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true });
  return sharedAtlasMaterial;
}

/**
 * Point both the base atlas material AND the outer 3D-layer overlay material
 * (hat/jacket/sleeves/pants - see getOverlayMaterial()) at the same new
 * texture, then dispose whatever they both used to share. Overlay's map is
 * only ever seeded once, at first use, as a snapshot of whatever the atlas
 * had then - if a skin swap only ever touched the atlas material, the
 * overlay kept showing the old skin's 3D layers (or, worse, a disposed
 * texture once the old one was freed).
 */
function setSharedSkinTexture(texture: THREE.Texture): void {
  const atlas = getAtlasMaterial();
  const overlay = overlayMaterial; // don't force-create it if nothing has yet
  const oldTexture = atlas.map;
  atlas.map = texture;
  atlas.needsUpdate = true;
  if (overlay) {
    overlay.map = texture;
    overlay.needsUpdate = true;
  }
  if (oldTexture && oldTexture !== texture) oldTexture.dispose();
}

/**
 * Swap the skin atlas for a custom one (Player Options -> Import Skin).
 * Replaces the shared materials' map in place, so every existing mesh built
 * with getAtlasMaterial()/getSkinAtlasMaterial() - the world player model, the
 * inventory doll(s), the first-person arm, and their 3D overlay layers -
 * picks it up immediately without needing to be rebuilt.
 */
export function applySkinTexture(image: HTMLImageElement): void {
  const texture = new THREE.Texture(image);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  setSharedSkinTexture(texture);
}

/** Revert to the built-in default skin (Player Options -> Reset Skin). */
export function resetSkinTexture(): void {
  const texture = new THREE.TextureLoader().load(ATLAS_PATH);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  setSharedSkinTexture(texture);
}

// --- Outer "3D" layer (hat / jacket / sleeves / pants). Same atlas as the base. ---
// MCPE inflates the shell box by g=0.5 px per side. In EvlyMC units that is
// ~0.069 blocks on width/depth and ~0.063 on height (px->block ratio differs per axis).
const INFLATE_WD = 0.069;
const INFLATE_H = 0.063;

let overlayMaterial: THREE.MeshBasicMaterial | null = null;
function getOverlayMaterial(): THREE.MeshBasicMaterial {
  if (overlayMaterial) return overlayMaterial;
  // Reuse the base atlas texture (player.png); if the skin has 3D layers the
  // overlay regions carry alpha and alphaTest cuts out the empty parts.
  const texture = getAtlasMaterial().map;
  overlayMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });
  return overlayMaterial;
}

/** player.png-bound wrapper: applyAtlasUVsRaw() (atlas-box.ts) needs the atlas
 *  size explicitly since it's shared with mobs, which use a different one. */
function applyAtlasUVs(geo: THREE.BoxGeometry, rects: FaceRects, flips: FaceFlips = {}) {
  applyAtlasUVsRaw(geo, rects, ATLAS_W, ATLAS_H, flips);
}

/** Shortest signed angle in (-PI, PI]. */
function wrapAngle(a: number): number {
  a = a % (Math.PI * 2);
  if (a <= -Math.PI) a += Math.PI * 2;
  else if (a > Math.PI) a -= Math.PI * 2;
  return a;
}

/**
 * Atlas pixel rects per body part, derived from MCPE 0.6.1 (loro/src/client/model:
 * HumanoidModel.cpp texOffs + Cube.cpp face formula), 64x64 skin layout.
 * Keys are EvlyMC cube faces; the model faces -Z so nz = MCPE "Front".
 */
const SKIN_UV = {
  head: {
    nz: [8, 8, 15, 15], pz: [24, 8, 31, 15], px: [0, 8, 7, 15],
    nx: [16, 8, 23, 15], py: [8, 0, 15, 7], ny: [16, 0, 23, 7],
  } as FaceRects,
  torso: {
    nz: [20, 20, 27, 31], pz: [32, 20, 39, 31], px: [16, 20, 19, 31],
    nx: [28, 20, 31, 31], py: [20, 16, 27, 19], ny: [28, 16, 35, 19],
  } as FaceRects,
  armRight: {
    nz: [44, 20, 47, 31], pz: [52, 20, 55, 31], px: [40, 20, 43, 31],
    nx: [48, 20, 51, 31], py: [44, 16, 47, 19], ny: [48, 16, 51, 19],
  } as FaceRects,
  armLeft: {
    nz: [36, 52, 39, 63], pz: [44, 52, 47, 63], px: [32, 52, 35, 63],
    nx: [40, 52, 43, 63], py: [36, 48, 39, 51], ny: [40, 48, 43, 51],
  } as FaceRects,
  legRight: {
    nz: [4, 20, 7, 31], pz: [12, 20, 15, 31], px: [0, 20, 3, 31],
    nx: [8, 20, 11, 31], py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  } as FaceRects,
  legLeft: {
    nz: [20, 52, 23, 63], pz: [28, 52, 31, 63], px: [16, 52, 19, 63],
    nx: [24, 52, 27, 63], py: [20, 48, 23, 51], ny: [24, 48, 27, 51],
  } as FaceRects,
};

/**
 * Outer 3D layer rects (MCPE overlay boxes: hair/jacket/sleeves/pants,
 * texOffs from HumanoidModel.cpp lines 46, 69-82). Same face convention as SKIN_UV.
 */
const SKIN_UV_OVERLAY = {
  hat: {
    nz: [40, 8, 47, 15], pz: [56, 8, 63, 15], px: [32, 8, 39, 15],
    nx: [48, 8, 55, 15], py: [40, 0, 47, 7], ny: [48, 0, 55, 7],
  } as FaceRects,
  jacket: {
    nz: [20, 36, 27, 47], pz: [32, 36, 39, 47], px: [16, 36, 19, 47],
    nx: [28, 36, 31, 47], py: [20, 32, 27, 35], ny: [28, 32, 35, 35],
  } as FaceRects,
  sleeveRight: {
    nz: [44, 36, 47, 47], pz: [52, 36, 55, 47], px: [40, 36, 43, 47],
    nx: [48, 36, 51, 47], py: [44, 32, 47, 35], ny: [48, 32, 51, 35],
  } as FaceRects,
  sleeveLeft: {
    nz: [52, 52, 55, 63], pz: [60, 52, 63, 63], px: [48, 52, 51, 63],
    nx: [56, 52, 59, 63], py: [52, 48, 55, 51], ny: [56, 48, 59, 51],
  } as FaceRects,
  pantRight: {
    nz: [4, 36, 7, 47], pz: [12, 36, 15, 47], px: [0, 36, 3, 47],
    nx: [8, 36, 11, 47], py: [4, 32, 7, 35], ny: [8, 32, 11, 35],
  } as FaceRects,
  pantLeft: {
    nz: [4, 52, 7, 63], pz: [12, 52, 15, 63], px: [0, 52, 3, 63],
    nx: [8, 52, 11, 63], py: [4, 48, 7, 51], ny: [8, 48, 11, 51],
  } as FaceRects,
};

// --- Slim ("Alex") arms: 3 px wide instead of 4. Depth (px/nx faces) is unchanged. ---
const ARM_WIDTH = 0.275;
const ARM_WIDTH_SLIM = 0.20625; // 3/4 of classic
// Keep the inner edge (toward the torso) fixed when switching to slim.
const ARM_SLIM_INSET = (ARM_WIDTH - ARM_WIDTH_SLIM) / 2;

const SKIN_UV_SLIM = {
  armRight: {
    nz: [44, 20, 46, 31], pz: [51, 20, 53, 31], px: [40, 20, 43, 31],
    nx: [47, 20, 50, 31], py: [44, 16, 46, 19], ny: [47, 16, 49, 19],
  } as FaceRects,
  armLeft: {
    nz: [36, 52, 38, 63], pz: [43, 52, 45, 63], px: [32, 52, 35, 63],
    nx: [39, 52, 42, 63], py: [36, 48, 38, 51], ny: [39, 48, 41, 51],
  } as FaceRects,
};

/**
 * Standalone arm-box builder, shared with the first-person hand renderer so it
 * gets the exact same skin UVs / face shading as the third-person model.
 */
export function buildArmGeometry(side: 'left' | 'right', slim: boolean): THREE.BoxGeometry {
  const width = slim ? ARM_WIDTH_SLIM : ARM_WIDTH;
  const geo = new THREE.BoxGeometry(width, 0.76, 0.275);
  const rects = side === 'right'
    ? (slim ? SKIN_UV_SLIM.armRight : SKIN_UV.armRight)
    : (slim ? SKIN_UV_SLIM.armLeft : SKIN_UV.armLeft);
  applyAtlasUVs(geo, rects, side === 'left' ? MIRROR_U : {});
  applyFaceShading(geo);
  return geo;
}

/** The shared player-skin atlas material (vertex-colour shaded, nearest-filtered). */
export function getSkinAtlasMaterial(): THREE.MeshBasicMaterial {
  return getAtlasMaterial();
}

// --- Sneak pose (MCPE 0.6.1 HumanoidModel::setupAnim) ---
const SNEAK_TORSO_PITCH = -0.5;  // rad, torso leans forward about the neck pivot
const SNEAK_ARM_PITCH = -0.4;    // rad, added on top of the walk swing (same sign as torso lean)
const SNEAK_HEAD_DY = -0.16;      // head drops with the crouch
const SNEAK_HEAD_DZ = -0.07;      // and leans forward (-Z) over the tilted torso
const SNEAK_BODY_DY = -0.08;      // torso + arms + legs sink (head excluded)
const SNEAK_BODY_DZ = -0.03;      // torso + arms + legs shift forward (-Z)
const SNEAK_DAMP = 14;           // higher = snappier in/out
const TORSO_LEN = 0.76;          // torso height; the hips sit this far below the neck pivot

const SKIN_UV_OVERLAY_SLIM = {
  sleeveRight: {
    nz: [44, 36, 46, 47], pz: [51, 36, 53, 47], px: [40, 36, 43, 47],
    nx: [47, 36, 50, 47], py: [44, 32, 46, 35], ny: [47, 32, 49, 35],
  } as FaceRects,
  sleeveLeft: {
    nz: [52, 52, 54, 63], pz: [59, 52, 61, 63], px: [48, 52, 51, 63],
    nx: [55, 52, 58, 63], py: [52, 48, 54, 51], ny: [55, 48, 57, 51],
  } as FaceRects,
};

/**
 * Creates a 3D player model (Steve from Minecraft).
 * All dimensions in blocks.
 * No animations - static model only.
 */
export class PlayerModel {
  readonly group: THREE.Group;
  private head?: THREE.Mesh;
  private torso?: THREE.Mesh;
  private armLeft?: THREE.Mesh;
  private armRight?: THREE.Mesh;
  private legLeft?: THREE.Mesh;
  private legRight?: THREE.Mesh;
  private armLeftGroup?: THREE.Group;
  private armLeftRotation = 0;
  private armRightGroup?: THREE.Group;
  private armRightRotation = 0;
  /** Fist pivot on the right arm; the held block/item hangs off this. */
  private handAnchor?: THREE.Group;
  private heldMesh?: THREE.Group;
  private heldId: number | null = null;
  private lightLevel = 1;
  private legLeftGroup?: THREE.Group;
  private legLeftRotation = 0;
  private legRightGroup?: THREE.Group;
  private legRightRotation = 0;
  private headColorMaterial?: THREE.Material;
  private isWalking = false;
  private isReturning = false;
  private walkCycleTime = 0;
  private returnStartTime = 0;
  private readonly WALK_CYCLE_DURATION = 1.0; // 1 second for full cycle (0.25s per phase)
  private readonly RETURN_DURATION = 0.3; // 0.3 seconds to return to idle
  private returnStartAngleLeft = 0;
  private returnStartAngleRight = 0;
  private returnStartLegAngleLeft = 0;
  private returnStartLegAngleRight = 0;
  // Third-person attack/mine swing (loro Player::swing) - an overlay on top
  // of the right arm's walk-cycle/idle angle, same duration as the
  // first-person hand's own swing (first-person-hand.ts SWING_DURATION).
  private swinging = false;
  private swingTime = 0;
  private readonly SWING_DURATION = 0.3;
  private readonly SWING_ARC = Math.PI / 2;
  // Hurt flash (same non-emissive 75%-red tint as MobModel.hurt()).
  private hurtFlashTimer = 0;
  private static readonly HURT_FLASH_DURATION = 0.2;
  private static readonly HURT_TINT_STRENGTH = 0.75;
  private static readonly HURT_RED = new THREE.Color(1, 0, 0);
  private static readonly hurtTintScratch = new THREE.Color();
  // Death animation (same treatment as MobModel: topple over Z while
  // permanently red-tinted - see startDeath()/updateDeathAnimation()).
  private dying = false;
  private forcedTint = false;
  private deathTimer = 0;
  static readonly DEATH_SPIN_DURATION = 0.75;
  private slimArms = false;
  private bodyYaw = 0;
  private bodyYawInit = false;
  private torsoGroup?: THREE.Group;
  private sneakTarget = 0;
  private sneakAmount = 0;
  /** Extra arm pitch from the current sneak amount; folded in by the arm setters. */
  private armSneakOffset = 0;

  constructor() {
    this.group = new THREE.Group();
    this.buildModel();
    // this.loadTexture(); // Disabled for manual UV mapping
  }

  private async loadTexture() {
    const textureLoader = new THREE.TextureLoader();
    try {
      const texture = await textureLoader.loadAsync(ATLAS_PATH);
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.colorSpace = THREE.SRGBColorSpace;

      console.log('Player texture loaded successfully:', texture);

      const material = new THREE.MeshBasicMaterial({
        map: texture,
        side: THREE.DoubleSide,
      });

      // Apply textured material to all body parts
      this.group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.material = material;
        }
      });

      console.log('Texture material applied to all meshes');
    } catch (error) {
      console.error('Failed to load player texture:', error);
    }
  }

  private buildModel() {
    // Create default materials for fallback
    const skinColor = 0xd4a373; // Skin tone
    const shirtColor = 0x1e5aa8; // Blue shirt
    const pantsColor = 0x2d2d2d; // Dark gray pants
    const bootsColor = 0x1a1a1a; // Black boots

    // Eyes are at y=0 (player.state.position), feet are at y=-1.62 (eye height)
    // Head (0.55 x 0.55 x 0.55) - 10% larger - eyes approximately in upper middle of head
    this.head = new THREE.Mesh(
      this.createHeadGeometry(),
      this.createHeadMaterials(),
    );
    this.head.position.y = 0.02; // Positioned so eyes are near center
    this.head.castShadow = true;
    this.head.receiveShadow = true;

    this.group.add(this.head);
    this.addOverlay(this.head, 0.55, 0.55, 0.55, SKIN_UV_OVERLAY.hat);

    // Torso/Body (0.55 x 0.76 x 0.275) - 10% larger + elongated
    // Torso lives in a pivot group at the neck (y=-0.24) so it can lean forward when sneaking.
    this.torsoGroup = new THREE.Group();
    this.torsoGroup.position.y = -0.24;
    this.group.add(this.torsoGroup);

    this.torso = new THREE.Mesh(
      this.createTorsoGeometry(),
      getAtlasMaterial(),
    );
    this.torso.position.y = -0.38; // torso centre relative to the neck pivot
    this.torso.castShadow = true;
    this.torso.receiveShadow = true;
    this.torsoGroup.add(this.torso);
    this.addOverlay(this.torso, 0.55, 0.76, 0.275, SKIN_UV_OVERLAY.jacket);

    // Left arm - with shoulder joint for rotation
    this.armLeftGroup = new THREE.Group();
    this.armLeftGroup.position.set(-0.4125, -0.24, 0); // Shoulder position (top of arm)
    this.group.add(this.armLeftGroup);
    this.buildArm('left');

    // Right arm - with shoulder joint for rotation
    this.armRightGroup = new THREE.Group();
    this.armRightGroup.position.set(0.4125, -0.24, 0); // Shoulder position (top of arm)
    this.group.add(this.armRightGroup);
    this.buildArm('right');

    // Fist: bottom of the 0.76-tall arm, nudged forward (-Z) out of the palm.
    // Parented to the arm group so the held thing swings with the walk anim.
    this.handAnchor = new THREE.Group();
    this.handAnchor.position.set(0, -0.7, -0.06);
    this.armRightGroup.add(this.handAnchor);

    // Left leg - with hip joint for rotation
    this.legLeftGroup = new THREE.Group();
    this.legLeftGroup.position.set(-0.13875, -0.99, 0); // Hip position (top center of leg)
    this.group.add(this.legLeftGroup);

    this.legLeft = new THREE.Mesh(
      this.createLegGeometry('left'),
      getAtlasMaterial(),
    );
    this.legLeft.position.set(0, -0.38, 0); // Relative to hip (half height down)
    this.legLeft.castShadow = true;
    this.legLeft.receiveShadow = true;
    this.legLeftGroup.add(this.legLeft);
    this.addOverlay(this.legLeft, 0.275, 0.76, 0.275, SKIN_UV_OVERLAY.pantLeft, MIRROR_U);

    // Right leg - with hip joint for rotation
    this.legRightGroup = new THREE.Group();
    this.legRightGroup.position.set(0.13875, -0.99, 0); // Hip position (top center of leg)
    this.group.add(this.legRightGroup);

    this.legRight = new THREE.Mesh(
      this.createLegGeometry('right'),
      getAtlasMaterial(),
    );
    this.legRight.position.set(0, -0.38, 0); // Relative to hip (half height down)
    this.legRight.castShadow = true;
    this.legRight.receiveShadow = true;
    this.legRightGroup.add(this.legRight);
    this.addOverlay(this.legRight, 0.275, 0.76, 0.275, SKIN_UV_OVERLAY.pantRight);

    // Enable flat shading for blocky Minecraft look
    this.group.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.computeVertexNormals();
        if (child.material instanceof THREE.MeshStandardMaterial) {
          child.material.flatShading = true;
        }
      }
    });

    // Model is 1.8 blocks tall (0.5 head + 0.6 torso + 0.6 legs)
    // Positioned so the model's center aligns with player.state.position (eye level)
    // Player position represents eye position (1.62 blocks above feet)
    this.group.position.y = 0; // No offset - position synced directly
  }

  /**
   * Attach an inflated shell box (the "3D"/outer skin layer) as a child of a
   * base part, so it inherits every transform (joint rotation, adjustments).
   * Uses the transparent overlay material (test.png).
   */
  private addOverlay(base: THREE.Mesh, w: number, h: number, d: number, rects: FaceRects, flips?: FaceFlips) {
    const geo = new THREE.BoxGeometry(w + INFLATE_WD, h + INFLATE_H, d + INFLATE_WD);
    applyAtlasUVs(geo, rects, flips ?? {});
    applyFaceShading(geo);
    const shell = new THREE.Mesh(geo, getOverlayMaterial());
    shell.castShadow = true;
    base.add(shell);
  }

  /** Head uses the shared skin atlas, same material as the rest of the body. */
  private createHeadMaterials(): THREE.Material {
    return getAtlasMaterial();
  }

  /**
   * Head geometry, UV-mapped to the atlas (textures/player.png).
   * 'nz' is the front (the face), which points along the look arrow.
   * Pixel rects are [x0, y0, x1, y1] inclusive.
   */
  private createHeadGeometry(): THREE.BoxGeometry {
    const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
    applyAtlasUVs(geo, SKIN_UV.head);
    applyFaceShading(geo);
    return geo;
  }

  /** Torso geometry, UV-mapped to the atlas (MCPE body region). */
  private createTorsoGeometry(): THREE.BoxGeometry {
    const geo = new THREE.BoxGeometry(0.55, 0.76, 0.275);
    applyAtlasUVs(geo, SKIN_UV.torso);
    applyFaceShading(geo);
    return geo;
  }

  /** Arm geometry. Left arm mirrors the MCPE arm1 region; slim = "Alex" (3 px wide). */
  private createArmGeometry(side: 'left' | 'right', slim: boolean): THREE.BoxGeometry {
    return buildArmGeometry(side, slim);
  }

  /** (Re)build one arm mesh + its 3D overlay for the current slim/classic setting. */
  private buildArm(side: 'left' | 'right') {
    const group = side === 'left' ? this.armLeftGroup : this.armRightGroup;
    if (!group) return;

    const old = side === 'left' ? this.armLeft : this.armRight;
    if (old) {
      group.remove(old);
      old.traverse((c) => { if (c instanceof THREE.Mesh) c.geometry.dispose(); });
    }

    const mesh = new THREE.Mesh(this.createArmGeometry(side, this.slimArms), getAtlasMaterial());
    // Keep the inner edge (toward the torso) attached when slim.
    const inset = this.slimArms ? (side === 'left' ? ARM_SLIM_INSET : -ARM_SLIM_INSET) : 0;
    mesh.position.set(inset, -0.38, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    const width = this.slimArms ? ARM_WIDTH_SLIM : ARM_WIDTH;
    const overlayRects = side === 'left'
      ? (this.slimArms ? SKIN_UV_OVERLAY_SLIM.sleeveLeft : SKIN_UV_OVERLAY.sleeveLeft)
      : (this.slimArms ? SKIN_UV_OVERLAY_SLIM.sleeveRight : SKIN_UV_OVERLAY.sleeveRight);
    this.addOverlay(mesh, width, 0.76, 0.275, overlayRects, side === 'left' ? MIRROR_U : undefined);

    if (side === 'left') this.armLeft = mesh; else this.armRight = mesh;
  }

  /** Toggle slim ("Alex") arms. Rebuilds both arm meshes. */
  setSlimArms(slim: boolean) {
    if (this.slimArms === slim) return;
    this.slimArms = slim;
    this.buildArm('left');
    this.buildArm('right');
  }

  /** Leg geometry. Left leg uses the mirrored MCPE leg1 region. */
  private createLegGeometry(side: 'left' | 'right'): THREE.BoxGeometry {
    const geo = new THREE.BoxGeometry(0.275, 0.76, 0.275);
    if (side === 'right') {
      applyAtlasUVs(geo, SKIN_UV.legRight);
    } else {
      applyAtlasUVs(geo, SKIN_UV.legLeft, MIRROR_U);
    }
    applyFaceShading(geo);
    return geo;
  }

  /**
   * Get the group for adding to scene.
   */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Apply position adjustments to model parts.
   */
  setAdjustments(adjustments: ModelAdjustments) {
    const s = this.sneakAmount;
    if (this.head) {
      this.head.position.x = adjustments.head.x;
      this.head.position.y = 0.02 + adjustments.head.y + SNEAK_HEAD_DY * s;
      this.head.position.z = adjustments.head.z + SNEAK_HEAD_DZ * s;
    }
    // Whole-body crouch shift (head excluded).
    const bodyDy = SNEAK_BODY_DY * s;
    const bodyDz = SNEAK_BODY_DZ * s;
    if (this.torsoGroup) {
      this.torsoGroup.position.x = adjustments.torso.x;
      this.torsoGroup.position.y = -0.24 + adjustments.torso.y + bodyDy;
      this.torsoGroup.position.z = adjustments.torso.z + bodyDz;
    }
    if (this.armLeftGroup) {
      this.armLeftGroup.position.x = -0.4125 + adjustments.armLeft.x;
      this.armLeftGroup.position.y = -0.24 + adjustments.armLeft.y + bodyDy;
      this.armLeftGroup.position.z = adjustments.armLeft.z + bodyDz;
    }
    if (this.armRightGroup) {
      this.armRightGroup.position.x = 0.4125 + adjustments.armRight.x;
      this.armRightGroup.position.y = -0.24 + adjustments.armRight.y + bodyDy;
      this.armRightGroup.position.z = adjustments.armRight.z + bodyDz;
    }
    // Follow the torso's bottom edge as it swings on the neck pivot, so the hips
    // stay glued to the torso instead of tearing away.
    const theta = SNEAK_TORSO_PITCH * s;
    const hipDy = TORSO_LEN * (1 - Math.cos(theta)); // rises slightly
    const hipDz = -TORSO_LEN * Math.sin(theta);      // moves forward (-Z)
    if (this.legLeftGroup) {
      this.legLeftGroup.position.x = -0.13875 + adjustments.legs.x;
      this.legLeftGroup.position.y = -0.99 + adjustments.legs.y + hipDy + bodyDy;
      this.legLeftGroup.position.z = adjustments.legs.z + hipDz + bodyDz;
    }
    if (this.legRightGroup) {
      this.legRightGroup.position.x = 0.13875 + adjustments.legs.x;
      this.legRightGroup.position.y = -0.99 + adjustments.legs.y + hipDy + bodyDy;
      this.legRightGroup.position.z = adjustments.legs.z + hipDz + bodyDz;
    }
  }

  /**
   * Rotate left arm on X axis (angle in radians, positive = forward swing).
   */
  setLeftArmRotation(angle: number) {
    this.armLeftRotation = angle;
    if (this.armLeftGroup) {
      this.armLeftGroup.rotation.x = angle + this.armSneakOffset;
    } else {
      console.error('armLeftGroup is null/undefined!');
    }
  }

  /**
   * Get left arm rotation angle.
   */
  getLeftArmRotation(): number {
    return this.armLeftRotation;
  }

  /**
   * Rotate right arm on X axis (angle in radians, positive = backward swing).
   */
  setRightArmRotation(angle: number) {
    this.armRightRotation = angle;
    if (this.armRightGroup) {
      this.armRightGroup.rotation.x = angle + this.armSneakOffset;
    }
  }

  /**
   * Get right arm rotation angle.
   */
  getRightArmRotation(): number {
    return this.armRightRotation;
  }

  /**
   * Rotate left leg on X axis (angle in radians, opposite of left arm).
   */
  setLeftLegRotation(angle: number) {
    this.legLeftRotation = angle;
    if (this.legLeftGroup) {
      this.legLeftGroup.rotation.x = angle;
    }
  }

  /**
   * Rotate right leg on X axis (angle in radians, opposite of right arm).
   */
  setRightLegRotation(angle: number) {
    this.legRightRotation = angle;
    if (this.legRightGroup) {
      this.legRightGroup.rotation.x = angle;
    }
  }

  /**
   * Start walking animation.
   */
  startWalking() {
    if (!this.isWalking) {
      this.walkCycleTime = 0;
    }
    this.isWalking = true;
  }

  /**
   * Stop walking animation, smoothly return to idle pose.
   */
  stopWalking() {
    if (this.isWalking) {
      this.isWalking = false;
      this.isReturning = true;
      this.returnStartTime = 0;
      this.returnStartAngleLeft = this.armLeftRotation;
      this.returnStartAngleRight = this.armRightRotation;
      this.returnStartLegAngleLeft = this.legLeftRotation;
      this.returnStartLegAngleRight = this.legRightRotation;
    }
  }

  /** Start (or restart) the third-person attack/mine swing overlay. */
  swingArm(): void {
    this.swingTime = 0;
    this.swinging = true;
  }

  /** Advances the swing timer and returns this frame's overlay angle for the right arm (0 when not swinging). */
  private updateSwing(deltaTime: number): number {
    if (!this.swinging) return 0;
    this.swingTime += deltaTime;
    if (this.swingTime >= this.SWING_DURATION) {
      this.swinging = false;
      return 0;
    }
    const t = this.swingTime / this.SWING_DURATION;
    // Single forward-and-back arc. setRightArmRotation's own doc comment
    // claims positive = backward, but that reads backward in practice (the
    // negative sign this used to have threw the arm behind the body instead
    // of forward into the swing) - positive is what actually swings forward.
    return Math.sin(t * Math.PI) * this.SWING_ARC;
  }

  /**
   * Update walking animation (call every frame with delta time in seconds).
   */
  updateWalkingAnimation(deltaTime: number) {
    const swingOffset = this.updateSwing(deltaTime);

    // Handle return to idle pose
    if (this.isReturning) {
      this.returnStartTime += deltaTime;
      const returnProgress = Math.min(this.returnStartTime / this.RETURN_DURATION, 1);

      // Smooth interpolation from current angles to 0
      const leftArmAngle = this.returnStartAngleLeft * (1 - returnProgress);
      const rightArmAngle = this.returnStartAngleRight * (1 - returnProgress);
      const leftLegAngle = this.returnStartLegAngleLeft * (1 - returnProgress);
      const rightLegAngle = this.returnStartLegAngleRight * (1 - returnProgress);

      this.setLeftArmRotation(leftArmAngle);
      this.setRightArmRotation(rightArmAngle + swingOffset);
      this.setLeftLegRotation(leftLegAngle);
      this.setRightLegRotation(rightLegAngle);

      if (returnProgress >= 1) {
        this.isReturning = false;
      }
      return;
    }

    if (!this.isWalking) {
      // Fully idle: the swing overlay still needs to play (and to reset the
      // arm to exactly 0 for one extra frame once it finishes, since the arc
      // only asymptotically nears 0 rather than landing on it exactly).
      if (swingOffset !== 0 || this.armRightRotation !== 0) this.setRightArmRotation(swingOffset);
      return;
    }

    this.walkCycleTime += deltaTime;
    if (this.walkCycleTime >= this.WALK_CYCLE_DURATION) {
      this.walkCycleTime -= this.WALK_CYCLE_DURATION;
    }

    const cycleProgress = this.walkCycleTime / this.WALK_CYCLE_DURATION;

    // Left arm animation (rotating around shoulder on Y axis):
    // 0.0-0.25: 0° to 45° (forward swing)
    // 0.25-0.5: 45° to 0° (returns)
    // 0.5-0.75: 0° to -45° (backward swing)
    // 0.75-1.0: -45° to 0° (returns)

    let leftArmAngle = 0;

    if (cycleProgress < 0.25) {
      // 0-0.5s: 0° -> 45°
      leftArmAngle = (Math.PI / 4) * (cycleProgress / 0.25);
    } else if (cycleProgress < 0.5) {
      // 0.5-1.0s: 45° -> 0°
      leftArmAngle = (Math.PI / 4) * (1 - (cycleProgress - 0.25) / 0.25);
    } else if (cycleProgress < 0.75) {
      // 1.0-1.5s: 0° -> -45°
      leftArmAngle = -(Math.PI / 4) * ((cycleProgress - 0.5) / 0.25);
    } else {
      // 1.5-2.0s: -45° -> 0°
      leftArmAngle = -(Math.PI / 4) * (1 - (cycleProgress - 0.75) / 0.25);
    }

    // Right arm animation: opposite of left
    let rightArmAngle = 0;

    if (cycleProgress < 0.25) {
      // 0-0.5s: 0° -> -45°
      rightArmAngle = -(Math.PI / 4) * (cycleProgress / 0.25);
    } else if (cycleProgress < 0.5) {
      // 0.5-1.0s: -45° -> 0°
      rightArmAngle = -(Math.PI / 4) * (1 - (cycleProgress - 0.25) / 0.25);
    } else if (cycleProgress < 0.75) {
      // 1.0-1.5s: 0° -> 45°
      rightArmAngle = (Math.PI / 4) * ((cycleProgress - 0.5) / 0.25);
    } else {
      // 1.5-2.0s: 45° -> 0°
      rightArmAngle = (Math.PI / 4) * (1 - (cycleProgress - 0.75) / 0.25);
    }

    // Legs animate opposite to arms: when left arm goes forward, left leg goes back
    let leftLegAngle = -leftArmAngle;
    let rightLegAngle = -rightArmAngle;

    this.setLeftArmRotation(leftArmAngle);
    this.setRightArmRotation(rightArmAngle + swingOffset);
    this.setLeftLegRotation(leftLegAngle);
    this.setRightLegRotation(rightLegAngle);
  }

  /**
   * Orient the model to a fixed yaw and reset the head to neutral.
   * Used by free camera mode, where the player itself never rotates.
   */
  faceYaw(yaw: number) {
    this.group.rotation.y = yaw;
    this.bodyYaw = yaw;
    this.bodyYawInit = true;
    if (this.head) {
      this.head.rotation.set(0, 0, 0);
    }
  }

  /**
   * Directly pose the model for the inventory doll — no easing, no head clamp
   * (LCE UIControl_MinecraftPlayer). `headYawLocal` is relative to the body.
   */
  setInventoryPose(bodyYaw: number, headYawLocal: number, headPitch: number) {
    this.group.rotation.y = bodyYaw;
    this.bodyYaw = bodyYaw;
    this.bodyYawInit = true;
    if (this.head) {
      this.head.rotation.order = 'YXZ';
      this.head.rotation.y = headYawLocal;
      this.head.rotation.x = headPitch;
    }
  }

  /**
   * Minecraft-style body/head rotation (port of Mob::tick + MobRenderer):
   * the body eases toward the movement direction with lag, the head points where
   * the player looks, and the head is clamped to +/-75 deg from the body.
   */
  setOrientation(lookYaw: number, lookPitch: number, velX: number, velZ: number, delta: number) {
    if (!this.bodyYawInit) {
      this.bodyYaw = lookYaw;
      this.bodyYawInit = true;
    }

    // Body target: movement direction when moving, otherwise hold.
    let bodyTarget = this.bodyYaw;
    if (velX * velX + velZ * velZ > 0.0025) {
      bodyTarget = Math.atan2(-velX, -velZ); // model forward is -Z
    }

    // Ease toward target. MC uses 0.3 per 50 ms tick -> lambda ~= 7.1.
    this.bodyYaw += wrapAngle(bodyTarget - this.bodyYaw) * (1 - Math.exp(-7.1 * delta));

    // Head/body coupling: head is limited to +/-75 deg of the body.
    const CLAMP = (75 * Math.PI) / 180;
    const EXTRA = (50 * Math.PI) / 180;
    let headDiff = wrapAngle(lookYaw - this.bodyYaw);
    headDiff = THREE.MathUtils.clamp(headDiff, -CLAMP, CLAMP);
    this.bodyYaw = lookYaw - headDiff;
    if (headDiff * headDiff > EXTRA * EXTRA) {
      // Extra catch-up while the head is turned far (MC: += headDiff * 0.2/tick).
      this.bodyYaw += headDiff * (1 - Math.exp(-4.5 * delta));
    }

    this.group.rotation.y = this.bodyYaw;
    if (this.head) {
      this.head.rotation.order = 'YXZ';
      // LCE HumanoidModel::setupAnim: head.yRot = headYaw - bodyYaw, head.xRot = pitch.
      // Sign check (same property the inventory doll drives): head.rotation.x < 0
      // tips the face DOWN, and `state.pitch` is negative when looking down, so
      // the raw look pitch passes straight through.
      this.head.rotation.y = wrapAngle(lookYaw - this.bodyYaw);
      this.head.rotation.x = lookPitch;
    }
  }

  /**
   * Show the selected hotbar block/item in the model's right fist, for the
   * third-person views (LCE PlayerRenderer renders the held stack at the hand).
   * `null` empties the hand.
   */
  setHeldItem(id: number | null) {
    if (id === this.heldId || !this.handAnchor) return;
    this.heldId = id;

    if (this.heldMesh) {
      this.handAnchor.remove(this.heldMesh);
      disposeBlockMesh(this.heldMesh);
      this.heldMesh = undefined;
    }
    if (id == null) return;

    if (id === BlockId.TORCH) {
      // Not a cube in the world - hold it like an item (pixel-extruded), but
      // upright (no tool-style Y-flip/roll: the flame has to stay pointing up).
      const mesh = buildItemMesh('blocks/torch.png');
      mesh.scale.setScalar(0.8);
      mesh.position.set(0, 0.05, -0.12);
      mesh.rotation.set(-10 * (Math.PI / 180), Math.PI / 2, 0);
      this.heldMesh = mesh;
    } else if (isBlock(id)) {
      const slot = BLOCK_CATALOG.find((b) => b.id === id);
      if (!slot) return;
      const mesh = buildBlockMesh(slot);
      // buildBlockMesh is a 1.5-unit cube; the model is ~1 unit per block, and
      // LCE holds roughly a 0.4-block cube in the fist.
      mesh.scale.setScalar(0.27);
      mesh.position.set(0, -0.12, -0.1);
      this.heldMesh = mesh;
    } else if (ITEMS[id]) {
      const mesh = buildItemMesh(ITEMS[id].texture);
      // Negative Y scale mirrors the sprite vertically (a flip, not a spin), so
      // the working end (axe blade, pick head) points DOWN out of the fist
      // without the texture also swapping left-to-right.
      mesh.scale.set(0.72, -0.72, 0.72);
      mesh.position.set(0, 0.10, -0.18);
      // Edge-on to the arm (normal along its side) and tipped forward, like LCE.
      // Z is the sprite's own in-plane roll: -40 - 80 - 180 deg, clockwise.
      mesh.rotation.set(-15 * (Math.PI / 180), Math.PI / 2, -300 * (Math.PI / 180));
      this.heldMesh = mesh;
    }
    if (this.heldMesh) {
      this.handAnchor.add(this.heldMesh);
      tintByLight(this.heldMesh, this.lightLevel);
    }
  }

  /**
   * Toggle visibility (only visible in 3rd person).
   */
  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  /** Target the crouch pose (MCPE-style: torso leans, arms lift, legs tuck back). */
  setSneaking(sneaking: boolean) {
    this.sneakTarget = sneaking ? 1 : 0;
  }

  /**
   * Advance the sneak pose toward its target. Call every frame BEFORE
   * setAdjustments and updateWalkingAnimation so the offsets compose.
   */
  updateSneak(deltaTime: number) {
    this.sneakAmount = THREE.MathUtils.damp(this.sneakAmount, this.sneakTarget, SNEAK_DAMP, deltaTime);
    if (Math.abs(this.sneakAmount - this.sneakTarget) < 0.001) this.sneakAmount = this.sneakTarget;

    this.armSneakOffset = SNEAK_ARM_PITCH * this.sneakAmount;
    // Re-apply so the offset shows even while idle (walk anim would otherwise not run).
    this.setLeftArmRotation(this.armLeftRotation);
    this.setRightArmRotation(this.armRightRotation);

    if (this.torsoGroup) {
      this.torsoGroup.rotation.x = SNEAK_TORSO_PITCH * this.sneakAmount;
    }
  }

  /** Flash red for HURT_FLASH_DURATION - call when the player takes damage. */
  hurt(): void {
    this.hurtFlashTimer = PlayerModel.HURT_FLASH_DURATION;
  }

  /** Starts the death animation (same treatment as MobModel): topple over Z while staying red-tinted. Call once, the instant the player dies. */
  startDeath(): void {
    this.dying = true;
    this.forcedTint = true;
    this.deathTimer = 0;
  }

  /** Advances the death topple; call every frame instead of updateWalkingAnimation while dying. Returns true once the topple has finished. */
  updateDeathAnimation(delta: number): boolean {
    if (!this.dying) return false;
    this.deathTimer = Math.min(this.deathTimer + delta, PlayerModel.DEATH_SPIN_DURATION);
    this.group.rotation.z = (Math.PI / 2) * (this.deathTimer / PlayerModel.DEATH_SPIN_DURATION);
    return this.deathTimer >= PlayerModel.DEATH_SPIN_DURATION;
  }

  /** Undoes startDeath() - call on respawn. */
  resetDeath(): void {
    this.dying = false;
    this.forcedTint = false;
    this.deathTimer = 0;
    this.group.rotation.z = 0;
    this.setVisible(true);
  }

  /**
   * Tint the whole model by the world light level at its position (0..1),
   * matching the terrain shading curve. Combines with the baked face shading.
   * `delta` (seconds since last call) decays a pending hurt() flash - pass 0
   * (the default) for a call that shouldn't advance it, e.g. the inventory
   * doll forcing itself back to full brightness on the same shared material.
   */
  setLightLevel(level01: number, delta = 0) {
    if (this.hurtFlashTimer > 0) this.hurtFlashTimer = Math.max(0, this.hurtFlashTimer - delta);

    const b = Math.pow(THREE.MathUtils.clamp(level01, 0, 1), 1.25);
    const atlas = getAtlasMaterial();
    const overlay = getOverlayMaterial();
    if (this.hurtFlashTimer > 0 || this.forcedTint) {
      // Non-emissive: tint the lit base colour toward red instead of
      // overriding it outright, so the flash still darkens in shade.
      PlayerModel.hurtTintScratch.setScalar(b).lerp(PlayerModel.HURT_RED, PlayerModel.HURT_TINT_STRENGTH);
      atlas.color.copy(PlayerModel.hurtTintScratch);
      overlay.color.copy(PlayerModel.hurtTintScratch);
    } else {
      atlas.color.setScalar(b);
      overlay.color.setScalar(b);
    }
    this.lightLevel = level01;
    if (this.heldMesh) tintByLight(this.heldMesh, level01);
  }

  /**
   * Get model dimensions for reference.
   */
  static getDimensions() {
    return {
      head: { w: 0.5, h: 0.5, d: 0.5 },
      torso: { w: 0.5, h: 0.75, d: 0.25 },
      arms: { w: 0.25, h: 0.75, d: 0.25 },
      legs: { w: 0.25, h: 0.75, d: 0.25 },
      totalHeight: 2,
      hitbox: { width: 0.6, height: 1.8 },
    };
  }
}

import * as THREE from 'three';
import {
  type FaceRects, type FaceFlips, MIRROR_U, applyAtlasUVs as applyAtlasUVsRaw, applyFaceShading,
} from './atlas-box';

// --- Shared skin atlas (textures/player.png, a 64x64 Minecraft skin) ---
export const ATLAS_PATH = new URL('../textures/player.png', import.meta.url).href;
const ATLAS_W = 64;
const ATLAS_H = 64;

/**
 * One material with the atlas map, shared by every body part.
 * Unlit (MeshBasicMaterial) so the skin reads at full brightness, like the
 * previous textured head — MeshStandardMaterial rendered it near-black.
 */
let sharedAtlasMaterial: THREE.MeshBasicMaterial | null = null;
export function getAtlasMaterial(): THREE.MeshBasicMaterial {
  if (sharedAtlasMaterial) return sharedAtlasMaterial;
  const texture = new THREE.TextureLoader().load(ATLAS_PATH);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  sharedAtlasMaterial = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true });
  return sharedAtlasMaterial;
}

// --- Outer "3D" layer (hat / jacket / sleeves / pants). Same atlas as the base. ---
// MCPE inflates the shell box by g=0.5 px per side. In EvlyMC units that is
// ~0.069 blocks on width/depth and ~0.063 on height (px->block ratio differs per axis).
const INFLATE_WD = 0.069;
const INFLATE_H = 0.063;

let overlayMaterial: THREE.MeshBasicMaterial | null = null;
export function getOverlayMaterial(): THREE.MeshBasicMaterial {
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

/** player.png-bound wrapper: applyAtlasUVsRaw() (atlas-box.ts) needs the atlas
 *  size explicitly since it's shared with mobs, which use a different one. */
export function applyAtlasUVs(geo: THREE.BoxGeometry, rects: FaceRects, flips: FaceFlips = {}) {
  applyAtlasUVsRaw(geo, rects, ATLAS_W, ATLAS_H, flips);
}

/** The shared player-skin atlas material (vertex-colour shaded, nearest-filtered). */
export function getSkinAtlasMaterial(): THREE.MeshBasicMaterial {
  return getAtlasMaterial();
}

/**
 * Atlas pixel rects per body part, derived from MCPE 0.6.1 (loro/src/client/model:
 * HumanoidModel.cpp texOffs + Cube.cpp face formula), 64x64 skin layout.
 * Keys are EvlyMC cube faces; the model faces -Z so nz = MCPE "Front".
 */
export const SKIN_UV = {
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
export const SKIN_UV_OVERLAY = {
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
export const ARM_WIDTH = 0.275;
export const ARM_WIDTH_SLIM = 0.20625; // 3/4 of classic
// Keep the inner edge (toward the torso) fixed when switching to slim.
export const ARM_SLIM_INSET = (ARM_WIDTH - ARM_WIDTH_SLIM) / 2;

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

export const SKIN_UV_OVERLAY_SLIM = {
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

/** Head geometry, UV-mapped to the atlas (textures/player.png). 'nz' is the front (the face). */
export function createHeadGeometry(): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(0.55, 0.55, 0.55);
  applyAtlasUVs(geo, SKIN_UV.head);
  applyFaceShading(geo);
  return geo;
}

/** Torso geometry, UV-mapped to the atlas (MCPE body region). */
export function createTorsoGeometry(): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(0.55, 0.76, 0.275);
  applyAtlasUVs(geo, SKIN_UV.torso);
  applyFaceShading(geo);
  return geo;
}

/** Leg geometry. Left leg uses the mirrored MCPE leg1 region. */
export function createLegGeometry(side: 'left' | 'right'): THREE.BoxGeometry {
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
 * Attach an inflated shell box (the "3D"/outer skin layer) as a child of a
 * base part, so it inherits every transform (joint rotation, adjustments).
 * Uses the transparent overlay material.
 */
export function addOverlay(base: THREE.Mesh, w: number, h: number, d: number, rects: FaceRects, flips?: FaceFlips) {
  const geo = new THREE.BoxGeometry(w + INFLATE_WD, h + INFLATE_H, d + INFLATE_WD);
  applyAtlasUVs(geo, rects, flips ?? {});
  applyFaceShading(geo);
  const shell = new THREE.Mesh(geo, getOverlayMaterial());
  shell.castShadow = true;
  base.add(shell);
}

/**
 * (Re)builds one arm mesh + its 3D overlay for the given slim/classic
 * setting, disposing `previous` first if given (slim-arm toggle rebuild).
 * Adds the new mesh to `group` and returns it.
 */
export function buildArmMesh(group: THREE.Group, side: 'left' | 'right', slim: boolean, previous?: THREE.Mesh): THREE.Mesh {
  if (previous) {
    group.remove(previous);
    previous.traverse((c) => { if (c instanceof THREE.Mesh) c.geometry.dispose(); });
  }

  const mesh = new THREE.Mesh(buildArmGeometry(side, slim), getAtlasMaterial());
  // Keep the inner edge (toward the torso) attached when slim.
  const inset = slim ? (side === 'left' ? ARM_SLIM_INSET : -ARM_SLIM_INSET) : 0;
  mesh.position.set(inset, -0.38, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  const width = slim ? ARM_WIDTH_SLIM : ARM_WIDTH;
  const overlayRects = side === 'left'
    ? (slim ? SKIN_UV_OVERLAY_SLIM.sleeveLeft : SKIN_UV_OVERLAY.sleeveLeft)
    : (slim ? SKIN_UV_OVERLAY_SLIM.sleeveRight : SKIN_UV_OVERLAY.sleeveRight);
  addOverlay(mesh, width, 0.76, 0.275, overlayRects, side === 'left' ? MIRROR_U : undefined);

  return mesh;
}

export type PlayerModelParts = {
  head: THREE.Mesh;
  torsoGroup: THREE.Group;
  torso: THREE.Mesh;
  armLeftGroup: THREE.Group;
  armRightGroup: THREE.Group;
  handAnchor: THREE.Group;
  legLeftGroup: THREE.Group;
  legLeft: THREE.Mesh;
  legRightGroup: THREE.Group;
  legRight: THREE.Mesh;
};

/**
 * Builds the whole static body hierarchy (head/torso/arm groups/leg groups,
 * each with its "3D" overlay shell already attached) as children of `group`,
 * and returns every part PlayerModel needs to keep a handle on (to animate,
 * swap held items, etc). Arms are built separately by the caller via
 * buildArmMesh() (it needs to be re-run on a slim-arm toggle), everything
 * else here is built once and never rebuilt.
 */
export function buildPlayerModelParts(group: THREE.Group): PlayerModelParts {
  // Eyes are at y=0 (player.state.position), feet are at y=-1.62 (eye height)
  // Head (0.55 x 0.55 x 0.55) - 10% larger - eyes approximately in upper middle of head
  const head = new THREE.Mesh(createHeadGeometry(), getAtlasMaterial());
  head.position.y = 0.02; // Positioned so eyes are near center
  head.castShadow = true;
  head.receiveShadow = true;
  group.add(head);
  addOverlay(head, 0.55, 0.55, 0.55, SKIN_UV_OVERLAY.hat);

  // Torso/Body (0.55 x 0.76 x 0.275) - 10% larger + elongated
  // Torso lives in a pivot group at the neck (y=-0.24) so it can lean forward when sneaking.
  const torsoGroup = new THREE.Group();
  torsoGroup.position.y = -0.24;
  group.add(torsoGroup);

  const torso = new THREE.Mesh(createTorsoGeometry(), getAtlasMaterial());
  torso.position.y = -0.38; // torso centre relative to the neck pivot
  torso.castShadow = true;
  torso.receiveShadow = true;
  torsoGroup.add(torso);
  addOverlay(torso, 0.55, 0.76, 0.275, SKIN_UV_OVERLAY.jacket);

  // Left arm - with shoulder joint for rotation
  const armLeftGroup = new THREE.Group();
  armLeftGroup.position.set(-0.4125, -0.24, 0); // Shoulder position (top of arm)
  group.add(armLeftGroup);

  // Right arm - with shoulder joint for rotation
  const armRightGroup = new THREE.Group();
  armRightGroup.position.set(0.4125, -0.24, 0); // Shoulder position (top of arm)
  group.add(armRightGroup);

  // Fist: bottom of the 0.76-tall arm, nudged forward (-Z) out of the palm.
  // Parented to the arm group so the held thing swings with the walk anim.
  const handAnchor = new THREE.Group();
  handAnchor.position.set(0, -0.7, -0.06);
  armRightGroup.add(handAnchor);

  // Left leg - with hip joint for rotation
  const legLeftGroup = new THREE.Group();
  legLeftGroup.position.set(-0.13875, -0.99, 0); // Hip position (top center of leg)
  group.add(legLeftGroup);

  const legLeft = new THREE.Mesh(createLegGeometry('left'), getAtlasMaterial());
  legLeft.position.set(0, -0.38, 0); // Relative to hip (half height down)
  legLeft.castShadow = true;
  legLeft.receiveShadow = true;
  legLeftGroup.add(legLeft);
  addOverlay(legLeft, 0.275, 0.76, 0.275, SKIN_UV_OVERLAY.pantLeft, MIRROR_U);

  // Right leg - with hip joint for rotation
  const legRightGroup = new THREE.Group();
  legRightGroup.position.set(0.13875, -0.99, 0); // Hip position (top center of leg)
  group.add(legRightGroup);

  const legRight = new THREE.Mesh(createLegGeometry('right'), getAtlasMaterial());
  legRight.position.set(0, -0.38, 0); // Relative to hip (half height down)
  legRight.castShadow = true;
  legRight.receiveShadow = true;
  legRightGroup.add(legRight);
  addOverlay(legRight, 0.275, 0.76, 0.275, SKIN_UV_OVERLAY.pantRight);

  // Enable flat shading for blocky Minecraft look
  group.traverse((child) => {
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
  group.position.y = 0; // No offset - position synced directly

  return { head, torsoGroup, torso, armLeftGroup, armRightGroup, handAnchor, legLeftGroup, legLeft, legRightGroup, legRight };
}

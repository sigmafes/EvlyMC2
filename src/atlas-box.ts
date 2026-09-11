import * as THREE from 'three';

/**
 * Shared box/UV/shading utilities for building blocky humanoid/mob meshes
 * from a Minecraft-style skin atlas. Extracted from player-model.ts (which
 * still owns the actual player rig) so a future mob model builder can reuse
 * the same UV-mapping and face-shading math instead of re-deriving it.
 */

// BoxGeometry assigns faces in this order. Forward (look arrow) is local -Z = 'nz'.
export type FaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
export const FACE_ORDER: FaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/** Pixel rect in the atlas, inclusive, top-left origin: [x0, y0, x1, y1]. */
export type PixelRect = [number, number, number, number];
export type FaceRects = Partial<Record<FaceKey, PixelRect>>;
export type FaceFlips = Partial<Record<FaceKey, { u?: boolean; v?: boolean }>>;

/** Flip U on every face - for a mirrored part (MCPE's left arm/leg, or any other left/right pair). */
export const MIRROR_U: FaceFlips = {
  px: { u: true }, nx: { u: true }, py: { u: true },
  ny: { u: true }, pz: { u: true }, nz: { u: true },
};

/**
 * Map each cube face to a pixel rectangle of an `atlasW x atlasH` atlas
 * texture. "8, 8 > 15, 15" means x0=8, y0=8, x1=15, y1=15 (an 8x8 patch,
 * edges inclusive).
 */
export function applyAtlasUVs(
  geo: THREE.BoxGeometry,
  rects: FaceRects,
  atlasW: number,
  atlasH: number,
  flips: FaceFlips = {},
) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const arr = uv.array as Float32Array;

  FACE_ORDER.forEach((key, face) => {
    const rect = rects[key];
    if (!rect) return;
    const [x0, y0, x1, y1] = rect;
    let uMin = x0 / atlasW;
    let uMax = (x1 + 1) / atlasW;
    let vMax = 1 - y0 / atlasH;       // top edge of the patch
    let vMin = 1 - (y1 + 1) / atlasH; // bottom edge of the patch

    const flip = flips[key] ?? {};
    if (flip.u) [uMin, uMax] = [uMax, uMin];
    if (flip.v) [vMin, vMax] = [vMax, vMin];

    // BoxGeometry per-face vertex order: (uMin,vMax) (uMax,vMax) (uMin,vMin) (uMax,vMin)
    const o = face * 8;
    arr[o] = uMin;     arr[o + 1] = vMax;
    arr[o + 2] = uMax; arr[o + 3] = vMax;
    arr[o + 4] = uMin; arr[o + 5] = vMin;
    arr[o + 6] = uMax; arr[o + 7] = vMin;
  });

  uv.needsUpdate = true;
}

/**
 * Per-face brightness, matching the terrain mesher's directionFactor
 * (mesher.ts getFaceBrightness). Face order: +X, -X, +Y, -Y, +Z, -Z.
 * Baked into a vertex-color attribute so the model reads as 3D without any lights.
 */
export const FACE_SHADE = [0.8, 0.6, 1.0, 0.5, 0.8, 0.6];

export function applyFaceShading(geo: THREE.BoxGeometry) {
  const count = geo.getAttribute('position').count; // 24 (4 verts * 6 faces)
  const colors = new Float32Array(count * 3);
  for (let face = 0; face < 6; face++) {
    const s = FACE_SHADE[face];
    for (let v = 0; v < 4; v++) {
      const o = (face * 4 + v) * 3;
      colors[o] = s; colors[o + 1] = s; colors[o + 2] = s;
    }
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

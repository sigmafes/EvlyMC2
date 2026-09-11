import * as THREE from 'three';

/** Inclusive pixel rect within an atlas image: [x0, y0, x1, y1]. */
export type PixelRect = [number, number, number, number];

export type Atlas = {
  /** Raw composited image, for 2D canvas consumers (inventory icons) to crop from directly. */
  canvas: HTMLCanvasElement;
  /** Shared GPU texture for 3D consumers (world mesh, dropped items, held items, particles). */
  texture: THREE.Texture;
  /** Pixel rect (inclusive) of each entry's tile within the atlas, keyed by the same `key` passed in. */
  rects: Map<string, PixelRect>;
  atlasWidth: number;
  atlasHeight: number;
};

/**
 * Packs a set of same-size PNGs into one fixed-grid texture atlas. No
 * bin-packing needed - every EvlyMC block/item texture is a uniform 16x16px
 * tile, so a plain grid (`cols` x `rows`) always fits. Async because
 * compositing onto the shared canvas needs every source image decoded first
 * - callers await this once at startup, same spot `createBlockMaterials()`
 * already runs from.
 */
export async function buildAtlas(
  entries: { key: string; url: string }[],
  cols: number,
  rows: number,
  tileSize = 16,
): Promise<Atlas> {
  const atlasWidth = cols * tileSize;
  const atlasHeight = rows * tileSize;
  if (entries.length > cols * rows) {
    throw new Error(`buildAtlas: ${entries.length} entries don't fit a ${cols}x${rows} grid`);
  }

  const images = await Promise.all(
    entries.map(
      ({ url }) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error(`buildAtlas: failed to load ${url}`));
          img.src = url;
        }),
    ),
  );

  const canvas = document.createElement('canvas');
  canvas.width = atlasWidth;
  canvas.height = atlasHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false; // pixel art - no blending between tiles while compositing

  const rects = new Map<string, PixelRect>();
  entries.forEach(({ key }, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = col * tileSize;
    const y0 = row * tileSize;
    ctx.drawImage(images[i], x0, y0, tileSize, tileSize);
    rects.set(key, [x0, y0, x0 + tileSize - 1, y0 + tileSize - 1]);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return { canvas, texture, rects, atlasWidth, atlasHeight };
}

// Tiles are packed edge-to-edge with no gap between them, so a UV that
// samples exactly on a tile's boundary can land on the neighbouring tile's
// edge texel instead - not from filtering (everything's NearestFilter, no
// mipmaps), but from ordinary perspective-correct interpolation across a
// face plus the renderer's own antialiasing landing a hair past the edge.
// Insetting the sampled rect by half a texel keeps every sample a full texel
// away from the next tile - imperceptible on a 16px tile, and it fixes the
// seam without needing to repack the atlas with padding between tiles.
const HALF_TEXEL_INSET = 0.5;

/** A rect's U/V bounds within the atlas (top-left pixel origin -> bottom-left-origin UV space), inset half a texel to avoid bleeding into the next tile. */
export function atlasUV(rect: PixelRect, atlasWidth: number, atlasHeight: number) {
  const [x0, y0, x1, y1] = rect;
  return {
    uMin: (x0 + HALF_TEXEL_INSET) / atlasWidth,
    uMax: (x1 + 1 - HALF_TEXEL_INSET) / atlasWidth,
    vMin: 1 - (y1 + 1 - HALF_TEXEL_INSET) / atlasHeight,
    vMax: 1 - (y0 + HALF_TEXEL_INSET) / atlasHeight,
  };
}

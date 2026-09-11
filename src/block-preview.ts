import * as THREE from 'three';
import { BlockId } from './block';
import { itemShapeBoxes, type ShapeBox } from './block-shapes';
import type { InventorySlot } from './inventory';

/**
 * Renders a small 3D isometric preview of a block into a canvas.
 * Shared by the hotbar/backpack slots and the creative block palette.
 *
 * Uses ONE shared offscreen WebGLRenderer for every call instead of creating a
 * new WebGLRenderer (and therefore a new WebGL context) per slot: browsers cap
 * the number of simultaneous WebGL contexts (~16), which we blew past with 36
 * inventory slots + 15 creative blocks + cursor ghosts. The shared renderer
 * draws into an offscreen canvas, then the result is copied into each target
 * 2D canvas via drawImage.
 */
const PREVIEW_SIZE = 44;

let sharedRenderer: THREE.WebGLRenderer | null = null;
function getSharedRenderer(): THREE.WebGLRenderer {
  if (!sharedRenderer) {
    const offscreen = document.createElement('canvas');
    sharedRenderer = new THREE.WebGLRenderer({ canvas: offscreen, alpha: true, antialias: false });
    sharedRenderer.setClearColor(0x000000, 0);
    sharedRenderer.setPixelRatio(1);
    sharedRenderer.setSize(PREVIEW_SIZE, PREVIEW_SIZE, false);
  }
  return sharedRenderer;
}

// Bundle every texture up front so a catalog path like "blocks/dirt.png" or
// "items/apple.png" resolves to its hashed asset URL. A dynamic
// `new URL(\`../textures/${path}\`, import.meta.url)` only globs one directory
// level, so it silently broke once textures moved into subfolders.
const TEXTURE_URLS = import.meta.glob('../textures/**/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** Catalog path ("items/apple.png") -> hashed asset URL. Exported because the
 *  particle system needs the same resolution for its item chips. */
export function resolveTextureUrl(path: string): string {
  const url = TEXTURE_URLS[`../textures/${path}`];
  if (!url) console.warn(`block-preview: no texture for "${path}"`);
  return url ?? '';
}

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, THREE.Texture>();
function loadTexture(path: string, onLoad: () => void): THREE.Texture {
  const cached = textureCache.get(path);
  if (cached) return cached;
  const texture = textureLoader.load(resolveTextureUrl(path), onLoad);
  textureCache.set(path, texture);
  return texture;
}

const imageCache = new Map<string, HTMLImageElement>();
function loadImage(path: string, onLoad: () => void): HTMLImageElement {
  const cached = imageCache.get(path);
  if (cached) return cached;
  const img = new Image();
  img.addEventListener('load', onLoad);
  img.src = resolveTextureUrl(path);
  imageCache.set(path, img);
  return img;
}

/** Run `cb` once the texture's image is decoded (immediately if already cached). */
function whenImageReady(path: string, cb: () => void): void {
  const img = loadImage(path, () => {});
  if (img.complete && img.naturalWidth > 0) cb();
  else img.addEventListener('load', cb, { once: true });
}

/** Draw a flat pixel-art item icon (no WebGL). Used for tools / materials. */
export function renderItemIcon(canvas: HTMLCanvasElement, texturePath: string) {
  canvas.width = PREVIEW_SIZE;
  canvas.height = PREVIEW_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx || !texturePath) return;
  ctx.imageSmoothingEnabled = false;
  const img = loadImage(texturePath, () => {
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    ctx.drawImage(img, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  });
  if (img.complete && img.naturalWidth > 0) {
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    ctx.drawImage(img, 0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
  }
}

// LCE ItemInHandRenderer extrudes the 2D icon by one texel of depth, so the
// silhouette gains a chunky pixel-art rim. Geometry is shared per texture.
const ITEM_DEPTH = 1 / 16;
const itemGeoCache = new Map<string, THREE.BufferGeometry>();

function extrudeItemGeometry(img: HTMLImageElement): THREE.BufferGeometry {
  const w = img.naturalWidth || 16;
  const h = img.naturalHeight || 16;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.imageSmoothingEnabled = false;
  c.drawImage(img, 0, 0);
  const px = c.getImageData(0, 0, w, h).data;
  const solid = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && px[(y * w + x) * 4 + 3] >= 128;

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const d = ITEM_DEPTH / 2;
  const X = (x: number) => -0.5 + x / w;   // pixel column -> local X
  const Y = (y: number) => 0.5 - y / h;    // pixel row (0 = top) -> local Y

  // p0..p3 wound CCW; two triangles; per-corner uv.
  const quad = (
    p0: number[], p1: number[], p2: number[], p3: number[],
    n: number[], u: number[][],
  ) => {
    const tri = (a: number[], b: number[], cc: number[], ua: number[], ub: number[], uc: number[]) => {
      pos.push(...a, ...b, ...cc);
      nrm.push(...n, ...n, ...n);
      uv.push(...ua, ...ub, ...uc);
    };
    tri(p0, p1, p2, u[0], u[1], u[2]);
    tri(p0, p2, p3, u[0], u[2], u[3]);
  };

  // Front (+Z) and back (-Z): full-icon quads; alphaTest carves the shape.
  quad([-0.5, -0.5, d], [0.5, -0.5, d], [0.5, 0.5, d], [-0.5, 0.5, d],
    [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  quad([0.5, -0.5, -d], [-0.5, -0.5, -d], [-0.5, 0.5, -d], [0.5, 0.5, -d],
    [0, 0, -1], [[1, 0], [0, 0], [0, 1], [1, 1]]);

  // Silhouette rim: a side quad wherever a solid pixel meets a hole or the edge.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      const u = (x + 0.5) / w;
      const v = 1 - (y + 0.5) / h;
      const uu: number[][] = [[u, v], [u, v], [u, v], [u, v]];
      const xl = X(x), xr = X(x + 1);
      const yt = Y(y), yb = Y(y + 1);
      if (!solid(x, y - 1)) quad([xl, yt, -d], [xr, yt, -d], [xr, yt, d], [xl, yt, d], [0, 1, 0], uu);
      if (!solid(x, y + 1)) quad([xr, yb, -d], [xl, yb, -d], [xl, yb, d], [xr, yb, d], [0, -1, 0], uu);
      if (!solid(x - 1, y)) quad([xl, yb, -d], [xl, yt, -d], [xl, yt, d], [xl, yb, d], [-1, 0, 0], uu);
      if (!solid(x + 1, y)) quad([xr, yt, -d], [xr, yb, -d], [xr, yb, d], [xr, yt, d], [1, 0, 0], uu);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.userData.shared = true; // cached — never disposed per-instance
  return geo;
}

/** A 3D pixel-extruded model of a held item (tool / material) in first person. */
export function buildItemMesh(texturePath: string): THREE.Group {
  const group = new THREE.Group();
  if (!texturePath) return group;
  const tex = loadTexture(texturePath, () => {});
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  const material = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
  material.userData.baseColor = new THREE.Color(0xffffff); // for tintByLight()

  const attach = () => {
    let geo = itemGeoCache.get(texturePath);
    if (!geo) {
      const img = imageCache.get(texturePath);
      if (!img || !img.complete || !img.naturalWidth) return;
      geo = extrudeItemGeometry(img);
      itemGeoCache.set(texturePath, geo);
    }
    group.add(new THREE.Mesh(geo, material));
  };

  if (itemGeoCache.has(texturePath)) attach();
  else whenImageReady(texturePath, attach);
  return group;
}

/**
 * Multiply every material's colour by a 0..1 world-light level (gamma-ish), for
 * the first-person hand and dropped-item entities. Materials must carry
 * `userData.baseColor` (buildBlockMesh / buildItemMesh set it).
 */
export function tintByLight(root: THREE.Object3D, level01: number): void {
  const b = Math.pow(THREE.MathUtils.clamp(level01, 0, 1), 1.25);
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      const base = (m as THREE.MeshBasicMaterial).userData?.baseColor as THREE.Color | undefined;
      if (base) (m as THREE.MeshBasicMaterial).color.copy(base).multiplyScalar(b);
    }
  });
}

export function renderBlockPreview(canvas: HTMLCanvasElement, slot: InventorySlot) {
  canvas.width = PREVIEW_SIZE;
  canvas.height = PREVIEW_SIZE;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) return;

  const renderer = getSharedRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.35, 1.35, 1.35, -1.35, 0.1, 100);
  camera.position.set(0, 3.2, 4);
  camera.lookAt(0, 0, 0);

  const draw = () => {
    renderer.render(scene, camera);
    ctx2d.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    ctx2d.drawImage(renderer.domElement, 0, 0);
  };

  const mesh = buildBlockMesh(slot, draw);
  scene.add(mesh);
  draw();

  // Keep the mesh alive a couple of frames so the async `draw()` that fires when
  // a texture finishes decoding still has live geometry/materials (otherwise the
  // preview can render black on a fresh page load). The shared textures/renderer
  // are never disposed here.
  requestAnimationFrame(() => requestAnimationFrame(() => disposeBlockMesh(mesh)));
}

/** Recursively free a mesh built by buildBlockMesh (geometry + materials). */
export function disposeBlockMesh(root: THREE.Object3D) {
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (!obj.geometry.userData?.shared) obj.geometry.dispose(); // cached item geo is shared
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose());
    }
  });
}

/**
 * Build the live 3D representation of a block (solid cube + baked-shade overlay,
 * or a flat quad for fire). Returned as a Group so callers can add it to a real
 * scene (first-person hand) or a throwaway one (inventory preview).
 * `onTextureLoad` fires when a texture finishes decoding (needed only by the
 * one-shot offscreen preview, which must re-draw).
 */
/** Edge length of a preview block, matching the cube path below. */
const SIZE = 1.5;

/**
 * Remaps a sub-box's UVs to the slice of the texture that part of a full
 * block would show, so a slab's side isn't the whole plank texture squashed
 * to half height. BoxGeometry's face order is +X,-X,+Y,-Y,+Z,-Z, 4 verts
 * each, with each face's UVs spanning 0..1.
 */
function cropBoxUVs(geo: THREE.BoxGeometry, box: ShapeBox) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const ranges: [number, number, number, number][] = [
    [box.z0, box.z1, box.y0, box.y1], // +X: across = Z, up = Y
    [box.z0, box.z1, box.y0, box.y1], // -X
    [box.x0, box.x1, box.z0, box.z1], // +Y: across = X, "up" = Z
    [box.x0, box.x1, box.z0, box.z1], // -Y
    [box.x0, box.x1, box.y0, box.y1], // +Z: across = X, up = Y
    [box.x0, box.x1, box.y0, box.y1], // -Z
  ];
  for (let face = 0; face < 6; face += 1) {
    const [u0, u1, v0, v1] = ranges[face];
    for (let corner = 0; corner < 4; corner += 1) {
      const i = face * 4 + corner;
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
  }
  uv.needsUpdate = true;
}

export function buildBlockMesh(slot: InventorySlot, onTextureLoad: () => void = () => {}): THREE.Group {
  const group = new THREE.Group();
  const isWater = slot.id === BlockId.WATER;
  const isLava = slot.id === BlockId.LAVA;
  const isLiquid = isWater || isLava;
  const isFire = slot.id === BlockId.FIRE;
  const isTorch = slot.id === BlockId.TORCH;

  // Fire isn't a solid cube in-game - it's a flat animated sprite (a "cross" of
  // planes). Boxing it with the flipbook texture looked wrong; show it as a
  // single flat quad instead, like a proper icon.
  if ((isFire || isTorch) && slot.sideTexture) {
    const tex = loadTexture(slot.sideTexture, onTextureLoad);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    if (isFire) {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1, 1 / 32);
      tex.offset.set(0, 31 / 32);
    }
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.05,
      side: THREE.DoubleSide,
    });
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9), mat));
    return group;
  }

  const draw = onTextureLoad;
  const sideTexture = slot.sideTexture ? loadTexture(slot.sideTexture, draw) : null;
  const topTexture = slot.topTexture ? loadTexture(slot.topTexture, draw) : sideTexture;

  if (sideTexture) {
    sideTexture.colorSpace = THREE.SRGBColorSpace;
    sideTexture.magFilter = THREE.NearestFilter;
    sideTexture.minFilter = THREE.NearestFilter;
    if (isWater) {
      sideTexture.wrapS = THREE.RepeatWrapping;
      sideTexture.wrapT = THREE.RepeatWrapping;
      sideTexture.repeat.set(0.5, 1 / 64);
      sideTexture.offset.set(0, 63 / 64);
    }
    if (isLava) {
      sideTexture.wrapS = THREE.RepeatWrapping;
      sideTexture.wrapT = THREE.RepeatWrapping;
      sideTexture.repeat.set(0.5, 1 / 32);
      sideTexture.offset.set(0, 31 / 32);
    }
  }

  if (topTexture) {
    topTexture.colorSpace = THREE.SRGBColorSpace;
    topTexture.magFilter = THREE.NearestFilter;
    topTexture.minFilter = THREE.NearestFilter;
    if (isWater) {
      topTexture.wrapS = THREE.RepeatWrapping;
      topTexture.wrapT = THREE.RepeatWrapping;
      topTexture.repeat.set(1, 1 / 32);
      topTexture.offset.set(0, 31 / 32);
    }
    if (isLava) {
      topTexture.wrapS = THREE.RepeatWrapping;
      topTexture.wrapT = THREE.RepeatWrapping;
      topTexture.repeat.set(1, 1 / 20);
      topTexture.offset.set(0, 19 / 20);
    }
  }

  const faceMaterials = Array.from({ length: 6 }, (_, faceIndex) => {
    const isTopOrBottom = faceIndex === 2 || faceIndex === 3;
    const texture = isTopOrBottom ? (topTexture ?? sideTexture) : sideTexture;
    // previewColor tints the texture (e.g. foliage green for leaves, whose
    // texture is grayscale in-game and normally tinted via vertex colors we
    // don't compute here). Water/lava keep their hardcoded tint either way;
    // any other textured block with no previewColor stays untinted (white).
    const base = isWater ? 0x3f76e4 : isLava ? 0xff6a00 : (slot.previewColor ?? 0xffffff);
    const params: THREE.MeshBasicMaterialParameters = {
      color: base,
      transparent: isLiquid,
      opacity: isLiquid ? 0.85 : 1,
    };
    if (texture) params.map = texture;
    const mat = new THREE.MeshBasicMaterial(params);
    // Remembered so a caller (first-person hand) can re-tint by world light.
    mat.userData.baseColor = new THREE.Color(base);
    return mat;
  });

  // Stairs and slabs are drawn from the same sub-boxes the world mesher uses,
  // so they read as an actual stair/slab in the hotbar, in hand and as a
  // dropped item instead of a plain cube.
  const shapeBoxes = slot.id == null ? null : itemShapeBoxes(slot.id);
  if (shapeBoxes) {
    const shaped = new THREE.Group();
    for (const box of shapeBoxes) {
      const geo = new THREE.BoxGeometry(
        (box.x1 - box.x0) * SIZE, (box.y1 - box.y0) * SIZE, (box.z1 - box.z0) * SIZE,
      );
      cropBoxUVs(geo, box);
      const mesh = new THREE.Mesh(geo, faceMaterials);
      mesh.position.set(
        ((box.x0 + box.x1) / 2 - 0.5) * SIZE,
        ((box.y0 + box.y1) / 2 - 0.5) * SIZE,
        ((box.z0 + box.z1) / 2 - 0.5) * SIZE,
      );
      shaped.add(mesh);
    }
    shaped.rotation.y = Math.PI / 4;
    group.add(shaped);
    return group;
  }

  const cubeHeight = isLiquid ? 1.5 * 0.9 : 1.5;
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, cubeHeight, 1.5),
    faceMaterials,
  );
  cube.rotation.y = Math.PI / 4;
  cube.position.y = isLiquid ? -0.075 : 0;
  group.add(cube);

  const overlayMaterials = Array.from({ length: 6 }, (_, index) => new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: index === 4 ? 0.5 : index === 1 ? 0.25 : 0,
    depthWrite: false,
  }));
  const overlays = new THREE.Mesh(
    new THREE.BoxGeometry(1.504, isLiquid ? 1.504 * 0.9 : 1.504, 1.504),
    overlayMaterials,
  );
  overlays.rotation.y = Math.PI / 4;
  overlays.position.y = isLiquid ? -0.075 : 0;
  overlays.renderOrder = 1;
  group.add(overlays);

  return group;
}

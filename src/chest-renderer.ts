import * as THREE from 'three';

/**
 * The chest's actual in-world visual - deliberately NOT baked into the
 * terrain mesh (see block.ts's blockLightProperties[CHEST] doc comment):
 * the lid has to rotate open/closed every frame, which a static greedy-
 * meshed cube can't do. Same architectural split LCE itself uses (its
 * ChestTile bakes nothing, ChestRenderer.cpp draws it separately).
 *
 * UV layout is NOT guessed - it's derived from LCE's own ChestModel.cpp,
 * which builds this exact texture (textures/blocks/chest.png is a straight
 * copy of LCE's Common/res/1_2_2/item/chest.png - EvlyMC's earlier version
 * of this file had two face-pairs swapped, see below) via the standard
 * Minecraft ModelPart box-UV formula: given a (u,v) origin and box
 * dimensions (w,h,d), a box's 6 faces land at fixed offsets from that
 * origin. ChestModel.cpp's two boxes:
 *   lid:    origin (0,0),  size w=14 h=5  d=14  (addBox 14,5,14)
 *   bottom: origin (0,19), size w=14 h=10 d=14  (addBox 14,10,14) - "bottom"
 *           is LCE's own name for the box/base part, not its bottom FACE.
 * For an origin (u,v) and size (w,h,d), the formula places: top at
 * (u+d,v)..(u+d+w,v+d), bottom-face at (u+d+w,v)..(u+d+w+w,v+d), right at
 * (u,v+d)..(u+d,v+d+h), front at (u+d,v+d)..(u+d+w,v+d+h), left at
 * (u+d+w,v+d)..(u+d+w+d,v+d+h), back at (u+d+w+d,v+d)..(u+d+w+d+w,v+d+h).
 * The lid's own bottom face and the box's own top face sit flush against
 * each other when closed - neither is ever actually seen, which is why
 * they're unused/oddly-shaded in the source art (one dark, one near-black).
 */
const TEX_SIZE = 64;
type PixelRect = [number, number, number, number]; // [x0, y0, x1, y1], top-left origin, exclusive of nothing (just corners)

const RECT = {
  LID_TOP: [14, 0, 28, 14] as PixelRect,
  LID_BOTTOM: [28, 0, 42, 14] as PixelRect,       // never visible (flush against the box top)
  LID_RIGHT: [0, 14, 14, 19] as PixelRect,
  LID_FRONT: [14, 14, 28, 19] as PixelRect,
  LID_LEFT: [28, 14, 42, 19] as PixelRect,
  LID_BACK: [42, 14, 56, 19] as PixelRect,
  BOX_TOP: [14, 19, 28, 33] as PixelRect,         // never visible (flush against the lid bottom)
  BOX_BOTTOM: [28, 19, 42, 33] as PixelRect,      // never visible (sits on the ground)
  BOX_RIGHT: [0, 33, 14, 43] as PixelRect,
  BOX_FRONT: [14, 33, 28, 43] as PixelRect,
  BOX_LEFT: [28, 33, 42, 43] as PixelRect,
  BOX_BACK: [42, 33, 56, 43] as PixelRect,
  // The lock/latch nub ("el cosito de metal") - LCE's ChestModel.cpp has a
  // THIRD box for this, origin (0,0) (same as the lid, but its own tiny
  // w=2 h=4 d=1 footprint lands in the texture's top-left corner, the small
  // grey/metal swatch that isn't part of the lid's own visible area at all).
  // Same box-UV formula as above, with u=0,v=0,w=2,h=4,d=1.
  LOCK_TOP: [1, 0, 3, 1] as PixelRect,
  LOCK_BOTTOM: [3, 0, 5, 1] as PixelRect,
  LOCK_RIGHT: [0, 1, 1, 5] as PixelRect,
  LOCK_FRONT: [1, 1, 3, 5] as PixelRect,
  LOCK_LEFT: [3, 1, 4, 5] as PixelRect,
  LOCK_BACK: [4, 1, 6, 5] as PixelRect,
};

// Lock box dimensions (LCE addBox(-1,-2,-15, 2,4,1), in 1/16-block units).
const LOCK_WIDTH = 2 / 16;
const LOCK_HEIGHT = 4 / 16;
const LOCK_DEPTH = 1 / 16;

const BOX_HEIGHT = 0.625;    // 10/16 - vanilla chest box height
const LID_HEIGHT = 0.3125;   // 5/16 - vanilla chest lid height
const WIDTH = 0.875;         // 14/16 - vanilla chest footprint (inset 1/16 each side)
const LID_OPEN_ANGLE = 1.3;  // radians the lid tilts back when open (~75 degrees)
const ANIM_RATE = 8;         // damp() lambda - how snappily the lid eases toward open/closed

/** Sets one BoxGeometry face's 4 UVs to a pixel rect, flipping Y (image top-down -> UV bottom-up). Face order is BoxGeometry's own: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z. */
function setFaceUV(uv: THREE.BufferAttribute, faceIndex: number, rect: PixelRect): void {
  const [px0, py0, px1, py1] = rect;
  const u0 = px0 / TEX_SIZE, u1 = px1 / TEX_SIZE;
  const v0 = 1 - py1 / TEX_SIZE, v1 = 1 - py0 / TEX_SIZE;
  const base = faceIndex * 4;
  uv.setXY(base + 0, u0, v1);
  uv.setXY(base + 1, u1, v1);
  uv.setXY(base + 2, u0, v0);
  uv.setXY(base + 3, u1, v0);
}

/** Local -Z is this geometry's "front" (the latch/handle face) - group.rotation.y then points it at whichever world direction `facing` names, same convention block-data.ts's `facing` already uses for the furnace. */
function buildBoxGeometry(
  width: number, height: number, depth: number,
  top: PixelRect, bottom: PixelRect, front: PixelRect, back: PixelRect, left: PixelRect, right: PixelRect,
): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(width, height, depth);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  setFaceUV(uv, 0, right);
  setFaceUV(uv, 1, left);
  setFaceUV(uv, 2, top);
  setFaceUV(uv, 3, bottom);
  setFaceUV(uv, 4, back);
  setFaceUV(uv, 5, front);
  uv.needsUpdate = true;
  return geo;
}

type ChestEntry = {
  group: THREE.Group;
  lidPivot: THREE.Group;
  material: THREE.MeshBasicMaterial; // this chest's own clone - see ensureShared's doc comment
  openness: number; // 0 = closed, 1 = fully open, eased every frame
  open: boolean;
};

let boxGeometry: THREE.BoxGeometry | null = null;
let lidGeometry: THREE.BoxGeometry | null = null;
let lockGeometry: THREE.BoxGeometry | null = null;
let material: THREE.MeshBasicMaterial | null = null;

// MeshBasicMaterial, not Lambert/Standard - this voxel engine has no real
// THREE.Light in singleplayer's scene at all (main.ts), only baked per-
// vertex brightness on the terrain's own MeshBasicMaterial, so anything lit
// would just render pure black there. Light-level tint is applied the same
// way PlayerModel.setLightLevel() does it (material.color.setScalar), but
// each chest needs its OWN material clone (see ChestEntry.material below) -
// unlike the player there can be many chests at many different light levels
// at once, so a single shared material's color can't serve them all.
function ensureShared(): void {
  if (material) return;
  const texture = new THREE.TextureLoader().load(new URL('../textures/blocks/chest.png', import.meta.url).href);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  material = new THREE.MeshBasicMaterial({ map: texture });
  boxGeometry = buildBoxGeometry(WIDTH, BOX_HEIGHT, WIDTH, RECT.BOX_TOP, RECT.BOX_BOTTOM, RECT.BOX_FRONT, RECT.BOX_BACK, RECT.BOX_LEFT, RECT.BOX_RIGHT);
  lidGeometry = buildBoxGeometry(WIDTH, LID_HEIGHT, WIDTH, RECT.LID_TOP, RECT.LID_BOTTOM, RECT.LID_FRONT, RECT.LID_BACK, RECT.LID_LEFT, RECT.LID_RIGHT);
  lockGeometry = buildBoxGeometry(LOCK_WIDTH, LOCK_HEIGHT, LOCK_DEPTH, RECT.LOCK_TOP, RECT.LOCK_BOTTOM, RECT.LOCK_FRONT, RECT.LOCK_BACK, RECT.LOCK_LEFT, RECT.LOCK_RIGHT);
}

/**
 * Per-position chest models, keyed the same way groundItems/arrowMeshes are
 * in multiplayer-game.ts (a plain "x,y,z" string) - built/torn down as
 * chests enter/leave the loaded world, animated once per rendered frame.
 */
export class ChestRenderer {
  private readonly entries = new Map<string, ChestEntry>();

  constructor(private readonly scene: THREE.Scene) {
    ensureShared();
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  /** Facing: 0=+Z, 1=+X, 2=-Z, 3=-X (block-data.ts's convention) - rotates the geometry's local -Z front to point that way. */
  spawn(x: number, y: number, z: number, facing: 0 | 1 | 2 | 3 = 0): void {
    const key = this.key(x, y, z);
    if (this.entries.has(key)) return;
    ensureShared();

    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = [Math.PI, -Math.PI / 2, 0, Math.PI / 2][facing];

    // Own clone so this chest's light-level tint (see update()) doesn't
    // bleed onto every other chest sharing the same base material/texture.
    const ownMaterial = material!.clone();

    const box = new THREE.Mesh(boxGeometry!, ownMaterial);
    box.position.y = -0.5 + BOX_HEIGHT / 2;
    group.add(box);

    // Lid pivots at its own back-top edge (hinge, +Z local = back), tilts
    // up-and-back around X as it opens (see update()'s LID_OPEN_ANGLE math).
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, -0.5 + BOX_HEIGHT, WIDTH / 2);
    const lid = new THREE.Mesh(lidGeometry!, ownMaterial);
    lid.position.set(0, LID_HEIGHT / 2, -WIDTH / 2);
    lidPivot.add(lid);

    // The lock/latch - LCE's own ChestModel::render sets `lock->xRot =
    // lid->xRot` every frame (rigidly attached to the lid, swinging with
    // it), so it's a child of lidPivot too, not the static box. Position is
    // LCE's own part offsets (lock->x=8,y=7,z=15, lid->x=1,y=7,z=15, in
    // 1/16-block units, Y measured DOWN from the model's top and Z from its
    // front) converted into this pivot's local space and re-centred here:
    // world y = 0.5 - 7/16 = 0.0625, world z = 0.5/16 - 0.5 = -0.46875,
    // minus the pivot's own (0, BOX_HEIGHT-0.5, WIDTH/2).
    const lock = new THREE.Mesh(lockGeometry!, ownMaterial);
    lock.position.set(0, -0.0625, -0.90625);
    lidPivot.add(lock);

    group.add(lidPivot);

    this.scene.add(group);
    this.entries.set(key, { group, lidPivot, material: ownMaterial, openness: 0, open: false });
  }

  despawn(x: number, y: number, z: number): void {
    const key = this.key(x, y, z);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.material.dispose();
    this.entries.delete(key);
  }

  setOpen(x: number, y: number, z: number, open: boolean): void {
    const entry = this.entries.get(this.key(x, y, z));
    if (entry) entry.open = open;
  }

  has(x: number, y: number, z: number): boolean {
    return this.entries.has(this.key(x, y, z));
  }

  /** Every chest's box+lid meshes, for BlockInteraction's raycast (see its getExtraMeshes doc comment) - a chest has zero terrain-mesh geometry to hit otherwise. */
  getRaycastTargets(): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    for (const entry of this.entries.values()) meshes.push(entry.group.children[0], entry.lidPivot.children[0]);
    return meshes;
  }

  /** `getLight(x,y,z)` returns the raw 0..15 world light level, same signature as lightEngine.getRawBrightness - see main.ts's/multiplayer-game.ts's own setLightLevel() calls for the pattern this mirrors. */
  update(delta: number, getLight?: (x: number, y: number, z: number) => number): void {
    for (const [key, entry] of this.entries) {
      entry.openness = THREE.MathUtils.damp(entry.openness, entry.open ? 1 : 0, ANIM_RATE, delta);
      entry.lidPivot.rotation.x = LID_OPEN_ANGLE * entry.openness;
      if (getLight) {
        const [x, y, z] = key.split(',').map(Number);
        const b = Math.pow(THREE.MathUtils.clamp(getLight(x, y, z) / 15, 0, 1), 1.25);
        entry.material.color.setScalar(b);
      }
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.scene.remove(entry.group);
      entry.material.dispose();
    }
    this.entries.clear();
  }
}

import * as THREE from 'three';

/**
 * The chest's actual in-world visual - deliberately NOT baked into the
 * terrain mesh (see block.ts's blockLightProperties[CHEST] doc comment):
 * the lid has to rotate open/closed every frame, which a static greedy-
 * meshed cube can't do. Same architectural split LCE itself uses (its
 * ChestTile bakes nothing, ChestRenderer.cpp draws it separately).
 *
 * PLACEHOLDER MATERIAL: chest.png's exact UV layout (which region is the
 * lid vs. the box vs. which face) hasn't been confirmed yet, so this draws
 * a plain flat-shaded box instead of guessing a crop and shipping something
 * that might look wrong - swap `buildMaterials()` for a real textured one
 * once that's settled, nothing else here needs to change.
 */
const BOX_HEIGHT = 0.625;   // 10/16 - vanilla chest box height
const LID_HEIGHT = 0.3125;  // 5/16 - vanilla chest lid height
const WIDTH = 0.875;        // 14/16 - vanilla chest footprint (inset 1/16 each side)
const LID_OPEN_ANGLE = -1.05; // radians the lid tilts back when open (~60 degrees)
const ANIM_RATE = 8; // damp() lambda - how snappily the lid eases toward open/closed

type ChestEntry = {
  group: THREE.Group;
  lidPivot: THREE.Group;
  openness: number; // 0 = closed, 1 = fully open, eased every frame
  open: boolean;
};

let boxGeometry: THREE.BoxGeometry | null = null;
let lidGeometry: THREE.BoxGeometry | null = null;
let boxMaterial: THREE.MeshBasicMaterial | null = null;
let lidMaterial: THREE.MeshBasicMaterial | null = null;

// MeshBasicMaterial, not Lambert/Standard - this voxel engine has no real
// THREE.Light in singleplayer's scene at all (main.ts), only baked per-
// vertex brightness on the terrain's own MeshBasicMaterial, so anything lit
// would just render pure black there. A per-position day/night or torch
// light-level tint (like PlayerModel.setLightLevel()) is a real follow-up,
// left flat/undimmed for this pass.
function ensureShared(): void {
  if (boxMaterial) return;
  boxGeometry = new THREE.BoxGeometry(WIDTH, BOX_HEIGHT, WIDTH);
  lidGeometry = new THREE.BoxGeometry(WIDTH, LID_HEIGHT, WIDTH);
  boxMaterial = new THREE.MeshBasicMaterial({ color: 0x8a5a2e });
  lidMaterial = new THREE.MeshBasicMaterial({ color: 0x6e4522 });
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

  /** Facing: 0=+Z, 1=+X, 2=-Z, 3=-X (block-data.ts's convention) - the lid hinges at the BACK, opposite the facing direction, and tilts up toward the front. */
  spawn(x: number, y: number, z: number, facing: 0 | 1 | 2 | 3 = 0): void {
    const key = this.key(x, y, z);
    if (this.entries.has(key)) return;
    ensureShared();

    const group = new THREE.Group();
    group.position.set(x, y, z);
    group.rotation.y = [0, -Math.PI / 2, Math.PI, Math.PI / 2][facing];

    const box = new THREE.Mesh(boxGeometry!, boxMaterial!);
    box.position.y = -0.5 + BOX_HEIGHT / 2;
    group.add(box);

    // Lid pivots at its own back-top edge (hinge), tilts up around X.
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, -0.5 + BOX_HEIGHT, -WIDTH / 2);
    const lid = new THREE.Mesh(lidGeometry!, lidMaterial!);
    lid.position.set(0, LID_HEIGHT / 2, WIDTH / 2);
    lidPivot.add(lid);
    group.add(lidPivot);

    this.scene.add(group);
    this.entries.set(key, { group, lidPivot, openness: 0, open: false });
  }

  despawn(x: number, y: number, z: number): void {
    const key = this.key(x, y, z);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.scene.remove(entry.group);
    this.entries.delete(key);
  }

  setOpen(x: number, y: number, z: number, open: boolean): void {
    const entry = this.entries.get(this.key(x, y, z));
    if (entry) entry.open = open;
  }

  has(x: number, y: number, z: number): boolean {
    return this.entries.has(this.key(x, y, z));
  }

  update(delta: number): void {
    for (const entry of this.entries.values()) {
      entry.openness = THREE.MathUtils.damp(entry.openness, entry.open ? 1 : 0, ANIM_RATE, delta);
      entry.lidPivot.rotation.x = LID_OPEN_ANGLE * entry.openness;
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.scene.remove(entry.group);
    this.entries.clear();
  }
}

import type { BipedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/skeleton.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// skeleton.png's head/body share the same classic 64x32 humanoid texOffs as
// zombie.png (both inherit HumanoidModel's defaults, per LCE ZombieModel.cpp
// having no _init override) - those two rects are identical to zombie-model.ts's.
// The limbs are NOT the same, though: LCE SkeletonModel.cpp's own _init()
// overrides arm0/arm1/leg0/leg1 with addBox(-1,y,-1, 2,12,2, g) - a 2x12x2
// box (half the width/depth of the humanoid default 4x12x4) at the same
// texOffs as the zombie's arms/legs (40,16) and (0,16). Copying the zombie's
// 4px-wide UV rects here mapped half of each face onto blank/transparent
// texture space (the "puffy and see-through limbs" bug) - these rects are
// the same texOffs formula worked out for a 2x12x2 box instead of 4x12x4.
const HEAD_UV: FaceRects = {
  py: [8, 0, 15, 7], ny: [16, 0, 23, 7],
  px: [0, 8, 7, 15], nz: [8, 8, 15, 15], nx: [16, 8, 23, 15], pz: [24, 8, 31, 15],
};
const BODY_UV: FaceRects = {
  py: [20, 16, 27, 19], ny: [28, 16, 35, 19],
  px: [16, 20, 19, 31], nz: [20, 20, 27, 31], nx: [28, 20, 31, 31], pz: [32, 20, 39, 31],
};
// texOffs(0,16), box 2x12x2 (LCE SkeletonModel::_init leg0/leg1).
const LEG_UV: FaceRects = {
  py: [2, 16, 3, 17], ny: [4, 16, 5, 17],
  px: [0, 18, 1, 29], nz: [2, 18, 3, 29], nx: [4, 18, 5, 29], pz: [6, 18, 7, 29],
};
// texOffs(40,16), box 2x12x2 (LCE SkeletonModel::_init arm0/arm1).
const ARM_UV: FaceRects = {
  py: [42, 16, 43, 17], ny: [44, 16, 45, 17],
  px: [40, 18, 41, 29], nz: [42, 18, 43, 29], nx: [44, 18, 45, 29], pz: [46, 18, 47, 29],
};

// Pixels -> blocks at 16px/block, same convention as zombie/pig/cow/sheep.
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(8), PX(8), PX(8)];
const BODY_SIZE: [number, number, number] = [PX(8), PX(12), PX(4)];
// Thin bone limbs (LCE: 2x12x2, half the width/depth of the zombie's 4x12x4).
const LEG_SIZE: [number, number, number] = [PX(2), PX(12), PX(2)];
const ARM_SIZE: [number, number, number] = [PX(2), PX(12), PX(2)];

const LEG_TOP_Y = LEG_SIZE[1];                        // ground -> hip
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] / 2;    // hip -> torso centre
const SHOULDER_Y = LEG_TOP_Y + BODY_SIZE[1];          // hip -> shoulder
const HEAD_PIVOT_Y = SHOULDER_Y + HEAD_SIZE[1] / 2;

// LCE SkeletonModel::_init: leg0->setPos(-2, 12, 0), leg1->setPos(2, 12, 0) -
// an explicit 2px half-gap, not just "flush together" (that formula, half
// the leg's own 2px width, put them almost touching at the centre line).
const LEG_INSET_X = PX(2);
const ARM_INSET_X = BODY_SIZE[0] / 2 + ARM_SIZE[0] / 2; // arms just outside the body

// Arms hang straight down, unlike the zombie's forward-reaching pose - a
// skeleton just stands and shoots, no melee "reach" needed.
const ARM_PITCH = 0;

export const SKELETON_SPEC: BipedSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: HEAD_SIZE, pivot: [0, HEAD_PIVOT_Y, 0], uv: HEAD_UV },
  body: { size: BODY_SIZE, pivot: [0, BODY_PIVOT_Y, 0], uv: BODY_UV },
  leg: { size: LEG_SIZE, uv: LEG_UV },
  legPivots: [
    [-LEG_INSET_X, LEG_TOP_Y, 0], // left
    [LEG_INSET_X, LEG_TOP_Y, 0],  // right
  ],
  arm: { size: ARM_SIZE, uv: ARM_UV },
  armPivots: [
    [-ARM_INSET_X, SHOULDER_Y, 0], // left
    [ARM_INSET_X, SHOULDER_Y, 0],  // right
  ],
  armPitch: ARM_PITCH,
  // Bow held in the right fist for good, rendered the same way as the
  // player's third-person held item (buildItemMesh - see player-model.ts's
  // setHeldItem) - a skeleton never swaps its held item, so there's no
  // per-frame swap logic needed here, just a static attach at build time.
  heldItem: { texturePath: 'items/bow.png', scale: 0.9, position: [0, -0.72, -0.05], rotation: [0, Math.PI / 2, Math.PI] },
};

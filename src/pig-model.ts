import type { QuadrupedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/pig.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// UV rects measured directly off pig.png's pixels (PLAN-MOBS.md Fase C), not
// assumed from memory - verified exact against the texture's own opaque
// regions. Face-key assignment (which literal axis gets "top"/"front"/etc.)
// is otherwise arbitrary as long as it's consistent; top/bottom/front/back
// are the ones that matter visually and those are right by construction.
//
// Box unfold layout (Minecraft's standard texOffs(u,v) + size(dx,dy,dz)):
//   row 1 (height dz): [[skip dz] top(dx) | bottom(dx)]
//   row 2 (height dy): [right(dz) | front(dx) | left(dz) | back(dx)]

// Head: texOffs(0,0), size 8x8x8 px.
const HEAD_UV: FaceRects = {
  py: [8, 0, 15, 7], ny: [16, 0, 23, 7],
  nx: [0, 8, 7, 15], nz: [8, 8, 15, 15], px: [16, 8, 23, 15], pz: [24, 8, 31, 15],
};

// Body: texOffs(28,8), size 10x16x8 px - modelled lying along Z, stood up via rotateX90.
// right/left are dz(8) wide, front/back are dx(10) wide - NOT symmetric like the
// (cubic) head, so left/back can't just mirror right/front's width.
const BODY_UV: FaceRects = {
  py: [36, 8, 45, 15], ny: [46, 8, 55, 15],
  nx: [28, 16, 35, 31], nz: [36, 16, 45, 31], px: [46, 16, 53, 31], pz: [54, 16, 63, 31],
};

// Leg: texOffs(0,16), size 4x6x4 px - shared by all 4 legs, just repositioned.
const LEG_UV: FaceRects = {
  py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  nx: [0, 20, 3, 25], nz: [4, 20, 7, 25], px: [8, 20, 11, 25], pz: [12, 20, 15, 25],
};

// Pixels -> blocks at Minecraft's standard 16px/block, no inflation (unlike
// the player model's +10% head/torso fudge - these textures don't need it).
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(8), PX(8), PX(8)];
const BODY_SIZE: [number, number, number] = [PX(10), PX(16), PX(8)]; // pre-rotation (dx,dy,dz)
const LEG_SIZE: [number, number, number] = [PX(4), PX(6), PX(4)];

// After rotateX90, the body's authored dy (length) becomes world depth (Z)
// and its dz (depth) becomes world height (Y) - so the body's actual
// vertical extent is PX(8), not PX(16).
const LEG_TOP_Y = LEG_SIZE[1];                     // ground -> top of legs
const BODY_HEIGHT_STANDING = PX(8);
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_HEIGHT_STANDING / 2;
const BODY_HALF_LENGTH = PX(16) / 2;               // world-Z half-extent post-rotation
const HEAD_PIVOT_Y = LEG_TOP_Y + BODY_HEIGHT_STANDING * 0.55; // slightly above body centre
const HEAD_PIVOT_Z = -BODY_HALF_LENGTH - HEAD_SIZE[2] / 2;    // snug against the body's front face

const LEG_INSET_X = BODY_SIZE[0] / 2 - LEG_SIZE[0] / 2 - PX(1); // tucked in slightly from the body's sides
const LEG_Z = BODY_HALF_LENGTH * 0.6;

export const PIG_SPEC: QuadrupedSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: HEAD_SIZE, pivot: [0, HEAD_PIVOT_Y, HEAD_PIVOT_Z], uv: HEAD_UV },
  body: { size: BODY_SIZE, pivot: [0, BODY_PIVOT_Y, 0], uv: BODY_UV, rotateX90: true },
  leg: { size: LEG_SIZE, uv: LEG_UV },
  legPivots: [
    [-LEG_INSET_X, LEG_TOP_Y, -LEG_Z], // front-left
    [LEG_INSET_X, LEG_TOP_Y, -LEG_Z],  // front-right
    [-LEG_INSET_X, LEG_TOP_Y, LEG_Z],  // back-left
    [LEG_INSET_X, LEG_TOP_Y, LEG_Z],   // back-right
  ],
};

import type { QuadrupedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/sheep.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// UV rects measured directly off sheep.png's pixels (PLAN-MOBS.md Fase F), same
// method as pig/cow: hypothesise texOffs+size, verify exact against the real
// opaque runs.
//
// Finding worth calling out: unlike PLAN-MOBS.md's Fase B assumption, this
// asset has NO separate inflated "wool" overlay layer distinct from the body -
// the single body box's own texture already IS the wool pattern (confirmed
// visually: the fluffy brown/white noise lives directly in the body region,
// there's no second lighter-weight island anywhere else in the file; the
// canvas is fully unused past x=55). So SHEEP_SPEC has no `overlay` - the
// MobModel overlay path (built in Fase B) stays implemented but genuinely
// unexercised by any of these three textures. Not fabricating a fake overlay
// just to "use" it.
//
// Box unfold layout (Minecraft's standard texOffs(u,v) + size(dx,dy,dz)):
//   row 1 (height dz): [[skip dz] top(dx) | bottom(dx)]
//   row 2 (height dy): [right(dz) | front(dx) | left(dz) | back(dx)]
// right/left are dz wide, front/back are dx wide - only interchangeable when
// dx==dz (true for every leg here, and the pig's cubic head, but not for the
// sheep/cow heads or any of the three bodies).

// Head: texOffs(0,0), size 6x6x8 px (deeper than it is wide/tall).
const HEAD_UV: FaceRects = {
  py: [8, 0, 13, 7], ny: [14, 0, 19, 7],
  nx: [0, 8, 7, 13], nz: [8, 8, 13, 13], px: [14, 8, 21, 13], pz: [22, 8, 27, 13],
};

// Body: texOffs(28,8), size 8x16x6 px - modelled lying along Z, stood up via rotateX90.
const BODY_UV: FaceRects = {
  py: [34, 8, 41, 13], ny: [42, 8, 49, 13],
  nx: [28, 14, 33, 29], nz: [34, 14, 41, 29], px: [42, 14, 47, 29], pz: [48, 14, 55, 29],
};

// Leg: texOffs(0,16), size 4x12x4 px - shared by all 4 legs.
const LEG_UV: FaceRects = {
  py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  nx: [0, 20, 3, 31], nz: [4, 20, 7, 31], px: [8, 20, 11, 31], pz: [12, 20, 15, 31],
};

// Pixels -> blocks at Minecraft's standard 16px/block, no inflation.
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(6), PX(6), PX(8)];
const BODY_SIZE: [number, number, number] = [PX(8), PX(16), PX(6)]; // pre-rotation (dx,dy,dz)
const LEG_SIZE: [number, number, number] = [PX(4), PX(12), PX(4)];

// After rotateX90, the body's authored dy (length) becomes world depth (Z)
// and its dz (depth) becomes world height (Y).
const LEG_TOP_Y = LEG_SIZE[1];                     // ground -> top of legs
const BODY_HEIGHT_STANDING = PX(6);
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_HEIGHT_STANDING / 2;
const BODY_HALF_LENGTH = PX(16) / 2;               // world-Z half-extent post-rotation
const HEAD_PIVOT_Y = LEG_TOP_Y + BODY_HEIGHT_STANDING * 0.55; // slightly above body centre
const HEAD_PIVOT_Z = -BODY_HALF_LENGTH - HEAD_SIZE[2] / 2;    // snug against the body's front face

const LEG_INSET_X = BODY_SIZE[0] / 2 - LEG_SIZE[0] / 2 - PX(1); // tucked in slightly from the body's sides
const LEG_Z = BODY_HALF_LENGTH * 0.6;

export const SHEEP_SPEC: QuadrupedSpec = {
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

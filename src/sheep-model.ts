import { createSolidColorTexture, type QuadrupedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/sheep.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// Wool overlay: sheep.png's body region turned out to be a plain (unshorn-
// looking) hide, not the fluffy pattern PLAN-MOBS.md's Fase F comment below
// assumed - the sheep read as bald. Rather than repaint sheep.png, layer a
// second inflated shell over the body (the same MCPE-style overlay
// mechanism mob-model.ts already has for exactly this) using a flat,
// near-white solid colour instead of the wool block's own patterned
// texture - a plain "just-sheared-fluff" look rather than a literal wool
// block skin.
const WOOL_TEXTURE_SIZE = 16;
const WOOL_COLOR_TEXTURE = createSolidColorTexture('#f2f2ef', WOOL_TEXTURE_SIZE); // very light, almost-white grey
const WOOL_FULL_RECT: [number, number, number, number] = [0, 0, WOOL_TEXTURE_SIZE, WOOL_TEXTURE_SIZE];
const WOOL_UV: FaceRects = {
  py: WOOL_FULL_RECT, ny: WOOL_FULL_RECT,
  nx: WOOL_FULL_RECT, nz: WOOL_FULL_RECT, px: WOOL_FULL_RECT, pz: WOOL_FULL_RECT,
};

// UV rects measured directly off sheep.png's pixels (PLAN-MOBS.md Fase F), same
// method as pig/cow: hypothesise texOffs+size, verify exact against the real
// opaque runs.
//
// Finding worth calling out: unlike PLAN-MOBS.md's Fase B assumption, this
// asset has NO separate inflated "wool" overlay layer distinct from the body -
// the body region is just a plain hide, no fluffy texture baked in anywhere
// in the file (the canvas is fully unused past x=55). That made the sheep
// look bald in-game, so SHEEP_SPEC now adds its own overlay below, sourced
// from blocks/wool.png instead (see WOOL_UV above) rather than from this
// texture at all.
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

// Body: texOffs(28,8), size 8x16x6 px. Same reassignment as the pig's body
// (see its comment): the authored "row 1" pair are the end caps along the
// body's length (dx*dz - front chest/rear), and "row 2" front/back (dx*dy)
// are what end up as world top/bottom once standing - which for the sheep
// is exactly where the wool pattern needs to be.
const BODY_UV: FaceRects = {
  py: [48, 14, 55, 29], ny: [34, 14, 41, 29],
  nx: [28, 14, 33, 29], nz: [34, 8, 41, 13], px: [42, 14, 47, 29], pz: [42, 8, 49, 13],
};

// Leg: texOffs(0,16), size 4x12x4 px - shared by all 4 legs.
const LEG_UV: FaceRects = {
  py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  nx: [0, 20, 3, 31], nz: [4, 20, 7, 31], px: [8, 20, 11, 31], pz: [12, 20, 15, 31],
};

// Pixels -> blocks at Minecraft's standard 16px/block, no inflation.
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(6), PX(6), PX(8)];
// Authored as texOffs width(dx)/depth(dz)/length(dy) - built directly in
// world orientation (x=width, y=height=dz, z=length=dy), no post-hoc
// rotation: a rotated MESH keeps its UVs on the PRE-rotation local faces, so
// "top" ends up facing sideways instead of up. Building the geometry with
// the axes already swapped avoids that entirely.
const BODY_SIZE: [number, number, number] = [PX(8), PX(6), PX(16)];
const LEG_SIZE: [number, number, number] = [PX(4), PX(12), PX(4)];

const LEG_TOP_Y = LEG_SIZE[1];                     // ground -> top of legs
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] / 2;
const BODY_HALF_LENGTH = BODY_SIZE[2] / 2;
const HEAD_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] * 0.85; // raised - was 0.55 (barely above body centre), read as low/hunched
const HEAD_PIVOT_Z = -BODY_HALF_LENGTH - HEAD_SIZE[2] / 2; // snug against the body's front face

const LEG_INSET_X = BODY_SIZE[0] / 2 - LEG_SIZE[0] / 2 - PX(0.3); // wider stance - was PX(1) (too tucked-in)
const LEG_Z = BODY_HALF_LENGTH * 0.78; // more front/back separation - was 0.6

export const SHEEP_SPEC: QuadrupedSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: HEAD_SIZE, pivot: [0, HEAD_PIVOT_Y, HEAD_PIVOT_Z], uv: HEAD_UV },
  body: { size: BODY_SIZE, pivot: [0, BODY_PIVOT_Y, 0], uv: BODY_UV },
  leg: { size: LEG_SIZE, uv: LEG_UV },
  legPivots: [
    [-LEG_INSET_X, LEG_TOP_Y, -LEG_Z], // front-left
    [LEG_INSET_X, LEG_TOP_Y, -LEG_Z],  // front-right
    [-LEG_INSET_X, LEG_TOP_Y, LEG_Z],  // back-left
    [LEG_INSET_X, LEG_TOP_Y, LEG_Z],   // back-right
  ],
  overlay: {
    texture: WOOL_COLOR_TEXTURE,
    textureW: WOOL_TEXTURE_SIZE,
    textureH: WOOL_TEXTURE_SIZE,
    size: BODY_SIZE,
    pivot: [0, BODY_PIVOT_Y, 0],
    uv: WOOL_UV,
    inflate: PX(1.5),
  },
};

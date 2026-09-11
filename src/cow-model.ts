import { createSolidColorTexture, type QuadrupedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

// Horns: cow.png has no verified UV region for them (the one unmapped patch
// noted below doesn't cleanly fit a two-horn box-unwrap), so rather than
// guess at pixel coordinates that might land on the wrong art, they're built
// as small solid-coloured boxes (same trick as the sheep's wool overlay).
const HORN_TEXTURE_SIZE = 4;
const HORN_COLOR_TEXTURE = createSolidColorTexture('#e8dfc4', HORN_TEXTURE_SIZE); // pale horn/bone colour
const HORN_FULL_RECT: [number, number, number, number] = [0, 0, HORN_TEXTURE_SIZE, HORN_TEXTURE_SIZE];
const HORN_UV: FaceRects = {
  py: HORN_FULL_RECT, ny: HORN_FULL_RECT,
  nx: HORN_FULL_RECT, nz: HORN_FULL_RECT, px: HORN_FULL_RECT, pz: HORN_FULL_RECT,
};

const TEXTURE_PATH = new URL('../textures/mobs/cow.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// UV rects measured directly off cow.png's pixels (PLAN-MOBS.md Fase E), same
// method as the pig: hypothesise texOffs+size, then verify every resulting
// rect boundary against the texture's actual opaque runs before trusting it.
// A ~6x6px block near (52-61, 0-6) doesn't fit any of these three parts
// (horns/udder, going by shape and position) and is left unmapped - same
// call as the pig's stray unused patch in Fase C.
//
// Box unfold layout (Minecraft's standard texOffs(u,v) + size(dx,dy,dz)):
//   row 1 (height dz): [[skip dz] top(dx) | bottom(dx)]
//   row 2 (height dy): [right(dz) | front(dx) | left(dz) | back(dx)]

// Head: texOffs(0,0), size 8x8x6 px. right/left are dz(6) wide, front/back are
// dx(8) wide - not symmetric, left/back can't just mirror right/front's width.
const HEAD_UV: FaceRects = {
  py: [6, 0, 13, 5], ny: [14, 0, 21, 5],
  nx: [0, 6, 5, 13], nz: [6, 6, 13, 13], px: [14, 6, 19, 13], pz: [20, 6, 27, 13],
};

// Body: texOffs(18,4), size 12x18x10 px. Same reassignment as the pig's body
// (see its comment): the authored "row 1" pair are the end caps along the
// body's length (dx*dz - front chest/rear), and "row 2" front/back (dx*dy)
// are what end up as world top/bottom once standing.
const BODY_UV: FaceRects = {
  py: [50, 14, 61, 31], ny: [28, 14, 39, 31],
  nx: [18, 14, 27, 31], nz: [28, 4, 39, 13], px: [40, 14, 49, 31], pz: [40, 4, 51, 13],
};

// Leg: texOffs(0,16), size 4x12x4 px - taller than the pig's, shared by all 4 legs.
const LEG_UV: FaceRects = {
  py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  nx: [0, 20, 3, 31], nz: [4, 20, 7, 31], px: [8, 20, 11, 31], pz: [12, 20, 15, 31],
};

// Pixels -> blocks at Minecraft's standard 16px/block, no inflation.
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(8), PX(8), PX(6)];
// Authored as texOffs width(dx)/depth(dz)/length(dy) - built directly in
// world orientation (x=width, y=height=dz, z=length=dy), no post-hoc
// rotation: a rotated MESH keeps its UVs on the PRE-rotation local faces, so
// "top" ends up facing sideways instead of up. Building the geometry with
// the axes already swapped avoids that entirely.
const BODY_SIZE: [number, number, number] = [PX(12), PX(10), PX(18)];
const LEG_SIZE: [number, number, number] = [PX(4), PX(12), PX(4)];

const LEG_TOP_Y = LEG_SIZE[1];                     // ground -> top of legs
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] / 2;
const BODY_HALF_LENGTH = BODY_SIZE[2] / 2;
const HEAD_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] * 0.85; // raised - was 0.55 (barely above body centre)
const HEAD_PIVOT_Z = -BODY_HALF_LENGTH - HEAD_SIZE[2] / 2; // snug against the body's front face

const LEG_INSET_X = BODY_SIZE[0] / 2 - LEG_SIZE[0] / 2 - PX(1); // tucked in slightly from the body's sides
const LEG_Z = BODY_HALF_LENGTH * 0.6;

const HORN_SIZE: [number, number, number] = [PX(1.5), PX(3), PX(1.5)];
const HORN_X = HEAD_SIZE[0] / 2 - PX(0.5); // near the sides of the head
const HORN_Y = HEAD_SIZE[1] / 2; // resting on the top edge
const HORN_Z = -HEAD_SIZE[2] * 0.15; // slightly toward the front

export const COW_SPEC: QuadrupedSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: HEAD_SIZE, pivot: [0, HEAD_PIVOT_Y, HEAD_PIVOT_Z], uv: HEAD_UV },
  // The bottom face's art (udder) is drawn facing the wrong way for how it
  // lands on the mesh - spin it 180° (both axes) so the udder points toward
  // the rear like the rest of the body's front/back already do.
  body: { size: BODY_SIZE, pivot: [0, BODY_PIVOT_Y, 0], uv: BODY_UV, flips: { ny: { u: true, v: true } } },
  leg: { size: LEG_SIZE, uv: LEG_UV },
  legPivots: [
    [-LEG_INSET_X, LEG_TOP_Y, -LEG_Z], // front-left
    [LEG_INSET_X, LEG_TOP_Y, -LEG_Z],  // front-right
    [-LEG_INSET_X, LEG_TOP_Y, LEG_Z],  // back-left
    [LEG_INSET_X, LEG_TOP_Y, LEG_Z],   // back-right
  ],
  extras: [
    {
      size: HORN_SIZE, pivot: [-HORN_X, HORN_Y, HORN_Z], uv: HORN_UV, parent: 'head',
      texture: HORN_COLOR_TEXTURE, textureW: HORN_TEXTURE_SIZE, textureH: HORN_TEXTURE_SIZE,
    },
    {
      size: HORN_SIZE, pivot: [HORN_X, HORN_Y, HORN_Z], uv: HORN_UV, parent: 'head',
      texture: HORN_COLOR_TEXTURE, textureW: HORN_TEXTURE_SIZE, textureH: HORN_TEXTURE_SIZE,
    },
  ],
};

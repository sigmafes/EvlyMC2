import { BlockId, blockLightProperties, isSolidBlock } from './block';
import type { BlockData } from './block-data';

/**
 * Sub-block shapes (stairs and slabs), in local 0..1 cell coordinates.
 *
 * Single source of truth for both rendering (mesher.ts turns these into
 * boxes of quads) and collision (chunk.ts turns them into AABBs), so a stair
 * can never be walked through differently from how it looks.
 *
 * Modelled on LCE's StairTile/HalfSlabTile: `facing` is the direction the
 * stairs ASCEND toward (LCE's "the direction is the way going up"), the top
 * half flag is its UPSIDEDOWN_BIT, and a slab is either half of the cell or
 * a full block once doubled (LCE's fullSize HalfSlabTile).
 */
export type ShapeBox = { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };

/** How a stair meets its neighbours - LCE setStepShape / setInnerPieceShape. */
export type StairShape = 'straight' | 'outer_ccw' | 'outer_cw' | 'inner_ccw' | 'inner_cw';

export const STAIR_BLOCKS = new Set<BlockId>([BlockId.OAK_STAIRS, BlockId.COBBLESTONE_STAIRS]);
export const SLAB_BLOCKS = new Set<BlockId>([BlockId.OAK_SLAB, BlockId.COBBLESTONE_SLAB]);

export function isStairs(id: BlockId): boolean {
  return STAIR_BLOCKS.has(id);
}
export function isSlab(id: BlockId): boolean {
  return SLAB_BLOCKS.has(id);
}
/** True for any block whose shape isn't the full cell. */
export function isShapedBlock(id: BlockId): boolean {
  return STAIR_BLOCKS.has(id) || SLAB_BLOCKS.has(id);
}

/** The block a stair/slab is cut from - it borrows its texture, sound, hardness and drops. */
export const SHAPE_PARENT: Partial<Record<BlockId, BlockId>> = {
  [BlockId.OAK_STAIRS]: BlockId.OAK_PLANKS,
  [BlockId.OAK_SLAB]: BlockId.OAK_PLANKS,
  [BlockId.COBBLESTONE_STAIRS]: BlockId.COBBLESTONE,
  [BlockId.COBBLESTONE_SLAB]: BlockId.COBBLESTONE,
};

/** The slab you get by cutting a given parent block, for the double-slab merge. */
export const SLAB_OF: Partial<Record<BlockId, BlockId>> = {
  [BlockId.OAK_PLANKS]: BlockId.OAK_SLAB,
  [BlockId.COBBLESTONE]: BlockId.COBBLESTONE_SLAB,
};

// facing: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X (block-data.ts's convention), so
// stepping the index by one turns 90 degrees counter-clockwise seen from above.
const ccw = (f: number) => (f + 1) & 3;
const cw = (f: number) => (f + 3) & 3;
const opposite = (f: number) => (f + 2) & 3;
/** 0 for the Z facings, 1 for the X facings - two stairs only form a corner across different axes. */
const axisOf = (f: number) => f & 1;

/** The half of the cell lying on side `f`, full height. */
function halfToward(f: number): ShapeBox {
  switch (f) {
    case 0: return { x0: 0, y0: 0, z0: 0.5, x1: 1, y1: 1, z1: 1 };
    case 1: return { x0: 0.5, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 };
    case 2: return { x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 0.5 };
    default: return { x0: 0, y0: 0, z0: 0, x1: 0.5, y1: 1, z1: 1 };
  }
}

function intersect(a: ShapeBox, b: ShapeBox): ShapeBox {
  return {
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), z0: Math.max(a.z0, b.z0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), z1: Math.min(a.z1, b.z1),
  };
}

/** Clamps a full-height box to the slab half (`top`) or the step half (the other one). */
function atHeight(box: ShapeBox, y0: number, y1: number): ShapeBox {
  return { ...box, y0, y1 };
}

export function slabBoxes(top: boolean): ShapeBox[] {
  return [top
    ? { x0: 0, y0: 0.5, z0: 0, x1: 1, y1: 1, z1: 1 }
    : { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 1 }];
}

export function stairBoxes(facing: number, top: boolean, shape: StairShape): ShapeBox[] {
  // The solid half (the "slab" part) plus the step sitting on the other half.
  const base: ShapeBox = top
    ? { x0: 0, y0: 0.5, z0: 0, x1: 1, y1: 1, z1: 1 }
    : { x0: 0, y0: 0, z0: 0, x1: 1, y1: 0.5, z1: 1 };
  const stepY0 = top ? 0 : 0.5;
  const stepY1 = top ? 0.5 : 1;
  const front = halfToward(facing);
  const boxes: ShapeBox[] = [base];

  if (shape === 'outer_ccw' || shape === 'outer_cw') {
    // Corner turning away from us: the step is cut back to the quarter on the
    // side the staircase continues toward.
    const side = halfToward(shape === 'outer_ccw' ? ccw(facing) : cw(facing));
    boxes.push(atHeight(intersect(front, side), stepY0, stepY1));
  } else {
    boxes.push(atHeight(front, stepY0, stepY1));
    if (shape === 'inner_ccw' || shape === 'inner_cw') {
      // Corner turning into us: the full step plus the back quarter on the
      // side the other staircase comes from.
      const side = halfToward(shape === 'inner_ccw' ? ccw(facing) : cw(facing));
      boxes.push(atHeight(intersect(halfToward(opposite(facing)), side), stepY0, stepY1));
    }
  }
  return boxes;
}

export type BlockReader = (x: number, y: number, z: number) => BlockId;
export type DataReader = (x: number, y: number, z: number) => BlockData | undefined;

const FACING_OFFSET: Record<number, [number, number]> = { 0: [0, 1], 1: [1, 0], 2: [0, -1], 3: [-1, 0] };

function stairAt(x: number, y: number, z: number, f: number, readBlock: BlockReader, readData: DataReader) {
  const [dx, dz] = FACING_OFFSET[f];
  const id = readBlock(x + dx, y, z + dz);
  if (!isStairs(id)) return null;
  const data = readData(x + dx, y, z + dz);
  return { facing: data?.facing ?? 0, top: data?.half === 'top' };
}

/**
 * LCE StairTile's corner rules: a stair corners with the stair it faces
 * (outer) or the one behind it (inner), but only when that neighbour sits on
 * the same half and turns across the other axis.
 */
export function stairShapeAt(
  x: number, y: number, z: number, facing: number, top: boolean,
  readBlock: BlockReader, readData: DataReader,
): StairShape {
  const front = stairAt(x, y, z, facing, readBlock, readData);
  if (front && front.top === top && axisOf(front.facing) !== axisOf(facing)) {
    return front.facing === ccw(facing) ? 'outer_ccw' : 'outer_cw';
  }
  const back = stairAt(x, y, z, opposite(facing), readBlock, readData);
  if (back && back.top === top && axisOf(back.facing) !== axisOf(facing)) {
    return back.facing === ccw(facing) ? 'inner_ccw' : 'inner_cw';
  }
  return 'straight';
}

/**
 * The boxes making up this block, or null when it fills the whole cell (every
 * ordinary block, plus a doubled slab) and callers should use their fast path.
 */
export function shapeBoxesFor(
  id: BlockId, x: number, y: number, z: number,
  readBlock: BlockReader, readData: DataReader,
): ShapeBox[] | null {
  if (isSlab(id)) {
    const data = readData(x, y, z);
    if (data?.double) return null;
    return slabBoxes(data?.half === 'top');
  }
  if (isStairs(id)) {
    const data = readData(x, y, z);
    const facing = data?.facing ?? 0;
    const top = data?.half === 'top';
    return stairBoxes(facing, top, stairShapeAt(x, y, z, facing, top, readBlock, readData));
  }
  return null;
}

/**
 * The shape to draw a stair/slab with as an ITEM (hotbar icon, held in hand,
 * dropped entity), or null for blocks that are just cubes. Stairs get a
 * straight piece ascending away from the viewer so the icon reads as a
 * staircase profile rather than hiding the step behind the tall side.
 */
export function itemShapeBoxes(id: BlockId): ShapeBox[] | null {
  if (isSlab(id)) return slabBoxes(false);
  if (isStairs(id)) return stairBoxes(2, false, 'straight');
  return null;
}

/** True if `id` fills its whole cell opaquely, so a shaped block's face flush against it can be dropped. */
export function coversWholeFace(id: BlockId): boolean {
  return isSolidBlock(id) && !isShapedBlock(id) && blockLightProperties[id]?.cull !== false;
}

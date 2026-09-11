import * as THREE from 'three';
import { BlockId, blockLightProperties, isFlammable, STATEFUL_BLOCKS } from './block';
import type { BlockData } from './block-data';
import { FACING_TO_FACE_INDEX } from './block-data';
import { type ShapeBox, shapeBoxesFor, coversWholeFace, isShapedBlock, SHAPE_PARENT } from './block-shapes';

/** A block that fire can stand on top of (used to pick floor vs wall fire). */
function isFireGround(id: BlockId): boolean {
  return id !== BlockId.AIR
    && id !== BlockId.FIRE
    && id !== BlockId.WATER
    && id !== BlockId.LAVA
    && id !== BlockId.OAK_LEAVES;
}

export const MATERIAL_BEDROCK = 0;
export const MATERIAL_OAK_PLANKS = 1;
export const MATERIAL_STONE = 2;
export const MATERIAL_DIRT = 3;
export const MATERIAL_GRASS_SIDE = 4;
export const MATERIAL_GRASS_TOP = 5;
export const MATERIAL_GRASS_BOTTOM = 6;
export const MATERIAL_GLOWSTONE = 7;
export const MATERIAL_OAK_LOG_SIDE = 8;
export const MATERIAL_OAK_LOG_TOP = 9;
export const MATERIAL_WATER_STILL = 10;
export const MATERIAL_WATER_FLOW = 11;
export const MATERIAL_OAK_LEAVES = 12;
export const MATERIAL_SAND = 13;
export const MATERIAL_FIRE = 14;
export const MATERIAL_LAVA_STILL = 15;
export const MATERIAL_LAVA_FLOW = 16;
export const MATERIAL_COBBLESTONE = 17;
export const MATERIAL_OBSIDIAN = 18;
export const MATERIAL_ICE = 19;
export const MATERIAL_COAL_ORE = 20;
export const MATERIAL_IRON_ORE = 21;
export const MATERIAL_GOLD_ORE = 22;
export const MATERIAL_DIAMOND_ORE = 23;
export const MATERIAL_EMERALD_ORE = 24;
export const MATERIAL_LAPIS_ORE = 25;
export const MATERIAL_REDSTONE_ORE = 26;
export const MATERIAL_CRAFTING_TABLE_SIDE1 = 27;
export const MATERIAL_CRAFTING_TABLE_SIDE2 = 28;
export const MATERIAL_CRAFTING_TABLE_TOP = 29;
export const MATERIAL_GLASS = 30;
export const MATERIAL_FURNACE_SIDE = 31;
export const MATERIAL_FURNACE_FRONT_OFF = 32;
export const MATERIAL_FURNACE_FRONT_ON = 33;
export const MATERIAL_FURNACE_TOP = 34;
export const MATERIAL_TORCH = 35;
export const MATERIAL_WOOL = 36;
const MATERIAL_COUNT = 37;

export type BlockReader = (x: number, y: number, z: number) => BlockId;
export type LightReader = (x: number, y: number, z: number) => number;
export type WaterDistanceReader = (id: BlockId, x: number, y: number, z: number) => number;
export type WaterFlowReader = (x: number, y: number, z: number) => THREE.Vector3;
export type BlockDataReader = (x: number, y: number, z: number) => BlockData | undefined;
export type SubchunkRenderStats = {
  exposedFaces: number;
  facesByMaterial: number[];
  vertexCount: number;
  indexCount: number;
};

type Face = {
  normal: [number, number, number];
  corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
};

const faces: Face[] = [
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

function addFirePlane(
  vertices: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  worldX: number,
  y: number,
  worldZ: number,
  plane: 'x' | 'z',
  offset: number,
) {
  const halfWidth = 0.95 / 2;
  const bottom = y - 0.5;
  const top = y + 0.8;
  const vertexOffset = vertices.length / 3;
  const corners = plane === 'x'
    ? [
        [worldX - halfWidth, bottom, worldZ + offset],
        [worldX - halfWidth, top, worldZ + offset],
        [worldX + halfWidth, top, worldZ + offset],
        [worldX + halfWidth, bottom, worldZ + offset],
      ]
    : [
        [worldX + offset, bottom, worldZ - halfWidth],
        [worldX + offset, top, worldZ - halfWidth],
        [worldX + offset, top, worldZ + halfWidth],
        [worldX + offset, bottom, worldZ + halfWidth],
      ];

  for (const [x, vertexY, z] of corners) {
    vertices.push(x, vertexY, z);
    colors.push(1, 1, 1);
  }
  uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
  indices.push(
    vertexOffset, vertexOffset + 1, vertexOffset + 2,
    vertexOffset, vertexOffset + 2, vertexOffset + 3,
  );
}

type FireWallDir = 'west' | 'east' | 'north' | 'south';

/**
 * Leaning fire quad flush against one side of the cell (wall fire, LCE case B).
 * Block coords are centre-based: the cell spans worldX-0.5..worldX+0.5 etc.
 * The quad sits exactly on the shared face and leans 0.2 into the fire's own
 * (empty) cell at the top, so it never floats off or clips into the burning block.
 */
function addFireWall(
  vertices: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  worldX: number,
  y: number,
  worldZ: number,
  dir: FireWallDir,
) {
  const bottom = y - 0.5;
  const top = y + 0.9;
  const lean = 0.2;
  const xMin = worldX - 0.5, xMax = worldX + 0.5;
  const zMin = worldZ - 0.5, zMax = worldZ + 0.5;

  // Ordered bottom-left, top-left, top-right, bottom-right.
  let corners: number[][];
  if (dir === 'west' || dir === 'east') {
    const face = dir === 'west' ? xMin : xMax;      // shared face with the burning block
    const leanX = dir === 'west' ? face + lean : face - lean;
    corners = [
      [face, bottom, zMin],
      [leanX, top, zMin],
      [leanX, top, zMax],
      [face, bottom, zMax],
    ];
  } else {
    const face = dir === 'north' ? zMin : zMax;
    const leanZ = dir === 'north' ? face + lean : face - lean;
    corners = [
      [xMin, bottom, face],
      [xMin, top, leanZ],
      [xMax, top, leanZ],
      [xMax, bottom, face],
    ];
  }

  const base = vertices.length / 3;
  for (const [x, vy, z] of corners) {
    vertices.push(x, vy, z);
    colors.push(1, 1, 1);
  }
  uvs.push(0, 0, 0, 1, 1, 1, 1, 0); // bottom -> v0, top -> v1 (same as addFirePlane)
  indices.push(
    base, base + 1, base + 2, base, base + 2, base + 3, // both winding orders
    base, base + 2, base + 1, base, base + 3, base + 2,
  );
}

/** Fire hanging below the block above (LCE case B, `canBurn(x, y+1, z)`). */
function addFireCeiling(
  vertices: number[],
  uvs: number[],
  colors: number[],
  indices: number[],
  worldX: number,
  y: number,
  worldZ: number,
) {
  const topEdge = y + 0.5;        // flush with the ceiling
  const hang = topEdge - 0.9;
  const xMin = worldX - 0.5, xMax = worldX + 0.5;
  const zMin = worldZ - 0.5, zMax = worldZ + 0.5;

  for (const plane of [
    [[xMin, topEdge, zMin], [xMin, hang, zMin], [xMax, hang, zMax], [xMax, topEdge, zMax]],
    [[xMin, topEdge, zMax], [xMin, hang, zMax], [xMax, hang, zMin], [xMax, topEdge, zMin]],
  ]) {
    const base = vertices.length / 3;
    for (const [x, vy, z] of plane) {
      vertices.push(x, vy, z);
      colors.push(1, 1, 1);
    }
    uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
    indices.push(
      base, base + 1, base + 2, base, base + 2, base + 3,
      base, base + 2, base + 1, base, base + 3, base + 2,
    );
  }
}

/**
 * A torch: two crossed vertical quads showing torch.png (alpha-cut). A floor
 * torch (facing undefined) stands centred; a wall torch (facing 0..3 = the
 * direction it leans) has its base against the wall and its head tilted out.
 */
function addTorch(
  vertices: number[], uvs: number[], colors: number[], indices: number[],
  wx: number, y: number, wz: number, facing: number | undefined,
) {
  const hw = 0.45;          // half quad width
  const H = 0.9;            // torch height
  let bx = 0, bz = 0, tx = 0, tz = 0;
  let by = y - 0.5, ty = y - 0.5 + H;
  if (facing !== undefined) {
    const dx = facing === 1 ? 1 : facing === 3 ? -1 : 0;
    const dz = facing === 0 ? 1 : facing === 2 ? -1 : 0;
    // The wall's near face sits at -dx*0.5 (adjacent cell, half a block away);
    // 0.44 keeps the base flush against it with a hair of margin against z-fighting.
    bx = -dx * 0.44; bz = -dz * 0.44; by = y - 0.30;
    tx = dx * 0.12; tz = dz * 0.12; ty = y - 0.30 + H;
  }
  for (const along of ['x', 'z'] as const) {
    const base = vertices.length / 3;
    const corners = along === 'x'
      ? [
          [wx + bx - hw, by, wz + bz],
          [wx + tx - hw, ty, wz + tz],
          [wx + tx + hw, ty, wz + tz],
          [wx + bx + hw, by, wz + bz],
        ]
      : [
          [wx + bx, by, wz + bz - hw],
          [wx + tx, ty, wz + tz - hw],
          [wx + tx, ty, wz + tz + hw],
          [wx + bx, by, wz + bz + hw],
        ];
    for (const [X, Y, Z] of corners) { vertices.push(X, Y, Z); colors.push(1, 1, 1); }
    uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
    indices.push(
      base, base + 1, base + 2, base, base + 2, base + 3,
      base, base + 2, base + 1, base, base + 3, base + 2,
    );
  }
}

/**
 * Per-face (u,v) parametrisation matching what the full-cube path produces,
 * so a sub-box samples exactly the part of the texture that the same slice of
 * a full block would have shown (a half slab gets the bottom half of the
 * texture on its sides, not a squashed copy of the whole thing).
 */
function faceUV(faceIndex: number, x: number, y: number, z: number): [number, number] {
  switch (faceIndex) {
    case 0: return [z, y];         // +X
    case 1: return [1 - z, y];     // -X
    case 2: return [1 - z, x];     // +Y
    case 3: return [z, x];         // -Y
    case 4: return [1 - x, y];     // +Z
    default: return [x, y];        // -Z
  }
}

/** Emits the 6 faces of one sub-box of a stair/slab, in local 0..1 cell coords. */
function addShapeBox(
  vertices: number[][], uvs: number[][], colors: number[][], indices: number[][],
  material: number, box: ShapeBox, worldX: number, y: number, worldZ: number,
  readBlock: BlockReader, readLight: LightReader,
): number {
  const lo = [box.x0, box.y0, box.z0];
  const hi = [box.x1, box.y1, box.z1];
  if (hi[0] <= lo[0] || hi[1] <= lo[1] || hi[2] <= lo[2]) return 0;

  let emitted = 0;
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
    const face = faces[faceIndex];
    const [nx, ny, nz] = face.normal;
    const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
    const positive = nx + ny + nz > 0;

    // Only a face flush with the cell boundary can be hidden, and only by a
    // neighbour that fills its own cell opaquely.
    const flush = positive ? hi[axis] === 1 : lo[axis] === 0;
    if (flush && coversWholeFace(readBlock(worldX + nx, y + ny, worldZ + nz))) continue;

    const positionData = vertices[material];
    const uvData = uvs[material];
    const indexData = indices[material];
    const vertexOffset = positionData.length / 3;

    for (const corner of face.corners) {
      const lx = corner[0] === 0 ? lo[0] : hi[0];
      const ly = corner[1] === 0 ? lo[1] : hi[1];
      const lz = corner[2] === 0 ? lo[2] : hi[2];
      positionData.push(worldX - 0.5 + lx, y - 0.5 + ly, worldZ - 0.5 + lz);
      const [u, v] = faceUV(faceIndex, lx, ly, lz);
      uvData.push(u, v);
      // A face that stops short of the cell boundary (a slab's top, a stair's
      // riser) is lit by the air in THIS cell, not by whatever is in the next
      // one - sampling the neighbour turned a slab's top face black as soon
      // as anything solid was placed above it.
      const level = flush
        ? readLight(worldX + nx, y + ny, worldZ + nz)
        : readLight(worldX, y, worldZ);
      const brightness = getFaceBrightness(level, faceIndex);
      colors[material].push(brightness, brightness, brightness);
    }
    indexData.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3,
    );
    emitted += 1;
  }
  return emitted;
}

function materialForFace(id: BlockId, faceIndex: number, liquidDistance: number = 0, data?: BlockData) {
  // Stairs/slabs (including a doubled slab coming through the full-cube path)
  // render with their parent block's texture.
  const parent = SHAPE_PARENT[id];
  if (parent !== undefined) return materialForFace(parent, faceIndex, liquidDistance, data);
  if (id === BlockId.BEDROCK) return MATERIAL_BEDROCK;
  if (id === BlockId.OAK_PLANKS) return MATERIAL_OAK_PLANKS;
  if (id === BlockId.STONE) return MATERIAL_STONE;
  if (id === BlockId.DIRT) return MATERIAL_DIRT;
  if (id === BlockId.GLOWSTONE) return MATERIAL_GLOWSTONE;
  if (id === BlockId.OAK_LOG) return faceIndex === 2 || faceIndex === 3 ? MATERIAL_OAK_LOG_TOP : MATERIAL_OAK_LOG_SIDE;
  if (id === BlockId.OAK_LEAVES) return MATERIAL_OAK_LEAVES;
  if (id === BlockId.SAND) return MATERIAL_SAND;
  if (id === BlockId.FIRE) return MATERIAL_FIRE;
  if (id === BlockId.WATER) return liquidDistance === 0 ? MATERIAL_WATER_STILL : MATERIAL_WATER_FLOW;
  if (id === BlockId.LAVA) return liquidDistance === 0 ? MATERIAL_LAVA_STILL : MATERIAL_LAVA_FLOW;
  if (id === BlockId.COBBLESTONE) return MATERIAL_COBBLESTONE;
  if (id === BlockId.OBSIDIAN) return MATERIAL_OBSIDIAN;
  if (id === BlockId.ICE) return MATERIAL_ICE;
  if (id === BlockId.GLASS) return MATERIAL_GLASS;
  if (id === BlockId.WOOL) return MATERIAL_WOOL;
  if (id === BlockId.FURNACE) {
    if (faceIndex === 2 || faceIndex === 3) return MATERIAL_FURNACE_TOP; // top & bottom
    const front = data?.facing != null ? FACING_TO_FACE_INDEX[data.facing] : 4; // default +Z
    if (faceIndex === front) return data?.lit ? MATERIAL_FURNACE_FRONT_ON : MATERIAL_FURNACE_FRONT_OFF;
    return MATERIAL_FURNACE_SIDE;
  }
  if (id === BlockId.COAL_ORE) return MATERIAL_COAL_ORE;
  if (id === BlockId.IRON_ORE) return MATERIAL_IRON_ORE;
  if (id === BlockId.GOLD_ORE) return MATERIAL_GOLD_ORE;
  if (id === BlockId.DIAMOND_ORE) return MATERIAL_DIAMOND_ORE;
  if (id === BlockId.EMERALD_ORE) return MATERIAL_EMERALD_ORE;
  if (id === BlockId.LAPIS_ORE) return MATERIAL_LAPIS_ORE;
  if (id === BlockId.REDSTONE_ORE) return MATERIAL_REDSTONE_ORE;
  if (id === BlockId.CRAFTING_TABLE) {
    if (faceIndex === 2) return MATERIAL_CRAFTING_TABLE_TOP;   // +Y
    if (faceIndex === 3) return MATERIAL_OAK_PLANKS;           // -Y (underside = planks)
    // sides go 1,2,1,2 around: +X/-X = side1, +Z/-Z = side2
    return faceIndex === 0 || faceIndex === 1 ? MATERIAL_CRAFTING_TABLE_SIDE1 : MATERIAL_CRAFTING_TABLE_SIDE2;
  }
  if (faceIndex === 2) return MATERIAL_GRASS_TOP;
  if (faceIndex === 3) return MATERIAL_GRASS_BOTTOM;
  return MATERIAL_GRASS_SIDE;
}

function getLiquidCornerHeight(
  readBlock: BlockReader,
  readWaterDistance: WaterDistanceReader,
  liquidId: BlockId,
  worldX: number,
  y: number,
  worldZ: number,
  cornerX: number,
  cornerZ: number,
): number {
  const dx = cornerX === 1 ? 1 : -1;
  const dz = cornerZ === 1 ? 1 : -1;
  const columns: [number, number][] = [
    [worldX, worldZ],
    [worldX + dx, worldZ],
    [worldX, worldZ + dz],
    [worldX + dx, worldZ + dz],
  ];

  for (const [cx, cz] of columns) {
    if (readBlock(cx, y + 1, cz) === liquidId) {
      return 1.0;
    }
  }

  let totalHeight = 0;
  let waterCount = 0;

  const maxDist = 7; // both liquids cap `distance` (== MCPE data) at 7
  const minHeight = 0.05;

  for (const [cx, cz] of columns) {
    if (readBlock(cx, y, cz) === liquidId) {
      const dist = readWaterDistance(liquidId, cx, y, cz);
      const nominalHeight = dist === 0 ? 0.9 : Math.max(minHeight, 0.9 - (dist / maxDist) * (0.9 - minHeight));
      totalHeight += nominalHeight;
      waterCount += 1;
    }
  }

  return waterCount > 0 ? totalHeight / waterCount : 0.9;
}

function rotateUV(uv: number[], angle: number): number[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotated: number[] = [];
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i] - 0.5;
    const v = uv[i + 1] - 0.5;
    rotated.push(cos * u - sin * v + 0.5, sin * u + cos * v + 0.5);
  }
  return rotated;
}

export function buildSubchunkGeometry(
  readBlock: BlockReader,
  minY: number,
  maxY: number,
  chunkMinX = -8,
  chunkMinZ = -8,
  readLight: LightReader = () => 15,
  smoothLighting = false,
  ambientOcclusion = false,
  readWaterDistance: WaterDistanceReader = () => 0,
  readWaterFlow: WaterFlowReader = () => new THREE.Vector3(),
  readBlockData: BlockDataReader = () => undefined,
) {
  const vertices: number[][] = Array.from({ length: MATERIAL_COUNT }, () => []);
  const uvs: number[][] = Array.from({ length: MATERIAL_COUNT }, () => []);
  const colors: number[][] = Array.from({ length: MATERIAL_COUNT }, () => []);
  const indices: number[][] = Array.from({ length: MATERIAL_COUNT }, () => []);
  let exposedFaces = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let z = 0; z < 16; z += 1) {
      for (let x = 0; x < 16; x += 1) {
        const worldX = chunkMinX + x;
        const worldZ = chunkMinZ + z;
        const id = readBlock(worldX, y, worldZ);
        if (id === BlockId.AIR) continue;

        if (id === BlockId.FIRE) {
          const fireVertices = vertices[MATERIAL_FIRE];
          const fireUvs = uvs[MATERIAL_FIRE];
          const fireColors = colors[MATERIAL_FIRE];
          const fireIndices = indices[MATERIAL_FIRE];
          const fireArgs = [fireVertices, fireUvs, fireColors, fireIndices, worldX, y, worldZ] as const;
          const below = readBlock(worldX, y - 1, worldZ);

          if (isFireGround(below) || isFlammable(below)) {
            // Floor fire: the campfire-style cross of planes.
            addFirePlane(...fireArgs, 'x', -0.2375);
            addFirePlane(...fireArgs, 'x', 0.2375);
            addFirePlane(...fireArgs, 'z', -0.2375);
            addFirePlane(...fireArgs, 'z', 0.2375);
            addFirePlane(...fireArgs, 'x', -0.475);
            addFirePlane(...fireArgs, 'x', 0.475);
            addFirePlane(...fireArgs, 'z', -0.475);
            addFirePlane(...fireArgs, 'z', 0.475);
            exposedFaces += 16;
          } else {
            // Wall / ceiling fire: one leaning quad per flammable side (+ ceiling).
            if (isFlammable(readBlock(worldX - 1, y, worldZ))) addFireWall(...fireArgs, 'west');
            if (isFlammable(readBlock(worldX + 1, y, worldZ))) addFireWall(...fireArgs, 'east');
            if (isFlammable(readBlock(worldX, y, worldZ - 1))) addFireWall(...fireArgs, 'north');
            if (isFlammable(readBlock(worldX, y, worldZ + 1))) addFireWall(...fireArgs, 'south');
            if (isFlammable(readBlock(worldX, y + 1, worldZ))) addFireCeiling(...fireArgs);
            exposedFaces += 2;
          }
          continue;
        }

        if (id === BlockId.TORCH) {
          const facing = readBlockData(worldX, y, worldZ)?.facing;
          addTorch(
            vertices[MATERIAL_TORCH], uvs[MATERIAL_TORCH], colors[MATERIAL_TORCH], indices[MATERIAL_TORCH],
            worldX, y, worldZ, facing,
          );
          exposedFaces += 2;
          continue;
        }

        if (isShapedBlock(id)) {
          // Stairs / slabs: a handful of sub-boxes instead of one cell-filling
          // cube (a doubled slab falls through to the normal path).
          const boxes = shapeBoxesFor(id, worldX, y, worldZ, readBlock, readBlockData);
          if (boxes) {
            const material = materialForFace(id, 0);
            for (const box of boxes) {
              exposedFaces += addShapeBox(
                vertices, uvs, colors, indices, material, box,
                worldX, y, worldZ, readBlock, readLight,
              );
            }
            continue;
          }
        }

        const blockData = STATEFUL_BLOCKS.has(id) ? readBlockData(worldX, y, worldZ) : undefined;

        for (let faceIndex = 0; faceIndex < faces.length; faceIndex += 1) {
          const face = faces[faceIndex];
          const neighbor = readBlock(worldX + face.normal[0], y + face.normal[1], worldZ + face.normal[2]);
          const isWater = id === BlockId.WATER;
          const isLava = id === BlockId.LAVA;
          const isIce = id === BlockId.ICE;
          const isGlass = id === BlockId.GLASS;
          const currentBlockCulls = blockLightProperties[id]?.cull !== false;
          const neighborCulls = blockLightProperties[neighbor]?.cull !== false;

          if (isWater) {
            if (neighbor !== BlockId.AIR) continue;
          } else if (isLava) {
            // Lava never culls - render all faces
          } else if (isIce) {
            if (neighbor === BlockId.ICE) continue; // Cull ice-to-ice faces
            // Ice doesn't cull with anything else, including water and solid blocks
          } else if (isGlass) {
            if (neighbor === BlockId.GLASS) continue; // Cull glass-to-glass faces
            // Glass shows through everything else (solids, water, ...)
          } else if (!currentBlockCulls) {
            // Transparent blocks (cull: false) don't cull with anything except water is handled below
            if (neighbor !== BlockId.AIR && neighbor !== BlockId.WATER) {
              // Still render transparent blocks even next to solid blocks
            }
          } else {
            if (neighbor !== BlockId.AIR && neighbor !== BlockId.WATER && neighbor !== BlockId.LAVA) {
              if (neighborCulls) continue; // Only cull if neighbor actually culls faces
            }
          }

          const liquidDistance = (isWater || isLava) ? readWaterDistance(id, worldX, y, worldZ) : 0;
          const material = materialForFace(id, faceIndex, liquidDistance, blockData);
          exposedFaces += 1;
          const positionData = vertices[material];
          const uvData = uvs[material];
          const indexData = indices[material];
          const vertexOffset = positionData.length / 3;
          const faceLight = [face.normal[0], y + face.normal[1], face.normal[2]];
          for (const corner of face.corners) {
            let vertexY = y - 0.5 + corner[1];
            if ((isWater || isLava) && corner[1] === 1) {
              const cornerHeight = getLiquidCornerHeight(
                readBlock,
                readWaterDistance,
                id,
                worldX,
                y,
                worldZ,
                corner[0],
                corner[2],
              );
              vertexY = y - 0.5 + cornerHeight;
            }
            positionData.push(worldX - 0.5 + corner[0], vertexY, worldZ - 0.5 + corner[2]);
            const level = smoothLighting
              ? getSmoothVertexLight(readLight, worldX, y, worldZ, face, corner)
              : readLight(worldX + faceLight[0], faceLight[1], worldZ + faceLight[2]);
            const brightness = getFaceBrightness(level, faceIndex)
              * (ambientOcclusion && !isWater && !isLava ? getAmbientOcclusion(readBlock, worldX, y, worldZ, face, corner) : 1);
            colors[material].push(brightness, brightness, brightness);
          }
          let faceUVs = [0, 0, 0, 1, 1, 1, 1, 0];
          if ((isWater || isLava) && faceIndex === 2 && material === (id === BlockId.WATER ? MATERIAL_WATER_FLOW : MATERIAL_LAVA_FLOW)) {
            const flow = readWaterFlow(worldX, y, worldZ);
            if (flow.length() > 0) {
              const angle = Math.atan2(flow.z, flow.x);
              faceUVs = rotateUV(faceUVs, angle);
            }
          }
          uvData.push(...faceUVs);
          indexData.push(
            vertexOffset, vertexOffset + 1, vertexOffset + 2,
            vertexOffset, vertexOffset + 2, vertexOffset + 3,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  const positionArray: number[] = [];
  const uvArray: number[] = [];
  const colorArray: number[] = [];
  const indexArray: number[] = [];
  for (let material = 0; material < vertices.length; material += 1) {
    const materialVertices = vertices[material];
    const materialUvs = uvs[material];
    const materialIndices = indices[material];
    if (materialIndices.length === 0) continue;
    const indexOffset = positionArray.length / 3;
    for (const vertex of materialVertices) positionArray.push(vertex);
    for (const uv of materialUvs) uvArray.push(uv);
    for (const color of colors[material]) colorArray.push(color);
    for (const index of materialIndices) indexArray.push(index + indexOffset);
    const groupStart = indexArray.length - materialIndices.length;
    geometry.addGroup(groupStart, materialIndices.length, material);
  }

  const stats: SubchunkRenderStats = {
    exposedFaces,
    facesByMaterial: indices.map((materialIndices) => materialIndices.length / 6),
    vertexCount: positionArray.length / 3,
    indexCount: indexArray.length,
  };
  geometry.userData.renderStats = stats;
  if (positionArray.length === 0) return geometry;
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionArray, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvArray, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colorArray, 3));
  geometry.setIndex(indexArray);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function getFaceBrightness(level: number, faceIndex: number) {
  const normalized = Math.pow(Math.max(0, Math.min(15, level)) / 15, 1.25);
  const directionFactor = faceIndex === 2 ? 1 : faceIndex === 3 ? 0.5 : faceIndex === 0 || faceIndex === 4 ? 0.8 : 0.6;
  return normalized * directionFactor;
}

function getSmoothVertexLight(readLight: LightReader, x: number, y: number, z: number, face: Face, corner: [number, number, number]) {
  const normalAxis = face.normal.findIndex((value) => value !== 0);
  const tangentAxes = [0, 1, 2].filter((axis) => axis !== normalAxis);
  const base = [x + face.normal[0], y + face.normal[1], z + face.normal[2]];
  const sideA = corner[tangentAxes[0]] === 0 ? -1 : 1;
  const sideB = corner[tangentAxes[1]] === 0 ? -1 : 1;
  const samples = [
    [0, 0], [sideA, 0], [0, sideB], [sideA, sideB],
  ];
  let total = 0;
  for (const [offsetA, offsetB] of samples) {
    const sample = [...base];
    sample[tangentAxes[0]] += offsetA;
    sample[tangentAxes[1]] += offsetB;
    total += readLight(sample[0], sample[1], sample[2]);
  }
  return total / samples.length;
}

function getAmbientOcclusion(readBlock: BlockReader, x: number, y: number, z: number, face: Face, corner: [number, number, number]) {
  const normalAxis = face.normal.findIndex((value) => value !== 0);
  const tangentAxes = [0, 1, 2].filter((axis) => axis !== normalAxis);
  const sideA = corner[tangentAxes[0]] === 0 ? -1 : 1;
  const sideB = corner[tangentAxes[1]] === 0 ? -1 : 1;
  const sideBlockA = [x, y, z];
  const sideBlockB = [x, y, z];
  const cornerBlock = [x, y, z];
  sideBlockA[tangentAxes[0]] += sideA;
  sideBlockB[tangentAxes[1]] += sideB;
  cornerBlock[tangentAxes[0]] += sideA;
  cornerBlock[tangentAxes[1]] += sideB;
  const sideAOccupied = readBlock(sideBlockA[0], sideBlockA[1], sideBlockA[2]) !== BlockId.AIR;
  const sideBOccupied = readBlock(sideBlockB[0], sideBlockB[1], sideBlockB[2]) !== BlockId.AIR;
  const cornerOccupied = readBlock(cornerBlock[0], cornerBlock[1], cornerBlock[2]) !== BlockId.AIR;
  const occlusion = sideAOccupied && sideBOccupied ? 3 : Number(sideAOccupied) + Number(sideBOccupied) + Number(cornerOccupied);
  return 1 - occlusion * 0.12;
}

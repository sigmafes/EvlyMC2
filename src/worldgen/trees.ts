import { BlockId } from '../block';
import { WATER_LEVEL, CHUNK_MAX_Y } from './constants';
import { hashSeed, mulberry32 } from './rng';
import type { ChunkWriter } from './types';

function cellHash(chunk: ChunkWriter, cx: number, cz: number, salt: number): number {
  let h = ((cx * 374761393) ^ (cz * 668265263) ^ (salt * 1274126177) ^ Math.imul(chunk.seed | 0, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function generateTrees(chunk: ChunkWriter): void {
  const cellSize = 6; // one candidate tree per 6x6 cell
  // Cover all cells whose tree canopy could overlap this chunk
  const minCellX = Math.floor((chunk.minX - 2) / cellSize);
  const maxCellX = Math.floor((chunk.minX + 16 + 1) / cellSize);
  const minCellZ = Math.floor((chunk.minZ - 2) / cellSize);
  const maxCellZ = Math.floor((chunk.minZ + 16 + 1) / cellSize);

  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
      const offsetX = 1 + Math.floor(cellHash(chunk, cellX, cellZ, 1) * 3);
      const offsetZ = 1 + Math.floor(cellHash(chunk, cellX, cellZ, 2) * 3);
      const treeX = cellX * cellSize + offsetX;
      const treeZ = cellZ * cellSize + offsetZ;

      // 0..1 forest density; plains stay near-empty, only noise peaks are forest.
      const density = chunk.terrainNoise.sampleTreeDensity(treeX, treeZ);
      const spawnChance = Math.min(0.45, Math.max(0, (density - 0.5) * 1.5));

      if (cellHash(chunk, cellX, cellZ, 3) < spawnChance) {
        const surfaceY = Math.min(CHUNK_MAX_Y - 8, Math.max(5, Math.floor(chunk.getTerrainHeight(treeX, treeZ))));
        if (surfaceY > WATER_LEVEL + 2 && surfaceY < CHUNK_MAX_Y - 7) {
          // Two visually distinct oak shapes (LCE reference: the blocky
          // hand-shaped one below vs a genuine port of TreeFeature::place's
          // organic top-down taper) alternate per tree, deterministically
          // from the same per-cell hash everything else here uses - so a
          // forest doesn't read as one shape copy-pasted everywhere.
          if (cellHash(chunk, cellX, cellZ, 4) < 0.5) {
            generateTreeClassic(chunk, treeX, surfaceY, treeZ);
          } else {
            const rng = mulberry32(hashSeed(cellX, cellZ, chunk.seed ^ 0x7ee5c0de));
            generateTreeOrganic(chunk, treeX, surfaceY, treeZ, rng);
          }
        }
      }
    }
  }
}

/** The original hand-shaped oak: fixed 2-log trunk, blocky tapered canopy. */
function generateTreeClassic(chunk: ChunkWriter, centerX: number, baseY: number, centerZ: number): void {
  const trunkHeight = baseY + 1;

  // Capa 1 y 2: Tronco central (X)
  chunk.placeBlock(centerX, trunkHeight, centerZ, BlockId.OAK_LOG);
  chunk.placeBlock(centerX, trunkHeight + 1, centerZ, BlockId.OAK_LOG);

  // Capa 3: 5x5 lleno de hojas (O) con tronco en el centro (X)
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      const id = (dx === 0 && dz === 0) ? BlockId.OAK_LOG : BlockId.OAK_LEAVES;
      chunk.placeBlock(centerX + dx, trunkHeight + 2, centerZ + dz, id);
    }
  }

  // Capa 4: 5x5 con esquinas de aire (N), tronco en el centro (X) y hojas (O)
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // Esquinas libres
      const id = (dx === 0 && dz === 0) ? BlockId.OAK_LOG : BlockId.OAK_LEAVES;
      chunk.placeBlock(centerX + dx, trunkHeight + 3, centerZ + dz, id);
    }
  }

  // Capa 5: 3x3 de hojas (O)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      chunk.placeBlock(centerX + dx, trunkHeight + 4, centerZ + dz, BlockId.OAK_LEAVES);
    }
  }

  // Capa 6: Cruz de hojas (5 bloques)
  chunk.placeBlock(centerX, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
  chunk.placeBlock(centerX + 1, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
  chunk.placeBlock(centerX - 1, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
  chunk.placeBlock(centerX, trunkHeight + 5, centerZ + 1, BlockId.OAK_LEAVES);
  chunk.placeBlock(centerX, trunkHeight + 5, centerZ - 1, BlockId.OAK_LEAVES);
}

/**
 * Ported from LCE TreeFeature::place (the vanilla-style organic oak): a
 * randomised 4-6 tall trunk with leaves built top-down in shrinking
 * diamond-ish rings (`offs` shrinks as `yo` goes more negative, integer
 * division truncating toward zero exactly like the original C++), each
 * ring's outer corners randomly rounded off except the very top ring
 * (always rounded). Trunk is placed after leaves so it overwrites any leaf
 * that landed in its own column, same order as the original and as
 * placeBlock()'s log-over-leaves rule already assumes. Jungle-specific
 * vines/cocoa from the original aren't relevant to a plain oak and are
 * left out.
 */
function generateTreeOrganic(chunk: ChunkWriter, x: number, baseY: number, z: number, rng: () => number): void {
  const rngInt = (n: number) => Math.floor(rng() * n);
  const y = baseY + 1;
  const treeHeight = 4 + rngInt(3); // 4-6, LCE's default baseHeight=4
  const grassHeight = 3;

  for (let yy = y + treeHeight; yy >= y + treeHeight - grassHeight; yy -= 1) {
    const yo = yy - (y + treeHeight); // 0, -1, -2, -3
    const offs = 1 - Math.trunc(yo / 2);
    for (let xx = x - offs; xx <= x + offs; xx += 1) {
      const xo = xx - x;
      for (let zz = z - offs; zz <= z + offs; zz += 1) {
        const zo = zz - z;
        if (Math.abs(xo) === offs && Math.abs(zo) === offs && (rngInt(2) === 0 || yo === 0)) continue;
        chunk.placeBlock(xx, yy, zz, BlockId.OAK_LEAVES);
      }
    }
  }

  for (let hh = 0; hh < treeHeight; hh += 1) {
    chunk.placeBlock(x, y + hh, z, BlockId.OAK_LOG);
  }
}

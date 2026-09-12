import { BlockId } from '../block';
import { CHUNK_SIZE, WATER_LEVEL, CHUNK_MAX_Y } from './constants';
import { hashSeed, mulberry32 } from './rng';
import type { ChunkWriter } from './types';

/**
 * Loose sand patches scattered across dry surface ground - a much smaller,
 * shallower version of ores.ts's placeOreVein lens blob, restricted to the
 * top couple of layers under grass/dirt instead of anywhere in stone. Sand
 * only, never gravel: gravel is reserved for the submerged bed of a water
 * body (chunk.ts's isWaterBody branch) - every water edge (river, lake or
 * ocean shore) is always sand, so a loose surface patch can't end up reading
 * as "the shore is made of gravel" by landing right next to one.
 */
export function generateSurfacePatches(chunk: ChunkWriter): void {
  const rng = mulberry32(hashSeed(chunk.chunkX, chunk.chunkZ, chunk.seed ^ 0x9a7c1e));
  const rngInt = (n: number) => Math.floor(rng() * n);
  // 75% of chunks skip patches entirely (down from every chunk rolling
  // 2-3) - the patches themselves were fine, there were just too many.
  if (rng() >= 0.25) return;
  const tries = 2 + rngInt(2); // 2-3 attempts per chunk that does roll one

  for (let t = 0; t < tries; t += 1) {
    const cx = chunk.minX + rngInt(CHUNK_SIZE);
    const cz = chunk.minZ + rngInt(CHUNK_SIZE);
    const surfaceY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(chunk.getTerrainHeight(cx, cz))));
    if (surfaceY <= WATER_LEVEL + 2) continue; // shore/underwater already has its own sand/gravel
    const patchId = BlockId.SAND;
    const radius = 2 + rngInt(3); // 2-4 blocks
    const depth = 1 + rngInt(2); // replace the top 1-2 layers

    for (let bx = cx - radius; bx <= cx + radius; bx += 1) {
      if (bx < chunk.minX || bx >= chunk.minX + CHUNK_SIZE) continue;
      for (let bz = cz - radius; bz <= cz + radius; bz += 1) {
        if (bz < chunk.minZ || bz >= chunk.minZ + CHUNK_SIZE) continue;
        const dx = bx - cx, dz = bz - cz;
        if (dx * dx + dz * dz > radius * radius) continue; // circular footprint, not a square stamp
        const colY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(chunk.getTerrainHeight(bx, bz))));
        for (let by = colY; by > colY - depth; by -= 1) {
          const idx = chunk.index(bx, by, bz);
          if (chunk.blocks[idx] === BlockId.GRASS || chunk.blocks[idx] === BlockId.DIRT) {
            chunk.blocks[idx] = patchId;
          }
        }
      }
    }
  }
}

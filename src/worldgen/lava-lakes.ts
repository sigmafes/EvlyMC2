import { BlockId } from '../block';
import { CHUNK_SIZE, WATER_LEVEL, CHUNK_MAX_Y } from './constants';
import { hashSeed, mulberry32 } from './rng';
import type { ChunkWriter } from './types';

/**
 * Rare, exposed-to-air lava pool with a stone rim (LCE LakeFeature's
 * material==lava case, simplified: LCE builds a 16x16x8 grid of 4-7
 * overlapping ellipsoids and then patches solid blocks back in around the
 * edge afterward; here a single ellipsoid does the job, and the stone rim
 * comes from validating the WHOLE padded footprint is solid ground before
 * writing anything, then carving lava only in its inner core - so the rim
 * is guaranteed by construction instead of needing a repair pass). Kept
 * fully inside this chunk (no cross-chunk writes/reads) by aborting if the
 * padded footprint would cross an edge, rather than picking an inset
 * centre - keeps the placement genuinely uniform across the chunk.
 */
export function generateLavaLakes(chunk: ChunkWriter): void {
  const rng = mulberry32(hashSeed(chunk.chunkX, chunk.chunkZ, chunk.seed ^ 0x1a4e));
  if (rng() >= 0.015) return; // rare: ~1.5% of chunks
  const rngInt = (n: number) => Math.floor(rng() * n);

  const cx = chunk.minX + rngInt(CHUNK_SIZE);
  const cz = chunk.minZ + rngInt(CHUNK_SIZE);
  const surfaceY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(chunk.getTerrainHeight(cx, cz))));
  if (surfaceY <= WATER_LEVEL + 2) return; // dry land only - never on a shore/underwater

  // A crater, not a buried ball: the ellipsoid is centred AT the surface
  // and only its lower half is ever carved (by <= cy) - the upper half
  // stays whatever it already was (air), so the lake reads as an open
  // pool at ground level instead of a stone dome sealed shut on top.
  const rx = 3 + rngInt(2), ry = 2 + rngInt(2), rz = 3 + rngInt(2);
  const cy = surfaceY;

  const pad = 1;
  if (cx - rx - pad < chunk.minX || cx + rx + pad >= chunk.minX + CHUNK_SIZE) return;
  if (cz - rz - pad < chunk.minZ || cz + rz + pad >= chunk.minZ + CHUNK_SIZE) return;
  if (cy - ry - pad < 1) return;

  // Validate first: the whole padded footprint (at and below surface level
  // only) must already be solid ground - abort entirely otherwise (a cave,
  // another lake, water, ...already there), so the rim guarantee holds.
  for (let bx = cx - rx - pad; bx <= cx + rx + pad; bx += 1) {
    for (let by = cy - ry - pad; by <= cy; by += 1) {
      for (let bz = cz - rz - pad; bz <= cz + rz + pad; bz += 1) {
        const id = chunk.blocks[chunk.index(bx, by, bz)];
        if (id !== BlockId.STONE && id !== BlockId.DIRT && id !== BlockId.GRASS) return;
      }
    }
  }

  // Carve the lower half only: inner core (d < 0.55) becomes lava, the
  // outer shell of the same ellipsoid becomes stone - the visible rim,
  // widest exactly at by=cy (ground level), so looking down shows an open
  // lava pool ringed by stone.
  for (let bx = cx - rx; bx <= cx + rx; bx += 1) {
    const xd = (bx - cx) / rx;
    for (let by = cy - ry; by <= cy; by += 1) {
      const yd = (by - cy) / ry;
      for (let bz = cz - rz; bz <= cz + rz; bz += 1) {
        const zd = (bz - cz) / rz;
        const d = xd * xd + yd * yd + zd * zd;
        if (d >= 1) continue;
        chunk.blocks[chunk.index(bx, by, bz)] = d < 0.55 ? BlockId.LAVA : BlockId.STONE;
      }
    }
  }
}

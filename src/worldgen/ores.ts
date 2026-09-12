import { BlockId } from '../block';
import { CHUNK_SIZE, CHUNK_HEIGHT } from './constants';
import { hashSeed, mulberry32 } from './rng';
import type { ChunkWriter } from './types';

/**
 * Ore veins, ported from Minecraft LCE OreFeature + BiomeDecorator::decorateOres.
 * `veinSize` = LCE `count`; `tries` = attempts per 16x16 chunk; Y band scaled to
 * EvlyMC's shorter world (rescaled ~1.7x from the old CHUNK_MAX_Y=75 tuning,
 * keeping each ore's relative depth band the same fraction of the world).
 */
const ORE_VEINS: { id: BlockId; veinSize: number; tries: number; minY: number; maxY: number }[] = [
  { id: BlockId.COAL_ORE, veinSize: 16, tries: 20, minY: 5, maxY: 116 },
  { id: BlockId.IRON_ORE, veinSize: 9, tries: 20, minY: 5, maxY: 77 },
  { id: BlockId.GOLD_ORE, veinSize: 9, tries: 3, minY: 5, maxY: 48 },
  { id: BlockId.REDSTONE_ORE, veinSize: 8, tries: 8, minY: 4, maxY: 27 },
  { id: BlockId.DIAMOND_ORE, veinSize: 8, tries: 1, minY: 4, maxY: 27 },
  { id: BlockId.LAPIS_ORE, veinSize: 7, tries: 2, minY: 8, maxY: 44 },
  { id: BlockId.EMERALD_ORE, veinSize: 4, tries: 3, minY: 6, maxY: 61 },
];

export function generateOres(chunk: ChunkWriter): void {
  const rng = mulberry32(hashSeed(chunk.chunkX, chunk.chunkZ, chunk.seed));
  const rngInt = (n: number) => Math.floor(rng() * n);

  for (const ore of ORE_VEINS) {
    for (let t = 0; t < ore.tries; t += 1) {
      const x = chunk.minX + rngInt(CHUNK_SIZE);
      const z = chunk.minZ + rngInt(CHUNK_SIZE);
      const y = ore.minY + rngInt(ore.maxY - ore.minY);
      placeOreVein(chunk, ore.id, x, y, z, ore.veinSize, rng);
    }
  }
}

/** One lens-shaped blob of ore that only replaces stone (LCE OreFeature::place). */
function placeOreVein(chunk: ChunkWriter, id: BlockId, cx: number, cy: number, cz: number, count: number, rng: () => number): void {
  const angle = rng() * Math.PI;
  const spanX = (Math.sin(angle) * count) / 8;
  const spanZ = (Math.cos(angle) * count) / 8;
  const x0 = cx + spanX, x1 = cx - spanX;
  const z0 = cz + spanZ, z1 = cz - spanZ;
  const y0 = cy + (Math.floor(rng() * 3) - 2);
  const y1 = cy + (Math.floor(rng() * 3) - 2);

  for (let d = 0; d <= count; d += 1) {
    const xx = x0 + ((x1 - x0) * d) / count;
    const yy = y0 + ((y1 - y0) * d) / count;
    const zz = z0 + ((z1 - z0) * d) / count;
    const ss = (rng() * count) / 16;
    const r = (Math.sin((d * Math.PI) / count) + 1) * ss + 1;
    const half = r / 2;

    for (let bx = Math.floor(xx - half); bx <= Math.floor(xx + half); bx += 1) {
      if (bx < chunk.minX || bx >= chunk.minX + CHUNK_SIZE) continue;
      const xd = (bx + 0.5 - xx) / half;
      if (xd * xd >= 1) continue;
      for (let by = Math.floor(yy - half); by <= Math.floor(yy + half); by += 1) {
        if (by < 1 || by >= CHUNK_HEIGHT) continue;
        const yd = (by + 0.5 - yy) / half;
        if (xd * xd + yd * yd >= 1) continue;
        for (let bz = Math.floor(zz - half); bz <= Math.floor(zz + half); bz += 1) {
          if (bz < chunk.minZ || bz >= chunk.minZ + CHUNK_SIZE) continue;
          const zd = (bz + 0.5 - zz) / half;
          if (xd * xd + yd * yd + zd * zd >= 1) continue;
          if (chunk.blocks[chunk.index(bx, by, bz)] === BlockId.STONE) {
            chunk.setBlockData(bx, by, bz, id);
          }
        }
      }
    }
  }
}

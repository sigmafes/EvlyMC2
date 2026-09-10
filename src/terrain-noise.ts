import { fbm2D } from './noise';

/**
 * Terrain height + tree density from analytic noise (seeded), so the world can
 * extend infinitely in any direction. Same `sample` / `sampleTreeDensity`
 * contract as the old bitmap-based version.
 */
export class TerrainNoise {
  constructor(private readonly seed: number) {}

  /** Kept for callers that still `await TerrainNoise.load()`. */
  static async load(seed = 0): Promise<TerrainNoise> {
    return new TerrainNoise(seed);
  }

  /** Surface height for a world column. Roughly 40..78 before the chunk clamp. */
  sample(worldX: number, worldZ: number): number {
    // Broad continent shape (large cells), redistributed to flatten plains and
    // sharpen coastlines.
    let continent = fbm2D(worldX * 0.0032, worldZ * 0.0032, this.seed, 4);
    continent = continent * continent * (3 - 2 * continent);
    // Local rolling detail.
    const detail = fbm2D(worldX * 0.015, worldZ * 0.015, (this.seed ^ 0x9e37) | 0, 3);
    return 40 + continent * 30 + detail * 8;
  }

  /** 0..1, higher = denser forest (matches the old "darkness" meaning). */
  sampleTreeDensity(worldX: number, worldZ: number): number {
    return fbm2D(worldX * 0.02, worldZ * 0.02, (this.seed ^ 0x5bd1) | 0, 3);
  }
}

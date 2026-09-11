import { fbm2D } from './noise';

/**
 * Terrain height + tree density from analytic noise (seeded), so the world can
 * extend infinitely in any direction. Same `sample` / `sampleTreeDensity`
 * contract as the old bitmap-based version.
 */
export class TerrainNoise {
  // Terrain height went from 7 to 20 noise octaves per column once mountains
  // and rivers landed, and sample() gets called repeatedly for the exact
  // same (x,z) - once per surface-patch footprint cell in chunk.ts, and
  // again at runtime from world.ts's getSurfaceHeight() (mob spawning,
  // findSpawnPoint's up-to-512-radius ring scan). Memoizing here fixes all
  // of those call sites at once instead of threading a cache through each
  // one. Same deterministic (seed,x,z)->height contract, just remembered.
  private readonly heightCache = new Map<string, number>();
  private static readonly CACHE_LIMIT = 20000; // a few dozen chunks' worth of columns

  constructor(private readonly seed: number) {}

  /** Kept for callers that still `await TerrainNoise.load()`. */
  static async load(seed = 0): Promise<TerrainNoise> {
    return new TerrainNoise(seed);
  }

  /**
   * Surface height for a world column. Roughly 48..128 before the chunk
   * clamp - base rolling terrain (48..88) plus an independent mountain
   * contribution (see mountainHeight()) that can push the top of a ridge up
   * to the world's generation ceiling, and a river carve that pulls a
   * winding band of columns down toward WATER_LEVEL (see riverMask()).
   */
  sample(worldX: number, worldZ: number): number {
    const key = `${worldX},${worldZ}`;
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;

    // Broad continent shape (large cells), redistributed to flatten plains and
    // sharpen coastlines.
    let continent = fbm2D(worldX * 0.003, worldZ * 0.003, this.seed, 4);
    continent = continent * continent * (3 - 2 * continent);
    // Local rolling detail.
    const detail = fbm2D(worldX * 0.015, worldZ * 0.015, (this.seed ^ 0x9e37) | 0, 3);
    const base = 48 + continent * 32 + detail * 8;

    const river = this.riverMask(worldX, worldZ);
    let mountain = this.mountainHeight(worldX, worldZ);
    mountain *= 1 - river; // don't let a ridge cancel a river cut through it

    const height = base + mountain - river * 10;
    // No real LRU bookkeeping - just a size cap that resets the whole cache
    // once hit, cheap and good enough since generation/spawn-scan access
    // patterns are heavily localized (nearby columns get re-requested far
    // more than distant ones ever get evicted-then-needed-again).
    if (this.heightCache.size >= TerrainNoise.CACHE_LIMIT) this.heightCache.clear();
    this.heightCache.set(key, height);
    return height;
  }

  /**
   * Mountains, independent of any biome (there's no biome system yet - this
   * is a standalone noise layer that just adds relief in some regions and
   * nothing in others, so it can coexist with per-biome height tuning
   * later). Two channels: `mask` (very low frequency) picks WHERE mountains
   * exist at all - zero over roughly the bottom 55% of its own noise range,
   * ramping up smoothly (not a hard cutoff) above that, so there's no cliff
   * at the edge of a mountain region. `ridge` folds ordinary noise into a
   * "ridge" shape (peaks where the underlying noise crosses its own
   * midpoint) instead of round hills, so mountains actually look jagged.
   */
  private mountainHeight(worldX: number, worldZ: number): number {
    const maskRaw = fbm2D(worldX * 0.0015, worldZ * 0.0015, (this.seed ^ 0x0a17) | 0, 4);
    const mask = Math.max(0, (maskRaw - 0.55) / 0.45);
    if (mask <= 0) return 0; // ~55% of the map bails here, skipping ridge's 5 octaves entirely
    const ridgeRaw = fbm2D(worldX * 0.01, worldZ * 0.01, (this.seed ^ 0x02b1) | 0, 5);
    const ridge = 1 - Math.abs(ridgeRaw * 2 - 1);
    return mask * Math.pow(ridge, 1.5) * 55;
  }

  /**
   * 0..1, 1 exactly on a river's centreline and fading to 0 within
   * RIVER_WIDTH (noise-space units) either side - the standard "river where
   * noise crosses its own midpoint" trick, cheap and seed-deterministic like
   * everything else here, no river graph/pathing needed.
   */
  private riverMask(worldX: number, worldZ: number): number {
    const RIVER_WIDTH = 0.06;
    const n = fbm2D(worldX * 0.004, worldZ * 0.004, (this.seed ^ 0x8123) | 0, 4);
    const dist = Math.abs(n * 2 - 1);
    return Math.max(0, 1 - dist / RIVER_WIDTH);
  }

  /** 0..1, higher = denser forest (matches the old "darkness" meaning). */
  sampleTreeDensity(worldX: number, worldZ: number): number {
    return fbm2D(worldX * 0.02, worldZ * 0.02, (this.seed ^ 0x5bd1) | 0, 3);
  }
}

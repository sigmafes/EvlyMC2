import { Chunk, CHUNK_SIZE } from '../../src/chunk';
import { TerrainNoise } from '../../src/terrain-noise';
import { BlockId, isSolidBlock } from '../../src/block';

/**
 * Real terrain generation for the world server - the same deterministic,
 * seeded generator the client uses (Chunk + TerrainNoise + the worldgen/*
 * passes), running fully headless: Chunk's constructor now accepts
 * `null`/`null` for scene/materials (see chunk.ts) and simply skips building
 * any Subchunk mesh, since block generation itself never touched THREE at
 * all - only the mesh-building step at the very end of the constructor did.
 *
 * Chunks are generated lazily and cached in memory for this DO instance's
 * lifetime (regenerating from the seed is cheap and deterministic, so there's
 * no need to persist them - only player-made edits need persisting, and
 * those are layered on top by world-do.ts's own `edits` map exactly like
 * before, taking priority over whatever this returns).
 */
export class ServerTerrain {
  private readonly chunks = new Map<string, Chunk>();
  private readonly noise: TerrainNoise;

  constructor(private readonly seed: number) {
    this.noise = new TerrainNoise(seed);
  }

  /** Chunk.ts's own convention: a chunk's blocks span [chunkX*CHUNK_SIZE-8, +CHUNK_SIZE). */
  private chunkCoordOf(x: number, z: number): [number, number] {
    return [Math.floor((x + 8) / CHUNK_SIZE), Math.floor((z + 8) / CHUNK_SIZE)];
  }

  private ensureChunk(cx: number, cz: number): Chunk {
    const key = `${cx},${cz}`;
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(
        null, null, cx, cz,
        (x, y, z) => this.getBlock(x, y, z), // cross-chunk reads during generation (caves/trees near an edge) - AIR for a not-yet-generated neighbour, same tolerance singleplayer already has
        this.noise.sample.bind(this.noise),
        this.noise,
        this.seed,
      );
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Block at a world position - generates its owning chunk on first access. */
  getBlock(x: number, y: number, z: number): BlockId {
    const [cx, cz] = this.chunkCoordOf(x, z);
    const key = `${cx},${cz}`;
    const chunk = this.chunks.get(key);
    // Deliberately does NOT generate on a miss here - only ensureChunk() (via
    // isSolid()/surfaceHeight() below) does, so a worldgen pass reading a
    // neighbour mid-generation can't recursively trigger more generation.
    if (!chunk) return BlockId.AIR;
    return chunk.getBlock(x, y, z);
  }

  isSolid(x: number, y: number, z: number): boolean {
    const [cx, cz] = this.chunkCoordOf(x, z);
    this.ensureChunk(cx, cz);
    return isSolidBlock(this.getBlock(x, y, z));
  }

  /** Terrain height (pre-chunk-clamp) at a column - for picking a spawn point clear of the ground. */
  surfaceHeight(x: number, z: number): number {
    return this.noise.sample(x, z);
  }

  setBlock(x: number, y: number, z: number, id: BlockId): void {
    const [cx, cz] = this.chunkCoordOf(x, z);
    const chunk = this.ensureChunk(cx, cz);
    chunk.setBlockData(x, y, z, id);
  }
}

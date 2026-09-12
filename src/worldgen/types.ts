import type { BlockId } from '../block';
import type { TerrainNoise } from '../terrain-noise';

/**
 * Exactly what a worldgen feature (caves, ravines, ores, ...) needs from a
 * `Chunk` to carve/place into it - `Chunk` satisfies this structurally, no
 * explicit wiring needed per feature. `blocks`/`index` are exposed directly
 * (not just `setBlockData`) because most features write thousands of voxels
 * per chunk and go straight at the array in their hot loops, same as they did
 * as private Chunk methods before this split.
 */
export interface ChunkWriter {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly minX: number;
  readonly minZ: number;
  readonly seed: number;
  readonly blocks: Uint8Array;
  readonly terrainNoise: TerrainNoise;
  index(x: number, y: number, z: number): number;
  /** Raw write, no bounds/collision checks - only valid for cells known to be inside this chunk. */
  setBlockData(x: number, y: number, z: number, id: BlockId): void;
  /** Bounds-checked write that also extends the tracked surface height (used by tree placement). */
  placeBlock(x: number, y: number, z: number, id: BlockId): void;
  getTerrainHeight(x: number, z: number): number;
}

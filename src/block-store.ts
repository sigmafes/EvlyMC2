import { BlockId } from './block';
import { CHUNK_SIZE, Chunk } from './chunk';

/**
 * Pure block data access layer.
 * No side effects, no notifications.
 * Responsible only for reading/writing block data.
 */
export class BlockStore {
  constructor(private readonly chunks: Map<string, Chunk>) {}

  getBlock(x: number, y: number, z: number, isInsideWorld: boolean): BlockId {
    if (!isInsideWorld) return BlockId.AIR;
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    return chunk?.getBlock(x, y, z) ?? BlockId.AIR;
  }

  /**
   * Set block without notifications or side effects.
   * Caller is responsible for notifying light/water engines.
   */
  setBlockRaw(x: number, y: number, z: number, id: BlockId): boolean {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    return chunk?.setBlock(x, y, z, id) ?? false;
  }

  addBlockRaw(x: number, y: number, z: number, id: BlockId): boolean {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    return chunk?.add(x, y, z, id) ?? false;
  }

  removeBlockRaw(x: number, y: number, z: number): boolean {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    return chunk?.remove(x, y, z) ?? false;
  }

  getLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number, minY: number, maxY: number): number {
    if (y < minY || y >= maxY) return 0;
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    return chunk?.getLight(channel, x, y, z) ?? 0;
  }

  setLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number, level: number): boolean {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    const chunk = this.chunks.get(this.key(chunkX, chunkZ));
    if (!chunk) return false;
    chunk.setLight(channel, x, y, z, level);
    return true;
  }

  /** Flag the subchunk holding this voxel for a mesh rebuild (no data change). */
  markDirty(x: number, y: number, z: number) {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    this.chunks.get(this.key(chunkX, chunkZ))?.markLightDirty(x, y, z);
  }

  isChunkLoaded(x: number, z: number): boolean {
    const chunkX = this.getChunkCoordinate(x);
    const chunkZ = this.getChunkCoordinate(z);
    return this.chunks.has(this.key(chunkX, chunkZ));
  }

  getChunkCoordinate(value: number): number {
    return Math.floor((value + 8) / CHUNK_SIZE);
  }

  private key(x: number, z: number): string {
    return `${x},${z}`;
  }
}

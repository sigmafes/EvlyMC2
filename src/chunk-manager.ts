import * as THREE from 'three';
import { CHUNK_SIZE, Chunk, BlockCollider } from './chunk';
import type { BlockId, BlockMaterials } from './block';
import type { TerrainNoise } from './terrain-noise';

export type ChunkManagerConfig = {
  viewRadius: number;
  seed: number;
};

/**
 * Manages chunk lifecycle: loading, unloading, and queries.
 * Responsible for which chunks are in memory and their state.
 */
export class ChunkManager {
  readonly chunks = new Map<string, Chunk>();
  private centerChunkX = Number.NaN;
  private centerChunkZ = Number.NaN;
  private readonly wantedChunkKeys = new Set<string>();
  private readonly pendingChunkKeys = new Set<string>();
  private readonly config: ChunkManagerConfig;
  private viewRadius: number;

  constructor(config: ChunkManagerConfig) {
    this.config = config;
    this.viewRadius = config.viewRadius;
  }

  /** Change render distance (in chunks); forces the wanted set to be recomputed. */
  setViewRadius(chunks: number) {
    this.viewRadius = chunks;
    this.centerChunkX = Number.NaN;
    this.centerChunkZ = Number.NaN;
  }

  /**
   * Called when player moves.
   * Queues chunks for loading/unloading based on view radius.
   */
  updateLoadedChunks(
    playerX: number,
    playerZ: number,
    onChunkDisposed: (chunk: Chunk, chunkX: number, chunkZ: number) => void,
  ) {
    const centerX = this.getChunkCoordinate(playerX);
    const centerZ = this.getChunkCoordinate(playerZ);

    if (centerX === this.centerChunkX && centerZ === this.centerChunkZ) {
      return;
    }

    this.centerChunkX = centerX;
    this.centerChunkZ = centerZ;
    this.wantedChunkKeys.clear();

    const firstX = centerX - this.viewRadius;
    const lastX = centerX + this.viewRadius;
    const firstZ = centerZ - this.viewRadius;
    const lastZ = centerZ + this.viewRadius;

    for (let x = firstX; x <= lastX; x += 1) {
      for (let z = firstZ; z <= lastZ; z += 1) {
        this.wantedChunkKeys.add(this.key(x, z));
      }
    }

    // Remove unwanted chunks
    for (const key of this.chunks.keys()) {
      if (!this.wantedChunkKeys.has(key)) {
        const chunk = this.chunks.get(key)!;
        this.chunks.delete(key);
        const [x, z] = key.split(',').map(Number);
        onChunkDisposed(chunk, x, z);
      }
    }

    // Update pending queue
    for (const key of this.pendingChunkKeys) {
      if (!this.wantedChunkKeys.has(key)) {
        this.pendingChunkKeys.delete(key);
      }
    }
    for (const key of this.wantedChunkKeys) {
      if (!this.chunks.has(key)) {
        this.pendingChunkKeys.add(key);
      }
    }
  }

  /**
   * Load one pending chunk, prioritizing by distance to center.
   */
  loadNextPendingChunk(
    scene: THREE.Scene,
    materials: BlockMaterials,
    terrainNoise: TerrainNoise,
    getBlockCallback: (x: number, y: number, z: number) => number,
    onChunkLoaded: (chunk: Chunk, chunkX: number, chunkZ: number) => void,
    getEdits: (chunkX: number, chunkZ: number) => Map<number, BlockId> | undefined = () => undefined,
  ) {
    const nextKey = [...this.pendingChunkKeys]
      .sort((a, b) => {
        const [ax, az] = a.split(',').map(Number);
        const [bx, bz] = b.split(',').map(Number);
        const distA = (ax - this.centerChunkX) ** 2 + (az - this.centerChunkZ) ** 2;
        const distB = (bx - this.centerChunkX) ** 2 + (bz - this.centerChunkZ) ** 2;
        return distA - distB;
      })[0];

    if (!nextKey) return false;

    this.pendingChunkKeys.delete(nextKey);
    if (!this.wantedChunkKeys.has(nextKey) || this.chunks.has(nextKey)) {
      return false;
    }

    const [x, z] = nextKey.split(',').map(Number);
    const chunk = new Chunk(
      scene,
      materials,
      x,
      z,
      getBlockCallback,
      terrainNoise.sample.bind(terrainNoise),
      terrainNoise,
      this.config.seed,
      getEdits(x, z),
    );
    this.chunks.set(nextKey, chunk);
    onChunkLoaded(chunk, x, z);
    return true;
  }

  getChunk(x: number, z: number): Chunk | undefined {
    return this.chunks.get(this.key(x, z));
  }

  getMeshObjects() {
    return [...this.chunks.values()].flatMap((chunk) => chunk.getMeshObjects());
  }

  getCollidersInBounds(
    minX: number,
    maxX: number,
    minY: number,
    maxY: number,
    minZ: number,
    maxZ: number,
  ): BlockCollider[] {
    const colliders: BlockCollider[] = [];
    for (const chunk of this.chunks.values()) {
      colliders.push(...chunk.getCollidersInBounds(minX, maxX, minY, maxY, minZ, maxZ));
    }
    return colliders;
  }

  get totalBlocks() {
    return [...this.chunks.values()].reduce((total, chunk) => total + chunk.totalBlocks, 0);
  }

  get visibleSubchunks() {
    return [...this.chunks.values()].reduce((total, chunk) => total + chunk.visibleCount, 0);
  }

  private getChunkCoordinate(value: number): number {
    return Math.floor((value + 8) / CHUNK_SIZE);
  }

  private key(x: number, z: number): string {
    return `${x},${z}`;
  }
}

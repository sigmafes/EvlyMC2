import * as THREE from 'three';
import { BlockId, BlockMaterials, isSolidBlock } from './block';
import { ChunkLightData } from './chunk-light-data';
import { SUBCHUNK_HEIGHT, Subchunk } from './subchunk';
import type { LightReader, WaterDistanceReader, WaterFlowReader, BlockDataReader } from './mesher';
import { isShapedBlock, shapeBoxesFor } from './block-shapes';
import type { TerrainNoise } from './terrain-noise';
import type { ChunkWriter } from './worldgen/types';
import { generateCaves } from './worldgen/caves';
import { generateRavines } from './worldgen/ravines';
import { generateOres } from './worldgen/ores';
import { generateLavaLakes } from './worldgen/lava-lakes';
import { generateSurfacePatches } from './worldgen/surface-patches';
import { generateTrees } from './worldgen/trees';

import { CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_MIN_Y, CHUNK_MAX_Y, WATER_LEVEL } from './worldgen/constants';
export { CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_MIN_Y, CHUNK_MAX_Y, WATER_LEVEL };

export type BlockCollider = {
  id: BlockId;
  x: number;
  y: number;
  z: number;
  collider: THREE.Box3;
};

export type WorldBlockReader = (x: number, y: number, z: number) => BlockId;
export type TerrainHeightReader = (x: number, z: number) => number;

export class Chunk implements ChunkWriter {
  readonly blocks: Uint8Array;
  readonly light = new ChunkLightData(CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE);
  readonly subchunks: Subchunk[] = [];
  readonly minX: number;
  readonly minZ: number;
  private readonly maxY = CHUNK_HEIGHT - 1;
  private readonly dirtySubchunks = new Set<number>();
  /** Kept alongside the subchunks' copy so collision can read stair/slab orientation too. */
  private readBlockData: BlockDataReader = () => undefined;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly materials: BlockMaterials,
    readonly chunkX: number,
    readonly chunkZ: number,
    private readonly readWorldBlock: WorldBlockReader,
    readonly getTerrainHeight: TerrainHeightReader,
    readonly terrainNoise: TerrainNoise,
    readonly seed: number,
    edits?: Map<number, BlockId>,
  ) {
    this.minX = chunkX * CHUNK_SIZE - 8;
    this.minZ = chunkZ * CHUNK_SIZE - 8;
    this.blocks = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT * CHUNK_SIZE);
    this.generate();
    if (edits) {
      // Player edits win over generated terrain.
      for (const [idx, id] of edits) this.blocks[idx] = id;
    }
    for (let minY = 0; minY < CHUNK_HEIGHT; minY += SUBCHUNK_HEIGHT) {
      const maxY = Math.min(minY + SUBCHUNK_HEIGHT - 1, this.maxY);
      this.subchunks.push(new Subchunk(scene, materials, this.getBlock.bind(this), minY, maxY, this.minX, this.minZ, false));
      this.dirtySubchunks.add(this.subchunks.length - 1);
    }
  }

  index(x: number, y: number, z: number) {
    return (y * CHUNK_SIZE + (z - this.minZ)) * CHUNK_SIZE + (x - this.minX);
  }

  private isInside(x: number, y: number, z: number) {
    return x >= this.minX && x < this.minX + CHUNK_SIZE && y >= 0 && y <= this.maxY && z >= this.minZ && z < this.minZ + CHUNK_SIZE;
  }

  getBlock(x: number, y: number, z: number): BlockId {
    if (this.isInside(x, y, z)) return this.blocks[this.index(x, y, z)] as BlockId;
    if (y < 0 || y > this.maxY) return BlockId.AIR;
    return this.readWorldBlock(x, y, z);
  }

  private generate() {
    for (let x = this.minX; x < this.minX + CHUNK_SIZE; x += 1) {
      for (let z = this.minZ; z < this.minZ + CHUNK_SIZE; z += 1) {
        const surfaceY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(this.getTerrainHeight(x, z))));
        const isWaterBody = surfaceY <= WATER_LEVEL;
        const topY = Math.max(surfaceY, WATER_LEVEL);
        this.light.setSurfaceHeight(x - this.minX, z - this.minZ, isWaterBody ? WATER_LEVEL : surfaceY);
        this.setBlockData(x, 0, z, BlockId.BEDROCK);

        // Bedrock to Stone
        for (let y = 1; y < surfaceY - 4; y += 1) {
          this.setBlockData(x, y, z, BlockId.STONE);
        }

        // Subsurface layers (dirt or sand/gravel)
        if (isWaterBody) {
          // Under water: always gravel (both layers touching the water),
          // then dirt underneath - sand is reserved for the shore, never
          // generated underwater any more.
          for (let y = surfaceY - 4; y < surfaceY - 1; y += 1) {
            if (y > 0) this.setBlockData(x, y, z, BlockId.DIRT);
          }
          for (let y = Math.max(1, surfaceY - 1); y <= surfaceY; y += 1) {
            this.setBlockData(x, y, z, BlockId.GRAVEL);
          }
          // Water column from surfaceY + 1 up to WATER_LEVEL
          for (let y = surfaceY + 1; y <= WATER_LEVEL; y += 1) {
            this.setBlockData(x, y, z, BlockId.WATER);
          }
        } else if (surfaceY <= WATER_LEVEL + 2) {
          // Shore around water: within 2 blocks above water level is sand
          for (let y = surfaceY - 4; y < surfaceY - 1; y += 1) {
            if (y > 0) this.setBlockData(x, y, z, BlockId.DIRT);
          }
          for (let y = Math.max(1, surfaceY - 1); y <= surfaceY; y += 1) {
            this.setBlockData(x, y, z, BlockId.SAND);
          }
        } else {
          // Normal dry ground
          for (let y = surfaceY - 4; y < surfaceY; y += 1) {
            this.setBlockData(x, y, z, BlockId.DIRT);
          }
          this.setBlockData(x, surfaceY, z, BlockId.GRASS);
        }
      }
    }

    generateCaves(this);
    generateRavines(this);
    generateOres(this);
    generateLavaLakes(this);
    generateSurfacePatches(this);
    generateTrees(this);
  }

  /** Raw write, no bounds/collision checks - only valid for cells known to be inside this chunk (base terrain gen, worldgen/* features). */
  setBlockData(x: number, y: number, z: number, id: BlockId) {
    this.blocks[this.index(x, y, z)] = id;
  }

  /** Bounds-checked write that also extends the tracked surface height (used by worldgen/trees.ts). */
  placeBlock(x: number, y: number, z: number, id: BlockId) {
    if (y >= 0 && y < CHUNK_HEIGHT && this.isInside(x, y, z)) {
      const current = this.getBlock(x, y, z);
      if (current === BlockId.AIR || (id === BlockId.OAK_LOG && current === BlockId.OAK_LEAVES)) {
        this.setBlockData(x, y, z, id);
        if (y > this.light.getSurfaceHeight(x - this.minX, z - this.minZ)) {
          this.light.setSurfaceHeight(x - this.minX, z - this.minZ, y);
        }
      }
    }
  }

  getLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number) {
    return this.light.get(channel, x - this.minX, y, z - this.minZ);
  }

  setLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number, level: number) {
    this.light.set(channel, x - this.minX, y, z - this.minZ, level);
  }

  setLightReader(readLight: LightReader) {
    for (const subchunk of this.subchunks) subchunk.setLightReader(readLight);
  }

  setWaterDistanceReader(readWaterDistance: WaterDistanceReader) {
    for (const subchunk of this.subchunks) subchunk.setWaterDistanceReader(readWaterDistance);
  }

  setWaterFlowReader(readWaterFlow: WaterFlowReader) {
    for (const subchunk of this.subchunks) subchunk.setWaterFlowReader(readWaterFlow);
  }

  setBlockDataReader(readBlockData: BlockDataReader) {
    this.readBlockData = readBlockData;
    for (const subchunk of this.subchunks) subchunk.setBlockDataReader(readBlockData);
  }

  setSmoothLighting(enabled: boolean) {
    for (const subchunk of this.subchunks) subchunk.setSmoothLighting(enabled);
  }

  setAmbientOcclusion(enabled: boolean) {
    for (const subchunk of this.subchunks) subchunk.setAmbientOcclusion(enabled);
  }

  markLightDirty(_x: number, y: number, _z: number) {
    this.markDirty(0, y - 1, 0);
    this.markDirty(0, y, 0);
    this.markDirty(0, y + 1, 0);
  }

  getSurfaceHeight(x: number, z: number) {
    return this.light.getSurfaceHeight(x - this.minX, z - this.minZ);
  }

  add(x: number, y: number, z: number, id: BlockId) {
    if (!this.isInside(x, y, z)) return false;
    const current = this.getBlock(x, y, z);
    if (current !== BlockId.AIR && current !== BlockId.WATER && current !== BlockId.LAVA) return false;
    this.setBlockData(x, y, z, id);
    if (y > this.getSurfaceHeight(x, z)) this.light.setSurfaceHeight(x - this.minX, z - this.minZ, y);
    this.markDirty(x, y, z);
    return true;
  }

  setBlock(x: number, y: number, z: number, id: BlockId) {
    if (!this.isInside(x, y, z)) return false;
    const current = this.getBlock(x, y, z);
    if (current === id) return false;
    this.setBlockData(x, y, z, id);
    if (id !== BlockId.AIR && y > this.getSurfaceHeight(x, z)) {
      this.light.setSurfaceHeight(x - this.minX, z - this.minZ, y);
    } else if (id === BlockId.AIR && y === this.getSurfaceHeight(x, z)) {
      this.refreshSurfaceHeight(x, z);
    }
    this.markDirty(x, y, z);
    return true;
  }

  remove(x: number, y: number, z: number) {
    const current = this.getBlock(x, y, z);
    if (!this.isInside(x, y, z) || current === BlockId.AIR || current === BlockId.BEDROCK) return false;
    this.setBlockData(x, y, z, BlockId.AIR);
    if (y === this.getSurfaceHeight(x, z)) this.refreshSurfaceHeight(x, z);
    this.markDirty(x, y, z);
    return true;
  }

  getMeshObjects() { return this.subchunks.map((subchunk) => subchunk.mesh); }

  get bounds() {
    return new THREE.Box3(
      new THREE.Vector3(this.minX - 0.5, -0.5, this.minZ - 0.5),
      new THREE.Vector3(this.minX + CHUNK_SIZE - 0.5, CHUNK_HEIGHT - 0.5, this.minZ + CHUNK_SIZE - 0.5),
    );
  }

  getCollidersInBounds(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): BlockCollider[] {
    const colliders: BlockCollider[] = [];
    for (let y = Math.floor(minY); y <= Math.ceil(maxY); y += 1) {
      for (let z = Math.floor(minZ); z <= Math.ceil(maxZ); z += 1) {
        for (let x = Math.floor(minX); x <= Math.ceil(maxX); x += 1) {
          const id = this.getBlock(x, y, z);
          if (!isSolidBlock(id)) continue;
          // Stairs/slabs collide as the same sub-boxes they're drawn from, so
          // you can walk up a step instead of bumping into a full cube.
          const boxes = isShapedBlock(id)
            ? shapeBoxesFor(id, x, y, z, (bx, by, bz) => this.getBlock(bx, by, bz), this.readBlockData)
            : null;
          if (boxes) {
            for (const b of boxes) {
              colliders.push({
                id, x, y, z,
                collider: new THREE.Box3(
                  new THREE.Vector3(x - 0.5 + b.x0, y - 0.5 + b.y0, z - 0.5 + b.z0),
                  new THREE.Vector3(x - 0.5 + b.x1, y - 0.5 + b.y1, z - 0.5 + b.z1),
                ),
              });
            }
            continue;
          }
          colliders.push({ id, x, y, z, collider: new THREE.Box3(new THREE.Vector3(x - 0.5, y - 0.5, z - 0.5), new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5)) });
        }
      }
    }
    return colliders;
  }

  updateCulling(camera: THREE.Camera, renderDistance: number) {
    const maxDistanceSquared = renderDistance * renderDistance;
    for (const subchunk of this.subchunks) subchunk.visible = subchunk.center.distanceToSquared(camera.position) <= maxDistanceSquared;
  }

  get visibleCount() { return this.subchunks.filter((subchunk) => subchunk.visible).length; }
  get totalBlocks() { return this.blocks.reduce((total, block) => total + (block === BlockId.AIR ? 0 : 1), 0); }

  rebuild() {
    for (const subchunk of this.subchunks) subchunk.rebuild();
  }

  rebuildDirty(limit = Infinity, preferredY = 0) {
    let rebuilt = 0;
    const ordered = [...this.dirtySubchunks].sort((a, b) => {
      const aCenter = (this.subchunks[a]?.minY ?? 0) + SUBCHUNK_HEIGHT / 2;
      const bCenter = (this.subchunks[b]?.minY ?? 0) + SUBCHUNK_HEIGHT / 2;
      return Math.abs(aCenter - preferredY) - Math.abs(bCenter - preferredY);
    });
    for (const index of ordered) {
      if (rebuilt >= limit) break;
      this.dirtySubchunks.delete(index);
      this.subchunks[index]?.rebuild();
      rebuilt += 1;
    }
    return rebuilt;
  }

  markAllDirty() {
    for (let index = 0; index < this.subchunks.length; index += 1) this.dirtySubchunks.add(index);
  }

  get pendingDirtySubchunks() { return this.dirtySubchunks.size; }

  dispose() {
    for (const subchunk of this.subchunks) subchunk.dispose();
  }

  private markDirty(x: number, y: number, z: number) {
    const index = Math.floor(y / SUBCHUNK_HEIGHT);
    this.dirtySubchunks.add(index);
    if (y % SUBCHUNK_HEIGHT === 0) this.dirtySubchunks.add(index - 1);
    if (y % SUBCHUNK_HEIGHT === SUBCHUNK_HEIGHT - 1) this.dirtySubchunks.add(index + 1);
  }


  private refreshSurfaceHeight(x: number, z: number) {
    for (let y = this.maxY; y >= 0; y -= 1) {
      if (this.getBlock(x, y, z) !== BlockId.AIR) {
        this.light.setSurfaceHeight(x - this.minX, z - this.minZ, y);
        return;
      }
    }
    this.light.setSurfaceHeight(x - this.minX, z - this.minZ, 0);
  }
}

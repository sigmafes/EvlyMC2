import * as THREE from 'three';
import { BlockId, BlockMaterials, blockLightProperties, FURNACE_LIT_LIGHT } from './block';
import { isStairs } from './block-shapes';
import { BlockCollider, CHUNK_HEIGHT, CHUNK_MAX_Y, CHUNK_SIZE, WATER_LEVEL } from './chunk';
import { BlockStore } from './block-store';
import { ChunkManager } from './chunk-manager';
import { ChunkEditStore } from './chunk-edits';
import { BlockDataStore, type BlockData, type FurnaceState } from './block-data';
import { LeavesManager } from './leaves-manager';
import { TerrainNoise } from './terrain-noise';
import type { LightEngine } from './light-engine';
import type { LavaEngine, WaterEngine } from './water-engine';
import type { FireEngine } from './fire-engine';
import type { SoundManager } from './sound-manager';
import { getDrops } from './drops';

export type WorldBounds = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export class World {
  viewRadius = 5;
  // Infinite world: kept only so PlayerPhysics' optional clamp stays a no-op.
  readonly bounds: WorldBounds = { minX: -1e7, maxX: 1e7, minZ: -1e7, maxZ: 1e7 };

  get chunks() {
    return this.chunkManager.chunks;
  }

  private readonly blockStore: BlockStore;
  private readonly chunkManager: ChunkManager;
  private readonly leavesManager: LeavesManager;
  private readonly editStore: ChunkEditStore;
  private readonly blockDataStore: BlockDataStore;
  private lightEngine?: LightEngine;
  private waterEngine?: WaterEngine;
  private lavaEngine?: LavaEngine;
  private fireEngine?: FireEngine;
  private lastDirtySubchunks = 0;
  private pendingLightReason = 'idle';
  private smoothLighting = true;
  private ambientOcclusion = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly materials: BlockMaterials,
    private readonly terrainNoise: TerrainNoise,
    readonly seed: number,
    private readonly soundManager?: SoundManager,
    /** Same pattern as `soundManager`: lets leaf decay drop sticks/apples like a mined block. */
    private readonly onDrop?: (id: number, count: number, pos: THREE.Vector3) => void,
  ) {
    this.chunkManager = new ChunkManager({
      viewRadius: this.viewRadius,
      seed,
    });
    this.blockStore = new BlockStore(this.chunkManager.chunks);
    this.leavesManager = new LeavesManager();
    this.editStore = new ChunkEditStore(seed);
    this.blockDataStore = new BlockDataStore(seed);
    this.chunkManager.updateLoadedChunks(0, 0, (chunk, x, z) => {
      chunk.dispose();
      this.markAdjacentChunksDirty(x, z);
    });
  }

  /** Write any pending block edits to disk now (e.g. before leaving the world). */
  async flushEdits() {
    await this.editStore.flush();
    await this.blockDataStore.flush();
  }

  /** Load persisted player edits for this seed. Await before the game loop starts. */
  async loadPersistedEdits() {
    await this.editStore.load();
    await this.blockDataStore.load();
  }

  // --- Per-block state (facing / lit), for orientable & machine blocks --------

  getBlockData(x: number, y: number, z: number): BlockData | undefined {
    return this.blockDataStore.get(x, y, z);
  }

  /** Merge `patch` into a block's side-table state and remesh its subchunk. */
  setBlockData(x: number, y: number, z: number, patch: BlockData) {
    const litBefore = !!this.blockDataStore.get(x, y, z)?.lit;
    this.blockDataStore.set(x, y, z, patch);
    this.markBlockDirty(x, y, z);
    const litAfter = !!this.blockDataStore.get(x, y, z)?.lit;
    if (litBefore !== litAfter && this.lightEngine) {
      // A furnace turned on/off: re-propagate its block light.
      const oldBlockLight = this.getLight('blockLight', x, y, z);
      this.pendingLightReason = 'block-place';
      this.lightEngine.queueBlockUpdate(x, y, z, 0, oldBlockLight, 'furnace-lit');
    }
  }

  /** Light a block gives off. Dynamic for the furnace (only while lit). */
  emissionAt(id: BlockId, x: number, y: number, z: number): number {
    if (id === BlockId.FURNACE) {
      return this.blockDataStore.get(x, y, z)?.lit ? FURNACE_LIT_LIGHT : 0;
    }
    return blockLightProperties[id].emission;
  }

  // --- Furnace contents (slots + progress). No remesh: only `lit` changes the
  //     block's look, and that goes through setBlockData. -----------------------

  getFurnaceState(x: number, y: number, z: number): FurnaceState | undefined {
    return this.blockDataStore.get(x, y, z)?.furnace;
  }

  setFurnaceState(x: number, y: number, z: number, state: FurnaceState | undefined): void {
    this.blockDataStore.set(x, y, z, { furnace: state });
  }

  eachFurnace(cb: (x: number, y: number, z: number, state: FurnaceState) => void): void {
    this.blockDataStore.forEach((x, y, z, d) => { if (d.furnace) cb(x, y, z, d.furnace); });
  }

  /**
   * Y of the topmost generated solid block at (x, z). Clamped exactly like
   * Chunk.generate() so it agrees with the terrain that actually gets built.
   */
  getSurfaceHeight(x: number, z: number) {
    return Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(this.terrainNoise.sample(x, z))));
  }

  /**
   * A guaranteed dry-land spawn. (0, 0) is often ocean, and the terrain is
   * generated so anything at or below WATER_LEVEL gets a water column on top,
   * so we spiral outwards until we find a column that is above the waterline,
   * has land all around it (no one-block islet or shoreline spike) and leaves
   * headroom under the build ceiling.
   *
   * Purely a function of the seed, so it resolves to the same point on every
   * load and needs no persistence.
   */
  findSpawnPoint(): { x: number; y: number; z: number } {
    const MIN_GROUND = WATER_LEVEL + 2;   // clear of the water and the sandy shore
    const MAX_GROUND = CHUNK_MAX_Y - 8;   // headroom, matches the tree-placement clamp
    const MAX_RADIUS = 512;

    const isLand = (x: number, z: number) => {
      const y = this.getSurfaceHeight(x, z);
      return y >= MIN_GROUND && y <= MAX_GROUND;
    };
    // Solid ground under foot *and* around it, so we never land on a spike.
    const isSolidGround = (x: number, z: number) =>
      isLand(x, z) &&
      isLand(x + 1, z) && isLand(x - 1, z) &&
      isLand(x, z + 1) && isLand(x, z - 1);

    let best: { x: number; z: number; y: number } | null = null;

    for (let r = 0; r <= MAX_RADIUS; r += 1) {
      // Coarser sampling far out; land is almost always found in the first rings.
      const step = Math.max(1, Math.floor(r / 16));
      for (let d = -r; d <= r; d += step) {
        // The four sides of the ring at Chebyshev distance r.
        const ring: [number, number][] = r === 0
          ? [[0, 0]]
          : [[d, -r], [d, r], [-r, d], [r, d]];
        for (const [x, z] of ring) {
          if (isSolidGround(x, z)) {
            return { x, y: this.getSurfaceHeight(x, z) + 2.25, z };
          }
          // Track the highest column seen, as a fallback for pathological seeds.
          const y = this.getSurfaceHeight(x, z);
          if (!best || y > best.y) best = { x, z, y };
        }
      }
    }

    // Nothing qualified within MAX_RADIUS: use the highest column we saw, and
    // failing even that, sit on top of the waterline rather than inside it.
    if (best && best.y >= MIN_GROUND) return { x: best.x, y: best.y + 2.25, z: best.z };
    return { x: best?.x ?? 0, y: WATER_LEVEL + 3.25, z: best?.z ?? 0 };
  }

  getBlock(x: number, y: number, z: number): BlockId {
    return this.blockStore.getBlock(x, y, z, this.isInsideWorld(x, z));
  }

  /** Whether the chunk under (x,z) has actually been generated yet (chunk loading is
   *  budgeted across frames, so this can be false right after startup/a jump). */
  isChunkLoaded(x: number, z: number): boolean {
    return this.blockStore.isChunkLoaded(x, z);
  }

  getLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number) {
    return this.blockStore.getLight(channel, x, y, z, 0, CHUNK_HEIGHT);
  }

  setLight(channel: 'skyLight' | 'blockLight', x: number, y: number, z: number, level: number) {
    const changed = this.blockStore.setLight(channel, x, y, z, level);
    if (changed) {
      this.markLightDirty(x, y, z);
    }
    return changed;
  }

  attachLightEngine(lightEngine: LightEngine) {
    this.lightEngine = lightEngine;
    for (const chunk of this.chunks.values()) {
      chunk.setLightReader(lightEngine.getRawBrightness.bind(lightEngine));
      chunk.setBlockDataReader(this.getBlockData.bind(this));
    }
    this.lightEngine.rebuildLoadedChunks();
    this.rebuildMeshes();
  }

  attachWaterEngine(waterEngine: WaterEngine) {
    this.waterEngine = waterEngine;
    for (const chunk of this.chunks.values()) {
      chunk.setWaterDistanceReader(this.getLiquidDistance.bind(this));
      chunk.setWaterFlowReader(this.getWaterFlow.bind(this));
    }
  }

  getWaterDistance(x: number, y: number, z: number): number {
    return this.waterEngine?.getWaterDistance(x, y, z) ?? 0;
  }

  getLiquidDistance(id: BlockId, x: number, y: number, z: number): number {
    return id === BlockId.LAVA
      ? this.lavaEngine?.getWaterDistance(x, y, z) ?? 0
      : this.waterEngine?.getWaterDistance(x, y, z) ?? 0;
  }

  getWaterFlow(x: number, y: number, z: number): THREE.Vector3 {
    return this.waterEngine?.getWaterFlow(x, y, z) ?? new THREE.Vector3();
  }

  attachFireEngine(fireEngine: FireEngine) {
    this.fireEngine = fireEngine;
  }

  updateWater(delta: number, playerX?: number, playerZ?: number) {
    const waterChanged = this.waterEngine?.update(delta, playerX, playerZ) ?? false;
    const lavaChanged = this.lavaEngine?.update(delta, playerX, playerZ) ?? false;
    return waterChanged || lavaChanged;
  }

  updateFire(delta: number, playerX?: number, playerZ?: number) {
    return this.fireEngine?.update(delta, this.lavaEngine, playerX, playerZ) ?? false;
  }

  setBlock(x: number, y: number, z: number, id: BlockId) {
    if (!this.isInsideWorld(x, z)) return false;
    const oldSkyLight = this.getLight('skyLight', x, y, z);
    const oldBlockLight = this.getLight('blockLight', x, y, z);
    const changed = this.blockStore.setBlockRaw(x, y, z, id);
    if (changed) {
      this.pendingLightReason = 'water-flow';
      this.lightEngine?.queueBlockUpdate(x, y, z, oldSkyLight, oldBlockLight, 'water-flow');
      this.markBlockDirty(x, y, z);
      if (id === BlockId.FIRE) this.fireEngine?.onFirePlaced(x, y, z);
      else this.fireEngine?.onFireRemoved(x, y, z);
      if (id === BlockId.WATER || id === BlockId.LAVA) this.resolveLiquidInteractionAt(x, y, z);
    }
    return changed;
  }

  rebuildMeshes() {
    for (const chunk of this.chunks.values()) chunk.markAllDirty();
  }

  updateWaterAnimation(time: number) {
    this.materials.updateWaterAnimation?.(time);
  }

  setSmoothLighting(enabled: boolean) {
    if (this.smoothLighting === enabled) return;
    this.smoothLighting = enabled;
    for (const chunk of this.chunks.values()) chunk.setSmoothLighting(enabled);
    this.rebuildMeshes();
  }

  setAmbientOcclusion(enabled: boolean) {
    if (this.ambientOcclusion === enabled) return;
    this.ambientOcclusion = enabled;
    for (const chunk of this.chunks.values()) chunk.setAmbientOcclusion(enabled);
    this.rebuildMeshes();
  }

  rebuildDirtyMeshes(playerX = 0, playerY = 0, playerZ = 0, maxSubchunks = 1) {
    let rebuilt = 0;
    const chunksByDistance = [...this.chunks.values()].sort((a, b) => {
      const aDistance = (a.minX + 7.5 - playerX) ** 2 + (a.minZ + 7.5 - playerZ) ** 2;
      const bDistance = (b.minX + 7.5 - playerX) ** 2 + (b.minZ + 7.5 - playerZ) ** 2;
      return aDistance - bDistance;
    });
    for (const chunk of chunksByDistance) {
      if (rebuilt >= maxSubchunks) break;
      rebuilt += chunk.rebuildDirty(maxSubchunks - rebuilt, playerY);
    }
    this.lastDirtySubchunks = rebuilt;
    return rebuilt;
  }

  attachLavaEngine(lavaEngine: LavaEngine) {
    this.lavaEngine = lavaEngine;
    for (const chunk of this.chunks.values()) {
      chunk.setWaterDistanceReader(this.getLiquidDistance.bind(this));
      chunk.setWaterFlowReader(this.getWaterFlow.bind(this));
    }
  }

  get dirtySubchunks() { return [...this.chunks.values()].reduce((total, chunk) => total + chunk.pendingDirtySubchunks, 0); }

  add(x: number, y: number, z: number, id: BlockId) {
    if (!this.isInsideWorld(x, z)) return false;
    const oldSkyLight = this.getLight('skyLight', x, y, z);
    const oldBlockLight = this.getLight('blockLight', x, y, z);
    const changed = this.blockStore.addBlockRaw(x, y, z, id);
    if (changed) {
      const reason = id === BlockId.GLOWSTONE ? 'glowstone-place' : id === BlockId.FIRE ? 'fire-place' : 'block-place';
      this.pendingLightReason = reason;
      this.lightEngine?.queueBlockUpdate(x, y, z, oldSkyLight, oldBlockLight, reason);
      this.waterEngine?.onBlockPlaced(x, y, z, id);
      this.lavaEngine?.onBlockPlaced(x, y, z, id);
      if (id === BlockId.FIRE) this.fireEngine?.onFirePlaced(x, y, z);
      if (id === BlockId.WATER || id === BlockId.LAVA) this.resolveLiquidInteractionAt(x, y, z);
      if (id === BlockId.OAK_LEAVES) {
        this.leavesManager.addLeaf(x, y, z);
      }
      this.editStore.record(x, y, z, id);
    }
    if (changed) this.markBlockDirty(x, y, z);
    return changed;
  }

  remove(x: number, y: number, z: number) {
    if (!this.isInsideWorld(x, z)) return false;
    const oldBlock = this.getBlock(x, y, z);
    const oldSkyLight = this.getLight('skyLight', x, y, z);
    const oldBlockLight = this.getLight('blockLight', x, y, z);
    const changed = this.blockStore.removeBlockRaw(x, y, z);
    if (changed) {
      const reason = oldBlockLight > 0 ? 'glowstone-break' : 'block-break';
      this.pendingLightReason = reason;
      this.lightEngine?.queueBlockUpdate(x, y, z, oldSkyLight, oldBlockLight, reason);
      this.waterEngine?.onBlockRemoved(x, y, z);
      this.lavaEngine?.onBlockRemoved(x, y, z);
      this.fireEngine?.onFireRemoved(x, y, z);
      this.leavesManager.removeLeaf(x, y, z);
      if (oldBlock === BlockId.OAK_LOG) {
        this.leavesManager.onLogRemoved(x, y, z, (bx, by, bz) => this.getBlock(bx, by, bz));
      }
      this.blockDataStore.delete(x, y, z); // drop any facing / lit state
      if (oldBlock !== BlockId.WATER && this.hasWaterNeighbor(x, y, z)) {
        // Surgical fix for mining inside procedurally-generated ocean water:
        // ocean cells are never registered with WaterEngine (only player-placed
        // / reloaded-from-edits water becomes a simulated source), so the sim
        // has no idea a hole just opened up in it. Rather than simulating the
        // whole ocean, immediately fill this one cell with water (and persist
        // that as the edit instead of AIR) whenever it borders existing water -
        // covers the reported case without touching the simulation engine.
        this.blockStore.addBlockRaw(x, y, z, BlockId.WATER);
        this.waterEngine?.onBlockPlaced(x, y, z, BlockId.WATER);
        this.editStore.record(x, y, z, BlockId.WATER);
      } else {
        this.editStore.record(x, y, z, BlockId.AIR);
      }
    }
    if (changed) this.markBlockDirty(x, y, z);
    return changed;
  }

  private hasWaterNeighbor(x: number, y: number, z: number): boolean {
    return (
      this.getBlock(x + 1, y, z) === BlockId.WATER ||
      this.getBlock(x - 1, y, z) === BlockId.WATER ||
      this.getBlock(x, y + 1, z) === BlockId.WATER ||
      this.getBlock(x, y - 1, z) === BlockId.WATER ||
      this.getBlock(x, y, z + 1) === BlockId.WATER ||
      this.getBlock(x, y, z - 1) === BlockId.WATER
    );
  }

  processLightUpdates(budget = 4096) {
    return this.lightEngine?.processUpdates(budget) ?? false;
  }

  consumeLightUpdateReason() {
    const reason = this.pendingLightReason;
    this.pendingLightReason = 'idle';
    return reason;
  }

  updateLeavesDecay(delta: number) {
    const positionsToRemove = this.leavesManager.update((x, y, z) => this.getBlock(x, y, z), delta);
    for (const [x, y, z] of positionsToRemove) {
      // this.remove() (not the non-persisting this.setBlock()) so a decayed
      // leaf stays gone after a reload instead of the deterministic tree
      // generation putting it right back.
      this.remove(x, y, z);
      for (const drop of getDrops(BlockId.OAK_LEAVES, true)) {
        this.onDrop?.(drop.id, drop.count, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
      }
    }
  }

  getMeshObjects() {
    return this.chunkManager.getMeshObjects();
  }

  getCollidersInBounds(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): BlockCollider[] {
    return this.chunkManager.getCollidersInBounds(minX, maxX, minY, maxY, minZ, maxZ);
  }

  updateLoadedChunks(playerX: number, playerZ: number) {
    this.chunkManager.updateLoadedChunks(
      playerX,
      playerZ,
      (chunk, x, z) => {
        chunk.dispose();
        this.markAdjacentChunksDirty(x, z);
      },
    );
  }

  /** Render distance in chunks (2..8). Recomputes which chunks are loaded. */
  setViewRadius(chunks: number) {
    this.viewRadius = Math.max(2, Math.min(8, Math.round(chunks)));
    this.chunkManager.setViewRadius(this.viewRadius);
  }

  /** Build queued chunks within a per-frame time budget. Returns how many were built. */
  loadPendingChunks(budgetMs = 3, maxPerFrame = 32): number {
    const start = performance.now();
    let built = 0;
    while (built < maxPerFrame && performance.now() - start < budgetMs && this.loadNextPendingChunk()) {
      built += 1;
    }
    return built;
  }

  get totalBlocks() { return this.chunkManager.totalBlocks; }
  get visibleSubchunks() { return this.chunkManager.visibleSubchunks; }

  // Infinite world — nothing is out of bounds horizontally. A block access in an
  // ungenerated chunk still resolves to AIR / a no-op write in BlockStore.
  isInsideWorld(_x: number, _z: number) {
    return true;
  }

  private markLightDirty(x: number, y: number, z: number) {
    const chunkX = this.blockStore.getChunkCoordinate(x);
    const chunkZ = this.blockStore.getChunkCoordinate(z);
    const chunk = this.chunkManager.getChunk(chunkX, chunkZ);
    chunk?.markLightDirty(x, y, z);
    this.markEdgeNeighbors(chunkX, chunkZ, x, z, y);
  }

  private markBlockDirty(x: number, y: number, z: number) {
    const chunkX = this.blockStore.getChunkCoordinate(x);
    const chunkZ = this.blockStore.getChunkCoordinate(z);
    // The cell itself: add()/remove() already dirty it via chunk.setBlock(),
    // but a setBlockData() change (a slab doubling, a stair's facing) never
    // touches the block array, so without this its subchunk kept the old mesh
    // until some neighbouring edit happened to rebuild it.
    this.blockStore.markDirty(x, y, z);
    this.markEdgeNeighbors(chunkX, chunkZ, x, z, y);
    this.markFireNeighborsDirty(x, y, z);
    this.markStairNeighborsDirty(x, y, z);
  }

  /**
   * A stair's shape depends on the stairs in front of and behind it (that's
   * how corners form), so placing or breaking anything next to one has to
   * re-mesh it - same reason fire neighbours are marked above.
   */
  private markStairNeighborsDirty(x: number, y: number, z: number) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (isStairs(this.getBlock(nx, y, nz))) this.blockStore.markDirty(nx, y, nz);
    }
  }

  /** A fire cell's mesh depends on its neighbours (floor vs wall/ceiling fire). */
  private markFireNeighborsDirty(x: number, y: number, z: number) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (this.getBlock(nx, ny, nz) === BlockId.FIRE) this.blockStore.markDirty(nx, ny, nz);
    }
  }

  private markEdgeNeighbors(chunkX: number, chunkZ: number, x: number, z: number, y: number) {
    const localX = x - (chunkX * CHUNK_SIZE - 8);
    const localZ = z - (chunkZ * CHUNK_SIZE - 8);
    const neighbors: [number, number][] = [];
    if (localX === 0) neighbors.push([chunkX - 1, chunkZ]);
    if (localX === CHUNK_SIZE - 1) neighbors.push([chunkX + 1, chunkZ]);
    if (localZ === 0) neighbors.push([chunkX, chunkZ - 1]);
    if (localZ === CHUNK_SIZE - 1) neighbors.push([chunkX, chunkZ + 1]);
    for (const [neighborX, neighborZ] of neighbors) {
      const chunk = this.chunkManager.getChunk(neighborX, neighborZ);
      chunk?.markLightDirty(x, y, z);
    }
  }

  private markAdjacentChunksDirty(chunkX: number, chunkZ: number) {
    for (const [x, z] of [[chunkX - 1, chunkZ], [chunkX + 1, chunkZ], [chunkX, chunkZ - 1], [chunkX, chunkZ + 1]]) {
      this.chunkManager.getChunk(x, z)?.markAllDirty();
    }
  }

  private resolveLiquidInteractionAt(x: number, y: number, z: number) {
    const current = this.getBlock(x, y, z);
    if (current !== BlockId.WATER && current !== BlockId.LAVA) return;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      const neighbor = this.getBlock(nx, ny, nz);
      const touchesOpposingLiquid = (current === BlockId.WATER && neighbor === BlockId.LAVA)
        || (current === BlockId.LAVA && neighbor === BlockId.WATER);
      if (!touchesOpposingLiquid) continue;

      const lavaX = current === BlockId.LAVA ? x : nx;
      const lavaY = current === BlockId.LAVA ? y : ny;
      const lavaZ = current === BlockId.LAVA ? z : nz;
      const replacement = this.lavaEngine?.isSource(lavaX, lavaY, lavaZ)
        ? BlockId.OBSIDIAN
        : BlockId.COBBLESTONE;
      this.lavaEngine?.clearAt(lavaX, lavaY, lavaZ);
      this.setBlock(lavaX, lavaY, lavaZ, replacement);
      this.soundManager?.playSingleSound('Fizz', 0.7);
    }
  }

  private loadNextPendingChunk(): boolean {
    return this.chunkManager.loadNextPendingChunk(
      this.scene,
      this.materials,
      this.terrainNoise,
      (x, y, z) => this.getBlock(x, y, z),
      (chunk, x, z) => {
        if (this.lightEngine) chunk.setLightReader(this.lightEngine.getRawBrightness.bind(this.lightEngine));
        chunk.setBlockDataReader(this.getBlockData.bind(this));
        chunk.setWaterDistanceReader(this.getLiquidDistance.bind(this));
        chunk.setWaterFlowReader(this.getWaterFlow.bind(this));
        chunk.setSmoothLighting(this.smoothLighting);
        chunk.setAmbientOcclusion(this.ambientOcclusion);
        this.lightEngine?.initializeChunk(chunk);
        this.markAdjacentChunksDirty(x, z);
        this.reapplyLiquidEdits(x, z);
      },
      (cx, cz) => this.editStore.get(cx, cz),
    );
  }

  /** Re-register liquids/fire from persisted edits so a placed source flows again. */
  private reapplyLiquidEdits(chunkX: number, chunkZ: number) {
    const edits = this.editStore.get(chunkX, chunkZ);
    if (!edits) return;
    const minX = chunkX * CHUNK_SIZE - 8;
    const minZ = chunkZ * CHUNK_SIZE - 8;
    for (const [idx, id] of edits) {
      if (id !== BlockId.WATER && id !== BlockId.LAVA && id !== BlockId.FIRE) continue;
      const wx = minX + (idx % CHUNK_SIZE);
      const wz = minZ + (Math.floor(idx / CHUNK_SIZE) % CHUNK_SIZE);
      const wy = Math.floor(idx / (CHUNK_SIZE * CHUNK_SIZE));
      if (id === BlockId.WATER) this.waterEngine?.onBlockPlaced(wx, wy, wz, id);
      else if (id === BlockId.LAVA) this.lavaEngine?.onBlockPlaced(wx, wy, wz, id);
      else this.fireEngine?.onFirePlaced(wx, wy, wz);
    }
  }
}

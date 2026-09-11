import * as THREE from 'three';
import { BlockId, BlockMaterials, isSolidBlock } from './block';
import { ChunkLightData } from './chunk-light-data';
import { SUBCHUNK_HEIGHT, Subchunk } from './subchunk';
import type { LightReader, WaterDistanceReader, WaterFlowReader, BlockDataReader } from './mesher';
import { isShapedBlock, shapeBoxesFor } from './block-shapes';
import type { TerrainNoise } from './terrain-noise';

export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 96;
export const CHUNK_MIN_Y = 0;
export const CHUNK_MAX_Y = 75;
export const WATER_LEVEL = 55;

export type BlockCollider = {
  id: BlockId;
  x: number;
  y: number;
  z: number;
  collider: THREE.Box3;
};

export type WorldBlockReader = (x: number, y: number, z: number) => BlockId;
export type TerrainHeightReader = (x: number, z: number) => number;

/** Reproducible RNG so a chunk's ores are identical every load. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Ore veins, ported from Minecraft LCE OreFeature + BiomeDecorator::decorateOres.
 * `veinSize` = LCE `count`; `tries` = attempts per 16x16 chunk; Y band scaled to
 * EvlyMC's shorter world.
 */
/** 32-bit hash -> RNG seed. */
function hashSeed(a: number, b: number, salt: number): number {
  let h = (Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(salt, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// --- Caves (ported from Minecraft LCE LargeCaveFeature) ---
const CAVE_SCAN_RADIUS = 7;                       // LCE `radius`: scan chunks +/- this (min that still catches the longest tunnels)
const CAVE_MAX_DIST = CAVE_SCAN_RADIUS * 16 - 16; // longest a tunnel can run
const CAVE_LAVA_Y = 10;                           // carved cells below this become lava

const ORE_VEINS: { id: BlockId; veinSize: number; tries: number; minY: number; maxY: number }[] = [
  { id: BlockId.COAL_ORE, veinSize: 16, tries: 20, minY: 5, maxY: 68 },
  { id: BlockId.IRON_ORE, veinSize: 9, tries: 20, minY: 5, maxY: 45 },
  { id: BlockId.GOLD_ORE, veinSize: 9, tries: 3, minY: 5, maxY: 28 },
  { id: BlockId.REDSTONE_ORE, veinSize: 8, tries: 8, minY: 4, maxY: 16 },
  { id: BlockId.DIAMOND_ORE, veinSize: 8, tries: 1, minY: 4, maxY: 16 },
  { id: BlockId.LAPIS_ORE, veinSize: 7, tries: 2, minY: 8, maxY: 26 },
  { id: BlockId.EMERALD_ORE, veinSize: 4, tries: 3, minY: 6, maxY: 36 },
];

export class Chunk {
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
    private readonly getTerrainHeight: TerrainHeightReader,
    private readonly terrainNoise: TerrainNoise,
    private readonly seed: number,
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

  private index(x: number, y: number, z: number) {
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

    this.generateCaves();
    this.generateRavines();
    this.generateOres();
    this.generateSurfacePatches();
    this.generateTrees();
  }

  private generateCaves() {
    // Every chunk independently simulates the tunnels seeded by its neighbours
    // (same seed -> same path) and carves only its own 16x16 slice.
    for (let nx = this.chunkX - CAVE_SCAN_RADIUS; nx <= this.chunkX + CAVE_SCAN_RADIUS; nx += 1) {
      for (let nz = this.chunkZ - CAVE_SCAN_RADIUS; nz <= this.chunkZ + CAVE_SCAN_RADIUS; nz += 1) {
        const rng = mulberry32(hashSeed(nx, nz, this.seed));
        this.caveFeature(rng, nx, nz);
      }
    }
  }

  /** LCE LargeCaveFeature::addFeature — decides whether a neighbour chunk seeds tunnels. */
  private caveFeature(rng: () => number, nChunkX: number, nChunkZ: number) {
    const ri = (n: number) => Math.floor(rng() * n);
    let caves = ri(ri(ri(40) + 1) + 1);
    if (ri(15) !== 0) caves = 0;

    const originX = nChunkX * CHUNK_SIZE - 8;
    const originZ = nChunkZ * CHUNK_SIZE - 8;

    for (let c = 0; c < caves; c += 1) {
      const xCave = originX + ri(CHUNK_SIZE);
      const yCave = 1 + ri(ri(CHUNK_HEIGHT - 16) + 8);
      const zCave = originZ + ri(CHUNK_SIZE);

      let tunnels = 1;
      if (ri(4) === 0) {
        this.caveTunnel(hashSeed(ri(1e9), c, 0x11), xCave, yCave, zCave, 1 + rng() * 6, 0, 0, -1, -1, 0.5);
        tunnels += ri(4);
      }
      for (let i = 0; i < tunnels; i += 1) {
        const yRot = rng() * Math.PI * 2;
        const xRot = ((rng() - 0.5) * 2) / 8;
        let thickness = rng() * 2 + rng();
        if (ri(10) === 0) thickness *= rng() * rng() * 3 + 1;
        this.caveTunnel(hashSeed(ri(1e9), i, 0x22), xCave, yCave, zCave, thickness, yRot, xRot, 0, 0, 1);
      }
    }
  }

  /** LCE LargeCaveFeature::addTunnel — walks a drifting 3D spline, carving ellipsoids. */
  private caveTunnel(
    seed: number,
    xCave: number,
    yCave: number,
    zCave: number,
    thickness: number,
    yRot: number,
    xRot: number,
    step: number,
    dist: number,
    yScale: number,
  ) {
    const r = mulberry32(seed);
    const rInt = (n: number) => Math.floor(r() * n);

    const xMid = this.minX + 8;
    const zMid = this.minZ + 8;
    let yRota = 0;
    let xRota = 0;

    if (dist <= 0) dist = CAVE_MAX_DIST - rInt(Math.floor(CAVE_MAX_DIST / 4));
    let singleStep = false;
    if (step === -1) {
      step = Math.floor(dist / 2);
      singleStep = true;
    }
    const splitPoint = rInt(Math.floor(dist / 2)) + Math.floor(dist / 4);
    const steep = rInt(6) === 0;

    for (; step < dist; step += 1) {
      const rad = 1.5 + Math.sin((step * Math.PI) / dist) * thickness;
      const yRad = rad * yScale;
      const xc = Math.cos(xRot);
      xCave += Math.cos(yRot) * xc;
      yCave += Math.sin(xRot);
      zCave += Math.sin(yRot) * xc;

      xRot *= steep ? 0.92 : 0.7;
      xRot += xRota * 0.1;
      yRot += yRota * 0.1;
      xRota *= 0.9;
      yRota *= 0.75;
      xRota += (r() - r()) * r() * 2;
      yRota += (r() - r()) * r() * 4;

      if (!singleStep && step === splitPoint && thickness > 1) {
        this.caveTunnel(hashSeed(rInt(1e9), step, 0x33), xCave, yCave, zCave, r() * 0.5 + 0.5, yRot - Math.PI / 2, xRot / 3, step, dist, 1);
        this.caveTunnel(hashSeed(rInt(1e9), step, 0x44), xCave, yCave, zCave, r() * 0.5 + 0.5, yRot + Math.PI / 2, xRot / 3, step, dist, 1);
        return;
      }
      if (!singleStep && rInt(4) === 0) continue;

      const xd0 = xCave - xMid;
      const zd0 = zCave - zMid;
      const remaining = dist - step;
      const rr = thickness + 2 + 16;
      if (xd0 * xd0 + zd0 * zd0 - remaining * remaining > rr * rr) return;

      if (xCave < xMid - 16 - rad * 2 || zCave < zMid - 16 - rad * 2
        || xCave > xMid + 16 + rad * 2 || zCave > zMid + 16 + rad * 2) continue;

      let lx0 = Math.floor(xCave - rad) - this.minX - 1;
      let lx1 = Math.floor(xCave + rad) - this.minX + 1;
      let ly0 = Math.floor(yCave - yRad) - 1;
      let ly1 = Math.floor(yCave + yRad) + 1;
      let lz0 = Math.floor(zCave - rad) - this.minZ - 1;
      let lz1 = Math.floor(zCave + rad) - this.minZ + 1;
      if (lx0 < 0) lx0 = 0;
      if (lx1 > CHUNK_SIZE) lx1 = CHUNK_SIZE;
      if (ly0 < 1) ly0 = 1;
      if (ly1 > CHUNK_HEIGHT - 6) ly1 = CHUNK_HEIGHT - 6;
      if (lz0 < 0) lz0 = 0;
      if (lz1 > CHUNK_SIZE) lz1 = CHUNK_SIZE;

      // Don't carve into a body of water. Only ocean columns exist at gen time,
      // so the scan is only needed near sea level.
      if (ly1 > 38 && ly0 <= WATER_LEVEL) {
        let touchesWater = false;
        for (let lx = lx0; !touchesWater && lx < lx1; lx += 1) {
          for (let lz = lz0; !touchesWater && lz < lz1; lz += 1) {
            for (let ly = ly0; ly < ly1; ly += 1) {
              if (this.blocks[this.index(this.minX + lx, ly, this.minZ + lz)] === BlockId.WATER) {
                touchesWater = true;
                break;
              }
            }
          }
        }
        if (touchesWater) continue;
      }

      for (let lx = lx0; lx < lx1; lx += 1) {
        const xd = (this.minX + lx + 0.5 - xCave) / rad;
        if (xd * xd >= 1) continue;
        for (let lz = lz0; lz < lz1; lz += 1) {
          const zd = (this.minZ + lz + 0.5 - zCave) / rad;
          if (xd * xd + zd * zd >= 1) continue;
          let hasGrass = false;
          for (let ly = ly1 - 1; ly >= ly0; ly -= 1) {
            const yd = (ly + 0.5 - yCave) / yRad;
            if (yd <= -0.7 || xd * xd + yd * yd + zd * zd >= 1) continue;
            const idx = this.index(this.minX + lx, ly, this.minZ + lz);
            const block = this.blocks[idx];
            if (block === BlockId.GRASS) hasGrass = true;
            if (block === BlockId.STONE || block === BlockId.DIRT || block === BlockId.GRASS) {
              if (ly < CAVE_LAVA_Y) {
                this.blocks[idx] = BlockId.LAVA;
              } else {
                this.blocks[idx] = BlockId.AIR;
                if (hasGrass && this.blocks[this.index(this.minX + lx, ly - 1, this.minZ + lz)] === BlockId.DIRT) {
                  this.blocks[this.index(this.minX + lx, ly - 1, this.minZ + lz)] = BlockId.GRASS;
                }
              }
            }
          }
        }
      }
      if (singleStep) break;
    }
  }

  // --- Ravines (ported from Minecraft LCE CanyonFeature) ---
  private generateRavines() {
    // Same neighbour-chunk scan as generateCaves(), independent seed stream
    // (salted differently) so ravines and caves don't always land together.
    for (let nx = this.chunkX - CAVE_SCAN_RADIUS; nx <= this.chunkX + CAVE_SCAN_RADIUS; nx += 1) {
      for (let nz = this.chunkZ - CAVE_SCAN_RADIUS; nz <= this.chunkZ + CAVE_SCAN_RADIUS; nz += 1) {
        const rng = mulberry32(hashSeed(nx, nz, this.seed ^ 0x52766e));
        this.ravineFeature(rng, nx, nz);
      }
    }
  }

  /** LCE CanyonFeature::addFeature - 1/50 chance of a single long, narrow gash per candidate chunk. */
  private ravineFeature(rng: () => number, nChunkX: number, nChunkZ: number) {
    if (Math.floor(rng() * 50) !== 0) return;
    const ri = (n: number) => Math.floor(rng() * n);

    const originX = nChunkX * CHUNK_SIZE - 8;
    const originZ = nChunkZ * CHUNK_SIZE - 8;
    const xCave = originX + ri(CHUNK_SIZE);
    const yCave = 20 + ri(ri(40) + 8);
    const zCave = originZ + ri(CHUNK_SIZE);

    const yRot = rng() * Math.PI * 2;
    const xRot = ((rng() - 0.5) * 2) / 8;
    const thickness = (rng() * 2 + rng()) * 2;
    this.ravineTunnel(hashSeed(ri(1e9), 0, 0x52), xCave, yCave, zCave, thickness, yRot, xRot, 0, 0, 3.0);
  }

  /**
   * LCE CanyonFeature::addTunnel - the same drifting-spline carve as
   * caveTunnel, but a single unbranched pass (a ravine doesn't fork) with a
   * per-Y-layer width jitter (`layerScale`, LCE's `rs[i]`) instead of a
   * uniform ellipse cross-section, so the walls read as a jagged crack
   * rather than a smooth round tunnel. yScale=3.0 (tall and narrow) makes it
   * read as a ravine rather than a cave.
   */
  private ravineTunnel(
    seed: number, xCave: number, yCave: number, zCave: number,
    thickness: number, yRot: number, xRot: number, step: number, dist: number, yScale: number,
  ) {
    const r = mulberry32(seed);
    const rInt = (n: number) => Math.floor(r() * n);

    const xMid = this.minX + 8;
    const zMid = this.minZ + 8;
    let yRota = 0;
    let xRota = 0;

    if (dist <= 0) dist = CAVE_MAX_DIST - rInt(Math.floor(CAVE_MAX_DIST / 4));

    const layerScale = new Float32Array(CHUNK_HEIGHT);
    let f = 1;
    for (let i = 0; i < CHUNK_HEIGHT; i += 1) {
      if (i === 0 || rInt(3) === 0) f = 1 + r() * r() * 1.0;
      layerScale[i] = f * f;
    }

    for (; step < dist; step += 1) {
      let rad = 1.5 + Math.sin((step * Math.PI) / dist) * thickness;
      let yRad = rad * yScale;
      rad *= r() * 0.25 + 0.75;
      yRad *= r() * 0.25 + 0.75;

      const xc = Math.cos(xRot);
      xCave += Math.cos(yRot) * xc;
      yCave += Math.sin(xRot);
      zCave += Math.sin(yRot) * xc;

      xRot *= 0.7;
      xRot += xRota * 0.05;
      yRot += yRota * 0.05;
      xRota *= 0.8;
      yRota *= 0.5;
      xRota += (r() - r()) * r() * 2;
      yRota += (r() - r()) * r() * 4;

      if (rInt(4) === 0) continue;

      const xd0 = xCave - xMid;
      const zd0 = zCave - zMid;
      const remaining = dist - step;
      const rr = thickness + 2 + 16;
      if (xd0 * xd0 + zd0 * zd0 - remaining * remaining > rr * rr) return;

      if (xCave < xMid - 16 - rad * 2 || zCave < zMid - 16 - rad * 2
        || xCave > xMid + 16 + rad * 2 || zCave > zMid + 16 + rad * 2) continue;

      let lx0 = Math.floor(xCave - rad) - this.minX - 1;
      let lx1 = Math.floor(xCave + rad) - this.minX + 1;
      let ly0 = Math.floor(yCave - yRad) - 1;
      let ly1 = Math.floor(yCave + yRad) + 1;
      let lz0 = Math.floor(zCave - rad) - this.minZ - 1;
      let lz1 = Math.floor(zCave + rad) - this.minZ + 1;
      if (lx0 < 0) lx0 = 0;
      if (lx1 > CHUNK_SIZE) lx1 = CHUNK_SIZE;
      if (ly0 < 1) ly0 = 1;
      if (ly1 > CHUNK_HEIGHT - 6) ly1 = CHUNK_HEIGHT - 6;
      if (lz0 < 0) lz0 = 0;
      if (lz1 > CHUNK_SIZE) lz1 = CHUNK_SIZE;

      // Same "don't carve into a body of water" guard as caveTunnel.
      if (ly1 > 38 && ly0 <= WATER_LEVEL) {
        let touchesWater = false;
        for (let lx = lx0; !touchesWater && lx < lx1; lx += 1) {
          for (let lz = lz0; !touchesWater && lz < lz1; lz += 1) {
            for (let ly = ly0; ly < ly1; ly += 1) {
              if (this.blocks[this.index(this.minX + lx, ly, this.minZ + lz)] === BlockId.WATER) {
                touchesWater = true;
                break;
              }
            }
          }
        }
        if (touchesWater) continue;
      }

      for (let lx = lx0; lx < lx1; lx += 1) {
        const xd = (this.minX + lx + 0.5 - xCave) / rad;
        if (xd * xd >= 1) continue;
        for (let lz = lz0; lz < lz1; lz += 1) {
          const zd = (this.minZ + lz + 0.5 - zCave) / rad;
          if (xd * xd + zd * zd >= 1) continue;
          let hasGrass = false;
          for (let ly = ly1 - 1; ly >= ly0; ly -= 1) {
            const yd = (ly + 0.5 - yCave) / yRad;
            if (yd <= -0.7) continue;
            if ((xd * xd + zd * zd) * layerScale[ly] + (yd * yd) / 6 >= 1) continue;
            const idx = this.index(this.minX + lx, ly, this.minZ + lz);
            const block = this.blocks[idx];
            if (block === BlockId.GRASS) hasGrass = true;
            if (block === BlockId.STONE || block === BlockId.DIRT || block === BlockId.GRASS) {
              if (ly < CAVE_LAVA_Y) {
                this.blocks[idx] = BlockId.LAVA;
              } else {
                this.blocks[idx] = BlockId.AIR;
                if (hasGrass && this.blocks[this.index(this.minX + lx, ly - 1, this.minZ + lz)] === BlockId.DIRT) {
                  this.blocks[this.index(this.minX + lx, ly - 1, this.minZ + lz)] = BlockId.GRASS;
                }
              }
            }
          }
        }
      }
    }
  }

  private generateOres() {
    const rng = mulberry32(hashSeed(this.chunkX, this.chunkZ, this.seed));
    const rngInt = (n: number) => Math.floor(rng() * n);

    for (const ore of ORE_VEINS) {
      for (let t = 0; t < ore.tries; t += 1) {
        const x = this.minX + rngInt(CHUNK_SIZE);
        const z = this.minZ + rngInt(CHUNK_SIZE);
        const y = ore.minY + rngInt(ore.maxY - ore.minY);
        this.placeOreVein(ore.id, x, y, z, ore.veinSize, rng);
      }
    }
  }

  /** One lens-shaped blob of ore that only replaces stone (LCE OreFeature::place). */
  private placeOreVein(id: BlockId, cx: number, cy: number, cz: number, count: number, rng: () => number) {
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
        if (bx < this.minX || bx >= this.minX + CHUNK_SIZE) continue;
        const xd = (bx + 0.5 - xx) / half;
        if (xd * xd >= 1) continue;
        for (let by = Math.floor(yy - half); by <= Math.floor(yy + half); by += 1) {
          if (by < 1 || by >= CHUNK_HEIGHT) continue;
          const yd = (by + 0.5 - yy) / half;
          if (xd * xd + yd * yd >= 1) continue;
          for (let bz = Math.floor(zz - half); bz <= Math.floor(zz + half); bz += 1) {
            if (bz < this.minZ || bz >= this.minZ + CHUNK_SIZE) continue;
            const zd = (bz + 0.5 - zz) / half;
            if (xd * xd + yd * yd + zd * zd >= 1) continue;
            if (this.blocks[this.index(bx, by, bz)] === BlockId.STONE) {
              this.setBlockData(bx, by, bz, id);
            }
          }
        }
      }
    }
  }

  /**
   * Loose sand/gravel patches scattered across dry surface ground - a much
   * smaller, shallower version of placeOreVein's lens blob, restricted to
   * the top couple of layers under grass/dirt instead of anywhere in stone.
   */
  private generateSurfacePatches() {
    const rng = mulberry32(hashSeed(this.chunkX, this.chunkZ, this.seed ^ 0x9a7c1e));
    const rngInt = (n: number) => Math.floor(rng() * n);
    // 75% of chunks skip patches entirely (down from every chunk rolling
    // 2-3) - the patches themselves were fine, there were just too many.
    if (rng() >= 0.25) return;
    const tries = 2 + rngInt(2); // 2-3 attempts per chunk that does roll one

    for (let t = 0; t < tries; t += 1) {
      const cx = this.minX + rngInt(CHUNK_SIZE);
      const cz = this.minZ + rngInt(CHUNK_SIZE);
      const surfaceY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(this.getTerrainHeight(cx, cz))));
      if (surfaceY <= WATER_LEVEL + 2) continue; // shore/underwater already has its own sand/gravel
      const patchId = rng() < 0.5 ? BlockId.SAND : BlockId.GRAVEL;
      const radius = 2 + rngInt(3); // 2-4 blocks
      const depth = 1 + rngInt(2); // replace the top 1-2 layers

      for (let bx = cx - radius; bx <= cx + radius; bx += 1) {
        if (bx < this.minX || bx >= this.minX + CHUNK_SIZE) continue;
        for (let bz = cz - radius; bz <= cz + radius; bz += 1) {
          if (bz < this.minZ || bz >= this.minZ + CHUNK_SIZE) continue;
          const dx = bx - cx, dz = bz - cz;
          if (dx * dx + dz * dz > radius * radius) continue; // circular footprint, not a square stamp
          const colY = Math.min(CHUNK_MAX_Y, Math.max(5, Math.floor(this.getTerrainHeight(bx, bz))));
          for (let by = colY; by > colY - depth; by -= 1) {
            const idx = this.index(bx, by, bz);
            if (this.blocks[idx] === BlockId.GRASS || this.blocks[idx] === BlockId.DIRT) {
              this.blocks[idx] = patchId;
            }
          }
        }
      }
    }
  }

  private cellHash(cx: number, cz: number, salt: number): number {
    let h = ((cx * 374761393) ^ (cz * 668265263) ^ (salt * 1274126177) ^ Math.imul(this.seed | 0, 2654435761)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  private generateTrees() {
    const cellSize = 6; // one candidate tree per 6x6 cell
    // Cover all cells whose tree canopy could overlap this chunk
    const minCellX = Math.floor((this.minX - 2) / cellSize);
    const maxCellX = Math.floor((this.minX + CHUNK_SIZE + 1) / cellSize);
    const minCellZ = Math.floor((this.minZ - 2) / cellSize);
    const maxCellZ = Math.floor((this.minZ + CHUNK_SIZE + 1) / cellSize);

    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
        const offsetX = 1 + Math.floor(this.cellHash(cellX, cellZ, 1) * 3);
        const offsetZ = 1 + Math.floor(this.cellHash(cellX, cellZ, 2) * 3);
        const treeX = cellX * cellSize + offsetX;
        const treeZ = cellZ * cellSize + offsetZ;

        // 0..1 forest density; plains stay near-empty, only noise peaks are forest.
        const density = this.terrainNoise.sampleTreeDensity(treeX, treeZ);
        const spawnChance = Math.min(0.45, Math.max(0, (density - 0.5) * 1.5));

        if (this.cellHash(cellX, cellZ, 3) < spawnChance) {
          const surfaceY = Math.min(CHUNK_MAX_Y - 8, Math.max(5, Math.floor(this.getTerrainHeight(treeX, treeZ))));
          if (surfaceY > WATER_LEVEL + 2 && surfaceY < CHUNK_MAX_Y - 7) {
            // Two visually distinct oak shapes (LCE reference: the blocky
            // hand-shaped one below vs a genuine port of TreeFeature::place's
            // organic top-down taper) alternate per tree, deterministically
            // from the same per-cell hash everything else here uses - so a
            // forest doesn't read as one shape copy-pasted everywhere.
            if (this.cellHash(cellX, cellZ, 4) < 0.5) {
              this.generateTreeClassic(treeX, surfaceY, treeZ);
            } else {
              const rng = mulberry32(hashSeed(cellX, cellZ, this.seed ^ 0x7ee5c0de));
              this.generateTreeOrganic(treeX, surfaceY, treeZ, rng);
            }
          }
        }
      }
    }
  }

  private setBlockData(x: number, y: number, z: number, id: BlockId) {
    this.blocks[this.index(x, y, z)] = id;
  }

  private placeBlock(x: number, y: number, z: number, id: BlockId) {
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

  /** The original hand-shaped oak: fixed 2-log trunk, blocky tapered canopy. */
  private generateTreeClassic(centerX: number, baseY: number, centerZ: number) {
    const trunkHeight = baseY + 1;

    // Capa 1 y 2: Tronco central (X)
    this.placeBlock(centerX, trunkHeight, centerZ, BlockId.OAK_LOG);
    this.placeBlock(centerX, trunkHeight + 1, centerZ, BlockId.OAK_LOG);

    // Capa 3: 5x5 lleno de hojas (O) con tronco en el centro (X)
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        const id = (dx === 0 && dz === 0) ? BlockId.OAK_LOG : BlockId.OAK_LEAVES;
        this.placeBlock(centerX + dx, trunkHeight + 2, centerZ + dz, id);
      }
    }

    // Capa 4: 5x5 con esquinas de aire (N), tronco en el centro (X) y hojas (O)
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (Math.abs(dx) === 2 && Math.abs(dz) === 2) continue; // Esquinas libres
        const id = (dx === 0 && dz === 0) ? BlockId.OAK_LOG : BlockId.OAK_LEAVES;
        this.placeBlock(centerX + dx, trunkHeight + 3, centerZ + dz, id);
      }
    }

    // Capa 5: 3x3 de hojas (O)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        this.placeBlock(centerX + dx, trunkHeight + 4, centerZ + dz, BlockId.OAK_LEAVES);
      }
    }

    // Capa 6: Cruz de hojas (5 bloques)
    this.placeBlock(centerX, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
    this.placeBlock(centerX + 1, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
    this.placeBlock(centerX - 1, trunkHeight + 5, centerZ, BlockId.OAK_LEAVES);
    this.placeBlock(centerX, trunkHeight + 5, centerZ + 1, BlockId.OAK_LEAVES);
    this.placeBlock(centerX, trunkHeight + 5, centerZ - 1, BlockId.OAK_LEAVES);
  }

  /**
   * Ported from LCE TreeFeature::place (the vanilla-style organic oak): a
   * randomised 4-6 tall trunk with leaves built top-down in shrinking
   * diamond-ish rings (`offs` shrinks as `yo` goes more negative, integer
   * division truncating toward zero exactly like the original C++), each
   * ring's outer corners randomly rounded off except the very top ring
   * (always rounded). Trunk is placed after leaves so it overwrites any leaf
   * that landed in its own column, same order as the original and as
   * placeBlock()'s log-over-leaves rule already assumes. Jungle-specific
   * vines/cocoa from the original aren't relevant to a plain oak and are
   * left out.
   */
  private generateTreeOrganic(x: number, baseY: number, z: number, rng: () => number) {
    const rngInt = (n: number) => Math.floor(rng() * n);
    const y = baseY + 1;
    const treeHeight = 4 + rngInt(3); // 4-6, LCE's default baseHeight=4
    const grassHeight = 3;

    for (let yy = y + treeHeight; yy >= y + treeHeight - grassHeight; yy -= 1) {
      const yo = yy - (y + treeHeight); // 0, -1, -2, -3
      const offs = 1 - Math.trunc(yo / 2);
      for (let xx = x - offs; xx <= x + offs; xx += 1) {
        const xo = xx - x;
        for (let zz = z - offs; zz <= z + offs; zz += 1) {
          const zo = zz - z;
          if (Math.abs(xo) === offs && Math.abs(zo) === offs && (rngInt(2) === 0 || yo === 0)) continue;
          this.placeBlock(xx, yy, zz, BlockId.OAK_LEAVES);
        }
      }
    }

    for (let hh = 0; hh < treeHeight; hh += 1) {
      this.placeBlock(x, y + hh, z, BlockId.OAK_LOG);
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

// --- Caves (ported from Minecraft LCE LargeCaveFeature) ---
import { BlockId } from '../block';
import { CHUNK_SIZE, CHUNK_HEIGHT, WATER_LEVEL, CHUNK_MAX_Y } from './constants';
import { hashSeed, mulberry32 } from './rng';
import type { ChunkWriter } from './types';

const CAVE_SCAN_RADIUS = 7;                       // LCE `radius`: scan chunks +/- this (min that still catches the longest tunnels)
export const CAVE_MAX_DIST = CAVE_SCAN_RADIUS * 16 - 16; // longest a tunnel can run - shared with ravines.ts
export const CAVE_LAVA_Y = 10;                    // carved cells below this become lava - shared with ravines.ts

export function generateCaves(chunk: ChunkWriter): void {
  // Every chunk independently simulates the tunnels seeded by its neighbours
  // (same seed -> same path) and carves only its own 16x16 slice.
  for (let nx = chunk.chunkX - CAVE_SCAN_RADIUS; nx <= chunk.chunkX + CAVE_SCAN_RADIUS; nx += 1) {
    for (let nz = chunk.chunkZ - CAVE_SCAN_RADIUS; nz <= chunk.chunkZ + CAVE_SCAN_RADIUS; nz += 1) {
      const rng = mulberry32(hashSeed(nx, nz, chunk.seed));
      caveFeature(chunk, rng, nx, nz);
    }
  }
}

/** LCE LargeCaveFeature::addFeature — decides whether a neighbour chunk seeds tunnels. */
function caveFeature(chunk: ChunkWriter, rng: () => number, nChunkX: number, nChunkZ: number): void {
  const ri = (n: number) => Math.floor(rng() * n);
  let caves = ri(ri(ri(40) + 1) + 1);
  if (ri(15) !== 0) caves = 0;

  const originX = nChunkX * CHUNK_SIZE - 8;
  const originZ = nChunkZ * CHUNK_SIZE - 8;

  for (let c = 0; c < caves; c += 1) {
    const xCave = originX + ri(CHUNK_SIZE);
    // CHUNK_MAX_Y (terrain ceiling), not CHUNK_HEIGHT (build height) - seeding
    // against the build height would scatter caves above where terrain (and
    // therefore anything to carve) actually exists once the two diverge.
    const yCave = 1 + ri(ri(CHUNK_MAX_Y - 16) + 8);
    const zCave = originZ + ri(CHUNK_SIZE);

    let tunnels = 1;
    if (ri(4) === 0) {
      caveTunnel(chunk, hashSeed(ri(1e9), c, 0x11), xCave, yCave, zCave, 1 + rng() * 6, 0, 0, -1, -1, 0.5);
      tunnels += ri(4);
    }
    for (let i = 0; i < tunnels; i += 1) {
      const yRot = rng() * Math.PI * 2;
      const xRot = ((rng() - 0.5) * 2) / 8;
      let thickness = rng() * 2 + rng();
      if (ri(10) === 0) thickness *= rng() * rng() * 3 + 1;
      caveTunnel(chunk, hashSeed(ri(1e9), i, 0x22), xCave, yCave, zCave, thickness, yRot, xRot, 0, 0, 1);
    }
  }
}

/** LCE LargeCaveFeature::addTunnel — walks a drifting 3D spline, carving ellipsoids. */
function caveTunnel(
  chunk: ChunkWriter,
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
): void {
  const r = mulberry32(seed);
  const rInt = (n: number) => Math.floor(r() * n);

  const xMid = chunk.minX + 8;
  const zMid = chunk.minZ + 8;
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
      caveTunnel(chunk, hashSeed(rInt(1e9), step, 0x33), xCave, yCave, zCave, r() * 0.5 + 0.5, yRot - Math.PI / 2, xRot / 3, step, dist, 1);
      caveTunnel(chunk, hashSeed(rInt(1e9), step, 0x44), xCave, yCave, zCave, r() * 0.5 + 0.5, yRot + Math.PI / 2, xRot / 3, step, dist, 1);
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

    let lx0 = Math.floor(xCave - rad) - chunk.minX - 1;
    let lx1 = Math.floor(xCave + rad) - chunk.minX + 1;
    let ly0 = Math.floor(yCave - yRad) - 1;
    let ly1 = Math.floor(yCave + yRad) + 1;
    let lz0 = Math.floor(zCave - rad) - chunk.minZ - 1;
    let lz1 = Math.floor(zCave + rad) - chunk.minZ + 1;
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
            if (chunk.blocks[chunk.index(chunk.minX + lx, ly, chunk.minZ + lz)] === BlockId.WATER) {
              touchesWater = true;
              break;
            }
          }
        }
      }
      if (touchesWater) continue;
    }

    for (let lx = lx0; lx < lx1; lx += 1) {
      const xd = (chunk.minX + lx + 0.5 - xCave) / rad;
      if (xd * xd >= 1) continue;
      for (let lz = lz0; lz < lz1; lz += 1) {
        const zd = (chunk.minZ + lz + 0.5 - zCave) / rad;
        if (xd * xd + zd * zd >= 1) continue;
        let hasGrass = false;
        for (let ly = ly1 - 1; ly >= ly0; ly -= 1) {
          const yd = (ly + 0.5 - yCave) / yRad;
          if (yd <= -0.7 || xd * xd + yd * yd + zd * zd >= 1) continue;
          const idx = chunk.index(chunk.minX + lx, ly, chunk.minZ + lz);
          const block = chunk.blocks[idx];
          if (block === BlockId.GRASS) hasGrass = true;
          if (block === BlockId.STONE || block === BlockId.DIRT || block === BlockId.GRASS) {
            if (ly < CAVE_LAVA_Y) {
              chunk.blocks[idx] = BlockId.LAVA;
            } else {
              chunk.blocks[idx] = BlockId.AIR;
              if (hasGrass && chunk.blocks[chunk.index(chunk.minX + lx, ly - 1, chunk.minZ + lz)] === BlockId.DIRT) {
                chunk.blocks[chunk.index(chunk.minX + lx, ly - 1, chunk.minZ + lz)] = BlockId.GRASS;
              }
            }
          }
        }
      }
    }
    if (singleStep) break;
  }
}

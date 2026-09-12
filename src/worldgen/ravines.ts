// --- Ravines (ported from Minecraft LCE CanyonFeature) ---
import { BlockId } from '../block';
import { CHUNK_SIZE, CHUNK_HEIGHT, WATER_LEVEL } from './constants';
import { hashSeed, mulberry32 } from './rng';
import { CAVE_MAX_DIST, CAVE_LAVA_Y } from './caves';
import type { ChunkWriter } from './types';

export function generateRavines(chunk: ChunkWriter): void {
  // Same neighbour-chunk scan as generateCaves(), independent seed stream
  // (salted differently) so ravines and caves don't always land together.
  const scanRadius = 7; // matches caves.ts's CAVE_SCAN_RADIUS
  for (let nx = chunk.chunkX - scanRadius; nx <= chunk.chunkX + scanRadius; nx += 1) {
    for (let nz = chunk.chunkZ - scanRadius; nz <= chunk.chunkZ + scanRadius; nz += 1) {
      const rng = mulberry32(hashSeed(nx, nz, chunk.seed ^ 0x52766e));
      ravineFeature(chunk, rng, nx, nz);
    }
  }
}

/** LCE CanyonFeature::addFeature - 1/50 chance of a single long, narrow gash per candidate chunk. */
function ravineFeature(chunk: ChunkWriter, rng: () => number, nChunkX: number, nChunkZ: number): void {
  if (Math.floor(rng() * 50) !== 0) return;
  const ri = (n: number) => Math.floor(rng() * n);

  const originX = nChunkX * CHUNK_SIZE - 8;
  const originZ = nChunkZ * CHUNK_SIZE - 8;
  const xCave = originX + ri(CHUNK_SIZE);
  // Rescaled ~1.7x from the old fixed 20+ri(ri(40)+8) (tuned for the old
  // 75-tall world) so ravines can now reach into the new surface band
  // (~48-128) instead of always staying underground - deliberately: a
  // ravine's carve loop already turns to air whatever it touches, surface
  // or not, so reaching higher is the whole fix, no new logic needed.
  const yCave = 34 + ri(ri(68) + 14);
  const zCave = originZ + ri(CHUNK_SIZE);

  const yRot = rng() * Math.PI * 2;
  const xRot = ((rng() - 0.5) * 2) / 8;
  const thickness = (rng() * 2 + rng()) * 2;
  ravineTunnel(chunk, hashSeed(ri(1e9), 0, 0x52), xCave, yCave, zCave, thickness, yRot, xRot, 0, 0, 3.0);
}

/**
 * LCE CanyonFeature::addTunnel - the same drifting-spline carve as
 * caveTunnel, but a single unbranched pass (a ravine doesn't fork) with a
 * per-Y-layer width jitter (`layerScale`, LCE's `rs[i]`) instead of a
 * uniform ellipse cross-section, so the walls read as a jagged crack
 * rather than a smooth round tunnel. yScale=3.0 (tall and narrow) makes it
 * read as a ravine rather than a cave.
 */
function ravineTunnel(
  chunk: ChunkWriter,
  seed: number, xCave: number, yCave: number, zCave: number,
  thickness: number, yRot: number, xRot: number, step: number, dist: number, yScale: number,
): void {
  const r = mulberry32(seed);
  const rInt = (n: number) => Math.floor(r() * n);

  const xMid = chunk.minX + 8;
  const zMid = chunk.minZ + 8;
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

    // Same "don't carve into a body of water" guard as caveTunnel.
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
          if (yd <= -0.7) continue;
          if ((xd * xd + zd * zd) * layerScale[ly] + (yd * yd) / 6 >= 1) continue;
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
  }
}

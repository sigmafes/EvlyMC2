import { BlockId, blockLightProperties, isFlammable } from './block';
import { CHUNK_HEIGHT } from './chunk';
import type { World } from './world';
import type { WaterEngine } from './water-engine';
import { withinFluidSimRadius } from './fluid-sim-radius';

const NEIGHBORS_6: readonly [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

const randInt = (n: number): number => Math.floor(Math.random() * n);

/** A block fire can sit on top of (roughly LCE `isTopSolidBlocking`). */
function isSolidGround(id: BlockId): boolean {
  return id !== BlockId.AIR
    && id !== BlockId.FIRE
    && id !== BlockId.WATER
    && id !== BlockId.LAVA
    && id !== BlockId.OAK_LEAVES;
}

/**
 * Fire spread & burn-out, ported from Minecraft LCE (FireTile::tick) plus lava
 * ignition (LiquidTileStatic::tick). Fire cells keep an `age` 0..15 in a Map,
 * since EvlyMC has no per-voxel metadata.
 */
export class FireEngine {
  private readonly fires = new Map<string, number>();
  private readonly tickInterval = 1.2; // LCE fire ticks every 30 game-ticks (~1.5s)
  private timeSinceTick = 0;

  constructor(private readonly world: World) {}

  onFirePlaced(x: number, y: number, z: number) {
    this.fires.set(key(x, y, z), 0);
  }

  onFireRemoved(x: number, y: number, z: number) {
    this.fires.delete(key(x, y, z));
  }

  update(delta: number, lava?: WaterEngine, playerX?: number, playerZ?: number): boolean {
    this.timeSinceTick += delta;
    if (this.timeSinceTick < this.tickInterval) return false;
    this.timeSinceTick = 0;
    return this.tick(lava, playerX, playerZ);
  }

  private tick(lava?: WaterEngine, playerX?: number, playerZ?: number): boolean {
    let changed = false;

    // --- Lava ignites nearby flammable blocks (LCE LiquidTileStatic::tick). ---
    if (lava) {
      for (const c of lava.cells()) {
        if (!withinFluidSimRadius(c.x, c.z, playerX, playerZ)) continue;
        if (Math.random() < 0.7) continue; // not every lava cell every tick
        if (this.igniteFromLava(c.x, c.y, c.z)) changed = true;
      }
    }

    // --- Fire tick (LCE FireTile::tick). Snapshot so we can mutate the map. ---
    for (const [k, age0] of [...this.fires.entries()]) {
      const [x, y, z] = k.split(',').map(Number);
      // Frozen while out of simulation range - left burning exactly as-is,
      // no aging/spreading/burnout, until the player is close enough again.
      if (!withinFluidSimRadius(x, z, playerX, playerZ)) continue;
      if (this.world.getBlock(x, y, z) !== BlockId.FIRE) {
        this.fires.delete(k);
        continue;
      }

      const solidBelow = isSolidGround(this.world.getBlock(x, y - 1, z));
      const hasFuel = this.anyFlammableNeighbor(x, y, z);

      // No support and nothing to burn -> gone.
      if (!solidBelow && !hasFuel) {
        this.extinguish(x, y, z);
        changed = true;
        continue;
      }

      // Age up (LCE: age += random(3)/2  -> +1 with probability 1/3).
      let age = age0;
      if (age < 15 && randInt(3) === 0) age += 1;
      this.fires.set(k, age);

      // Nothing left to burn -> burn out (right away in mid-air, else once age > 3).
      if (!hasFuel) {
        if (!solidBelow || age > 3) {
          this.extinguish(x, y, z);
          changed = true;
        }
        continue;
      }

      // Consume / re-ignite the 6 neighbours.
      for (const [dx, dy, dz] of NEIGHBORS_6) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        const f = blockLightProperties[this.world.getBlock(nx, ny, nz)].flammable;
        if (!f) continue;
        const chance = dy === 0 ? 300 : 250;
        if (randInt(chance) < f.burnOdds) {
          if (randInt(age + 10) < 5) {
            this.setFire(nx, ny, nz, age + (randInt(5) >= 4 ? 1 : 0));
          } else {
            this.world.setBlock(nx, ny, nz, BlockId.AIR);
            this.fires.delete(key(nx, ny, nz));
          }
          changed = true;
        }
      }

      // Spread to nearby air (box x±1, z±1, y-1..y+4).
      for (let yy = y - 1; yy <= y + 4; yy++) {
        if (yy < 0 || yy >= CHUNK_HEIGHT) continue;
        for (let xx = x - 1; xx <= x + 1; xx++) {
          for (let zz = z - 1; zz <= z + 1; zz++) {
            if (xx === x && yy === y && zz === z) continue;
            if (!this.world.isInsideWorld(xx, zz)) continue;
            if (this.world.getBlock(xx, yy, zz) !== BlockId.AIR) continue;
            const catchOdds = this.maxCatchOdds(xx, yy, zz);
            if (catchOdds <= 0) continue;
            const rate = 100 + Math.max(0, yy - (y + 1)) * 100;
            const odds = Math.floor((catchOdds + 40) / (age + 30));
            if (odds > 0 && randInt(rate) <= odds) {
              this.setFire(xx, yy, zz, age + (randInt(5) >= 4 ? 1 : 0));
              changed = true;
            }
          }
        }
      }
    }

    return changed;
  }

  private igniteFromLava(lx: number, ly: number, lz: number): boolean {
    const h = randInt(3);
    let x = lx, y = ly, z = lz;
    for (let i = 0; i < h; i++) {
      x += randInt(3) - 1;
      y += 1;
      z += randInt(3) - 1;
      const b = this.world.getBlock(x, y, z);
      if (b === BlockId.AIR) {
        if (this.anyFlammableNeighbor(x, y, z)) {
          this.setFire(x, y, z, 0);
          return true;
        }
      } else if (isSolidGround(b)) {
        return false;
      }
    }
    if (h === 0) {
      for (let i = 0; i < 3; i++) {
        const ax = lx + randInt(3) - 1;
        const az = lz + randInt(3) - 1;
        if (this.world.getBlock(ax, ly + 1, az) === BlockId.AIR && isFlammable(this.world.getBlock(ax, ly, az))) {
          this.setFire(ax, ly + 1, az, 0);
          return true;
        }
      }
    }
    return false;
  }

  private anyFlammableNeighbor(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of NEIGHBORS_6) {
      if (isFlammable(this.world.getBlock(x + dx, y + dy, z + dz))) return true;
    }
    return false;
  }

  private maxCatchOdds(x: number, y: number, z: number): number {
    let max = 0;
    for (const [dx, dy, dz] of NEIGHBORS_6) {
      const f = blockLightProperties[this.world.getBlock(x + dx, y + dy, z + dz)].flammable;
      if (f && f.catchOdds > max) max = f.catchOdds;
    }
    return max;
  }

  private setFire(x: number, y: number, z: number, age: number) {
    if (y < 0 || y >= CHUNK_HEIGHT || !this.world.isInsideWorld(x, z)) return;
    this.world.setBlock(x, y, z, BlockId.FIRE);
    this.fires.set(key(x, y, z), Math.max(0, Math.min(15, age)));
  }

  private extinguish(x: number, y: number, z: number) {
    this.world.setBlock(x, y, z, BlockId.AIR);
    this.fires.delete(key(x, y, z));
  }
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

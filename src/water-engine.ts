import * as THREE from 'three';
import { BlockId } from './block';
import type { World } from './world';

export type WaterNode = {
  x: number;
  y: number;
  z: number;
  distance: number;
  isSource: boolean;
  /** Marks a column that is falling straight down (MCPE "data >= 8" flag). */
  falling?: boolean;
};

export type LiquidConfig = {
  blockId: BlockId;
  /** Cap on `distance` (== MCPE `data`). Spread stops when the next step would exceed it. */
  maxDistance: number;
  tickInterval: number;
  /** Horizontal drop-off per spread step. Water 1, lava 2 (MCPE `dropOff`). */
  spreadStep: number;
  /** Water only: two orthogonal source neighbours + solid ground -> new source. */
  infiniteSource: boolean;
  /** Lava: a fresh horizontal ring has a 3/4 chance to wait one tick (uneven creep). */
  jitter: boolean;
};

const HDIRS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class WaterEngine {
  private readonly sources = new Map<string, { x: number; y: number; z: number }>();
  /** Sources created by the infinite-source rule; purged when they no longer qualify. */
  private readonly derivedSources = new Set<string>();
  private readonly currentWater = new Map<string, WaterNode>();
  private readonly tickInterval: number;
  private readonly blockId: BlockId;
  private readonly maxDistance: number;
  private readonly spreadStep: number;
  private readonly infiniteSource: boolean;
  private readonly jitter: boolean;
  private timeSinceLastTick = 0;

  constructor(
    private readonly world: World,
    config: LiquidConfig = {
      blockId: BlockId.WATER,
      maxDistance: 7,
      tickInterval: 0.25,
      spreadStep: 1,
      infiniteSource: true,
      jitter: false,
    },
  ) {
    this.blockId = config.blockId;
    this.maxDistance = config.maxDistance;
    this.tickInterval = config.tickInterval;
    this.spreadStep = config.spreadStep;
    this.infiniteSource = config.infiniteSource;
    this.jitter = config.jitter;
  }

  addSource(x: number, y: number, z: number) {
    const key = this.key(x, y, z);
    this.sources.set(key, { x, y, z });
    this.derivedSources.delete(key);
    this.world.setBlock(x, y, z, this.blockId);
    this.timeSinceLastTick = 0;
  }

  removeSource(x: number, y: number, z: number) {
    const key = this.key(x, y, z);
    if (this.sources.has(key)) {
      this.sources.delete(key);
      this.derivedSources.delete(key);
      this.timeSinceLastTick = this.tickInterval;
    }
  }

  onBlockPlaced(x: number, y: number, z: number, id: BlockId) {
    const key = this.key(x, y, z);
    if (id === this.blockId) {
      this.addSource(x, y, z);
    } else {
      this.sources.delete(key);
      this.derivedSources.delete(key);
      this.currentWater.delete(key);
      this.timeSinceLastTick = this.tickInterval;
    }
  }

  onBlockRemoved(x: number, y: number, z: number) {
    const key = this.key(x, y, z);
    this.sources.delete(key);
    this.derivedSources.delete(key);
    this.currentWater.delete(key);
    this.timeSinceLastTick = this.tickInterval;
  }

  update(delta: number): boolean {
    this.timeSinceLastTick += delta;
    if (this.timeSinceLastTick < this.tickInterval) return false;
    this.timeSinceLastTick = 0;
    return this.tick();
  }

  private tick(): boolean {
    // 0. Purge derived (infinite) sources that no longer qualify. Cascades inward
    //    over ticks as the outer ones lose their block.
    for (const dk of [...this.derivedSources]) {
      const s = this.sources.get(dk);
      if (!s || this.world.getBlock(s.x, s.y, s.z) !== this.blockId) {
        this.sources.delete(dk);
        this.derivedSources.delete(dk);
        continue;
      }
      let n = 0;
      for (const [dx, dz] of HDIRS) {
        if (this.sources.has(this.key(s.x + dx, s.y, s.z + dz))) n += 1;
      }
      if (n < 2) {
        this.sources.delete(dk);
        this.derivedSources.delete(dk);
      }
    }

    // 1. Verify explicit sources still exist in the world.
    for (const [key, source] of this.sources.entries()) {
      if (this.derivedSources.has(key)) continue;
      if (this.world.getBlock(source.x, source.y, source.z) !== this.blockId) {
        this.sources.delete(key);
      }
    }

    // 2. Compute the full target distribution from the remaining sources.
    const target = this.computeTargetWater();
    let changed = false;

    // 3. Drain: liquid in the world that is no longer in `target` and has lost its
    //    upstream parent (cuts off source -> downstream).
    const toRemove: WaterNode[] = [];
    for (const [key, node] of this.currentWater.entries()) {
      if (target.has(key)) continue;
      let hasParent = false;
      if (!node.isSource) {
        if (this.currentWater.has(this.key(node.x, node.y + 1, node.z))) {
          hasParent = true;
        } else {
          for (const [dx, dz] of HDIRS) {
            const parent = this.currentWater.get(this.key(node.x + dx, node.y, node.z + dz));
            if (parent && parent.distance < node.distance) {
              hasParent = true;
              break;
            }
          }
        }
      }
      if (!hasParent) toRemove.push(node);
    }
    for (const node of toRemove) {
      this.currentWater.delete(this.key(node.x, node.y, node.z));
      if (this.world.getBlock(node.x, node.y, node.z) === this.blockId) {
        this.world.setBlock(node.x, node.y, node.z, BlockId.AIR);
        changed = true;
      }
    }

    // 4. Spread: one ring per tick (a cell is placed only once its parent exists).
    const toAdd: WaterNode[] = [];
    for (const [key, node] of target.entries()) {
      if (this.currentWater.has(key)) continue;
      if (node.isSource) {
        toAdd.push(node);
        continue;
      }
      const hasAbove = this.currentWater.has(this.key(node.x, node.y + 1, node.z));
      let hasHorizontalParent = false;
      for (const [dx, dz] of HDIRS) {
        const parent = this.currentWater.get(this.key(node.x + dx, node.y, node.z + dz));
        if (parent && parent.distance < node.distance) {
          hasHorizontalParent = true;
          break;
        }
      }
      if (hasAbove || hasHorizontalParent) toAdd.push(node);
    }
    for (const node of toAdd) {
      // Lava jitter: a new horizontal ring often waits a tick, so lava creeps unevenly.
      if (this.jitter && !node.isSource && !node.falling && Math.random() < 0.75) continue;

      this.currentWater.set(this.key(node.x, node.y, node.z), node);
      if (this.world.getBlock(node.x, node.y, node.z) === BlockId.AIR) {
        this.world.setBlock(node.x, node.y, node.z, this.blockId);
        changed = true;
      }
    }

    return changed;
  }

  private computeTargetWater(): Map<string, WaterNode> {
    const target = new Map<string, WaterNode>();
    if (this.sources.size === 0) return target;

    const queue: Array<{ x: number; y: number; z: number; distance: number }> = [];
    for (const s of this.sources.values()) {
      target.set(this.key(s.x, s.y, s.z), { x: s.x, y: s.y, z: s.z, distance: 0, isSource: true });
      queue.push({ x: s.x, y: s.y, z: s.z, distance: 0 });
    }

    while (queue.length > 0) {
      const { x, y, z, distance } = queue.shift()!;
      const node = target.get(this.key(x, y, z));
      const isSource = node ? node.isSource : false;

      // Vertical: fall straight down (resets the horizontal distance to 1).
      let canFlowDown = false;
      if (y - 1 >= 0) {
        const downBlock = this.world.getBlock(x, y - 1, z);
        if (downBlock === BlockId.AIR || downBlock === this.blockId) {
          canFlowDown = true;
          const downKey = this.key(x, y - 1, z);
          const existing = target.get(downKey);
          if (!existing || existing.distance > 1) {
            target.set(downKey, { x, y: y - 1, z, distance: 1, isSource: false, falling: true });
            queue.push({ x, y: y - 1, z, distance: 1 });
          }
        }
      }

      // Horizontal: only from a source, or when it cannot fall (solid ground below).
      const canSpreadHorizontal = isSource || !canFlowDown;
      if (!canSpreadHorizontal || distance + this.spreadStep > this.maxDistance) continue;

      const candidates: [number, number][] = [];
      for (const [dx, dz] of HDIRS) {
        const nx = x + dx;
        const nz = z + dz;
        if (!this.world.isInsideWorld(nx, nz)) continue;
        const nb = this.world.getBlock(nx, y, nz);
        if (nb === BlockId.AIR || nb === this.blockId) candidates.push([dx, dz]);
      }
      const dirs = this.getSpreadDirections(x, y, z, candidates);

      for (const [dx, dz] of dirs) {
        const nx = x + dx;
        const nz = z + dz;
        const nKey = this.key(nx, y, nz);

        // Infinite-source rule (water): 2+ orthogonal source neighbours + solid floor.
        if (this.infiniteSource && !target.get(nKey)?.isSource) {
          let srcNeighbours = 0;
          for (const [ax, az] of HDIRS) {
            const ak = this.key(nx + ax, y, nz + az);
            if (this.sources.has(ak) || target.get(ak)?.isSource) srcNeighbours += 1;
          }
          const below = this.world.getBlock(nx, y - 1, nz);
          const solidBelow = below !== BlockId.AIR && below !== this.blockId;
          if (srcNeighbours >= 2 && solidBelow) {
            target.set(nKey, { x: nx, y, z: nz, distance: 0, isSource: true });
            this.sources.set(nKey, { x: nx, y, z: nz });
            this.derivedSources.add(nKey);
            queue.push({ x: nx, y, z: nz, distance: 0 });
            continue;
          }
        }

        const nextDistance = distance + this.spreadStep;
        const existing = target.get(nKey);
        if (!existing || existing.distance > nextDistance) {
          target.set(nKey, { x: nx, y, z: nz, distance: nextDistance, isSource: false });
          queue.push({ x: nx, y, z: nz, distance: nextDistance });
        }
      }
    }

    return target;
  }

  /**
   * MCPE `getSpread` + `getSlopeDistance`: spread only toward the direction(s)
   * with the shortest path to a drop-off, so liquid runs to the nearest edge
   * instead of spreading evenly.
   */
  private getSpreadDirections(
    x: number,
    y: number,
    z: number,
    candidates: [number, number][],
  ): [number, number][] {
    if (candidates.length <= 1) return candidates;

    const dist = HDIRS.map(([dx, dz]) => {
      const nx = x + dx;
      const nz = z + dz;
      if (this.isLiquidBlocking(nx, y, nz) || this.sources.has(this.key(nx, y, nz))) return 1000;
      if (this.canDrop(nx, y, nz)) return 0;
      return this.getSlopeDistance(nx, y, nz, 1, dx, dz);
    });

    const lowest = Math.min(...dist);
    const out: [number, number][] = [];
    HDIRS.forEach(([dx, dz], i) => {
      if (dist[i] === lowest && candidates.some(([cx, cz]) => cx === dx && cz === dz)) {
        out.push([dx, dz]);
      }
    });
    return out.length > 0 ? out : candidates;
  }

  /** Recursive (depth 4) search for the nearest hole, never doubling back. */
  private getSlopeDistance(x: number, y: number, z: number, pass: number, fromX: number, fromZ: number): number {
    let lowest = 1000;
    for (const [dx, dz] of HDIRS) {
      if (dx === -fromX && dz === -fromZ) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (this.isLiquidBlocking(nx, y, nz) || this.sources.has(this.key(nx, y, nz))) continue;
      if (this.canDrop(nx, y, nz)) return pass;
      if (pass < 4) {
        const v = this.getSlopeDistance(nx, y, nz, pass + 1, dx, dz);
        if (v < lowest) lowest = v;
      }
    }
    return lowest;
  }

  /** Solid enough to stop the liquid (not air, not the same liquid). */
  private isLiquidBlocking(x: number, y: number, z: number): boolean {
    const b = this.world.getBlock(x, y, z);
    return b !== BlockId.AIR && b !== this.blockId;
  }

  /** The cell below is open, so liquid here would fall. */
  private canDrop(x: number, y: number, z: number): boolean {
    const b = this.world.getBlock(x, y - 1, z);
    return b === BlockId.AIR || b === this.blockId;
  }

  getWaterDistance(x: number, y: number, z: number): number {
    const key = this.key(x, y, z);
    const node = this.currentWater.get(key);
    if (node) return node.distance;
    return 0;
  }

  isSource(x: number, y: number, z: number): boolean {
    return this.sources.has(this.key(x, y, z));
  }

  /** Every cell currently occupied by this liquid (sources + flowing). */
  *cells(): Generator<{ x: number; y: number; z: number }> {
    for (const s of this.sources.values()) yield { x: s.x, y: s.y, z: s.z };
    for (const n of this.currentWater.values()) {
      if (!this.sources.has(this.key(n.x, n.y, n.z))) yield { x: n.x, y: n.y, z: n.z };
    }
  }

  clearAt(x: number, y: number, z: number) {
    const key = this.key(x, y, z);
    this.sources.delete(key);
    this.derivedSources.delete(key);
    this.currentWater.delete(key);
  }

  /** Rendered depth 0..7 (falling -> 0), or -1 if this cell is not this liquid. */
  private renderedDataAt(x: number, y: number, z: number): number {
    const key = this.key(x, y, z);
    if (this.sources.has(key)) return 0;
    const node = this.currentWater.get(key);
    if (!node) return this.world.getBlock(x, y, z) === this.blockId ? 0 : -1;
    return Math.min(7, node.distance);
  }

  private isFallingAt(x: number, y: number, z: number): boolean {
    if (this.currentWater.get(this.key(x, y, z))?.falling) return true;
    return this.world.getBlock(x, y + 1, z) === this.blockId;
  }

  /**
   * MCPE `LiquidTile::getFlow`: a unit vector from deep (low data) toward shallow
   * (high data); a falling column gets a dominant downward component.
   */
  getWaterFlow(worldX: number, worldY: number, worldZ: number): THREE.Vector3 {
    const x = Math.round(worldX);
    const y = Math.floor(worldY + 0.5);
    const z = Math.round(worldZ);

    const flow = new THREE.Vector3();
    const key = this.key(x, y, z);
    if (!this.currentWater.has(key) && !this.sources.has(key)) return flow;

    const mid = Math.max(0, this.renderedDataAt(x, y, z));

    for (const [dx, dz] of HDIRS) {
      const nx = x + dx;
      const nz = z + dz;
      const t = this.renderedDataAt(nx, y, nz);
      if (t >= 0) {
        const dir = t - mid;
        flow.x += dx * dir;
        flow.z += dz * dir;
      } else if (this.world.getBlock(nx, y, nz) === BlockId.AIR) {
        // Open side with liquid one step down: pull hard toward that fall.
        const tb = this.renderedDataAt(nx, y - 1, nz);
        if (tb >= 0) {
          const dir = tb - (mid - 8);
          flow.x += dx * dir;
          flow.z += dz * dir;
        }
      }
    }

    if (this.isFallingAt(x, y, z)) {
      flow.normalize();
      flow.y -= 6;
    }
    return flow.normalize();
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }
}

export class LavaEngine extends WaterEngine {
  constructor(world: World) {
    super(world, {
      blockId: BlockId.LAVA,
      maxDistance: 7,
      tickInterval: 1.5,
      spreadStep: 2,
      infiniteSource: false,
      jitter: true,
    });
  }
}

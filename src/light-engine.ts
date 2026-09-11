import { blockLightProperties, BlockId } from './block';
import { CHUNK_HEIGHT, CHUNK_SIZE, Chunk } from './chunk';
import type { World } from './world';

const DIRECTIONS = [
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
] as const;

export class LightEngine {
  private readonly skyQueue: LightNode[] = [];
  private readonly blockQueue: LightNode[] = [];
  private readonly decreaseQueue: LightNode[] = [];
  private readonly increaseQueue: LightNode[] = [];
  private readonly queuedDecreases = new Set<string>();
  private readonly queuedIncreases = new Set<string>();
  private skyDarken = 0;
  private lastProcessedUpdates = 0;

  constructor(private readonly world: World) {}

  rebuildLoadedChunks() {
    this.clearLoadedLights();
    this.seedSkyLight();
    this.seedBlockLight();
    this.propagate('skyLight', this.skyQueue);
    this.propagate('blockLight', this.blockQueue);
  }

  initializeChunk(chunk: Chunk) {
    chunk.light.skyLight.fill(0);
    chunk.light.blockLight.fill(0);
    for (let localZ = 0; localZ < CHUNK_SIZE; localZ += 1) {
      for (let localX = 0; localX < CHUNK_SIZE; localX += 1) {
        const worldX = chunk.minX + localX;
        const worldZ = chunk.minZ + localZ;
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y -= 1) {
          const block = chunk.getBlock(worldX, y, worldZ);
          const opacity = blockLightProperties[block].opacity;
          if (opacity > 0) {
            break;
          }
          chunk.setLight('skyLight', worldX, y, worldZ, 15);
          // Match the full-world lighting pass: every direct-sky cell is a
          // propagation source, so leaf canopies receive lateral skylight.
          this.skyQueue.push({ x: worldX, y, z: worldZ, level: 15, channel: 'skyLight' });
        }
      }
    }
    for (let y = 0; y < CHUNK_HEIGHT; y += 1) {
      for (let localZ = 0; localZ < CHUNK_SIZE; localZ += 1) {
        for (let localX = 0; localX < CHUNK_SIZE; localX += 1) {
          const x = chunk.minX + localX;
          const z = chunk.minZ + localZ;
          const emid = chunk.getBlock(x, y, z);
          const emission = this.world.emissionAt(emid, x, y, z);
          if (emission > 0) {
            chunk.setLight('blockLight', x, y, z, emission);
            this.blockQueue.push({ x, y, z, level: emission, channel: 'blockLight' });
          }
        }
      }
    }
    this.propagate('skyLight', this.skyQueue);
    this.propagate('blockLight', this.blockQueue);
  }

  getRawBrightness(x: number, y: number, z: number) {
    return Math.max(0, Math.max(this.world.getLight('skyLight', x, y, z) - this.skyDarken, this.world.getLight('blockLight', x, y, z)));
  }

  /**
   * Natural sunlight exposure 0..15 at a column, ignoring blockLight
   * entirely (a torch must not stop a zombie from catching fire, nor from
   * spawning at night the way it stops one spawning underground - that's
   * getRawBrightness's job). At full noon (skyDarken 0) an open-sky column
   * reads 15; at full night (skyDarken === nightSkyDarken, currently 11) the
   * same column floors out at 4, which is intentionally not 0 - "reaches its
   * minimum" per the spawn/burn design, not "goes dark".
   */
  getSkyExposure(x: number, y: number, z: number) {
    return Math.max(0, this.world.getLight('skyLight', x, y, z) - this.skyDarken);
  }

  setSkyDarken(skyDarken: number) {
    const next = Math.max(0, Math.min(15, Math.floor(skyDarken)));
    if (next === this.skyDarken) return false;
    this.skyDarken = next;
    return true;
  }

  queueBlockUpdate(x: number, y: number, z: number, oldSkyLight = 0, oldBlockLight = 0, _reason = 'block-change') {
    const id = this.world.getBlock(x, y, z);
    const opacity = blockLightProperties[id]?.opacity ?? 15;
    if (oldSkyLight > 0 && opacity > 0) this.queueDecrease('skyLight', x, y, z, oldSkyLight);
    if (oldBlockLight > 0 && opacity > 0) this.queueDecrease('blockLight', x, y, z, oldBlockLight);
    this.queueIncrease('skyLight', x, y, z);
    this.queueIncrease('blockLight', x, y, z);
    for (const [dx, dy, dz] of DIRECTIONS) {
      this.queueIncrease('skyLight', x + dx, y + dy, z + dz);
      this.queueIncrease('blockLight', x + dx, y + dy, z + dz);
    }
    if (opacity > 0) {
      for (let columnY = y - 1; columnY >= 0; columnY -= 1) {
        if (blockLightProperties[this.world.getBlock(x, columnY, z)].opacity > 0) break;
        this.queueIncrease('skyLight', x, columnY, z);
      }
    }
  }

  processUpdates(budget = 4096) {
    let processed = 0;
    let decreaseIndex = 0;
    while (decreaseIndex < this.decreaseQueue.length && processed < budget) {
      const node = this.decreaseQueue[decreaseIndex];
      this.queuedDecreases.delete(this.nodeKey(node));
      this.processDecrease(node);
      decreaseIndex += 1;
      processed += 1;
    }
    this.decreaseQueue.splice(0, decreaseIndex);
    let increaseIndex = 0;
    while (increaseIndex < this.increaseQueue.length && processed < budget) {
      const node = this.increaseQueue[increaseIndex];
      this.queuedIncreases.delete(this.nodeKey(node));
      this.processIncrease(node);
      increaseIndex += 1;
      processed += 1;
    }
    this.increaseQueue.splice(0, increaseIndex);
    this.lastProcessedUpdates = processed;
    return processed > 0 && this.decreaseQueue.length === 0 && this.increaseQueue.length === 0;
  }

  get pendingUpdates() {
    return this.decreaseQueue.length + this.increaseQueue.length + this.skyQueue.length + this.blockQueue.length;
  }

  get processedUpdates() { return this.lastProcessedUpdates; }
  get currentSkyDarken() { return this.skyDarken; }

  private clearLoadedLights() {
    for (const chunk of this.world.chunks.values()) {
      chunk.light.skyLight.fill(0);
      chunk.light.blockLight.fill(0);
    }
    this.skyQueue.length = 0;
    this.blockQueue.length = 0;
    this.decreaseQueue.length = 0;
    this.increaseQueue.length = 0;
    this.queuedDecreases.clear();
    this.queuedIncreases.clear();
  }

  private seedSkyLight() {
    for (const chunk of this.world.chunks.values()) {
      for (let localZ = 0; localZ < CHUNK_SIZE; localZ += 1) {
        for (let localX = 0; localX < CHUNK_SIZE; localX += 1) {
          const worldX = chunk.minX + localX;
          const worldZ = chunk.minZ + localZ;
          for (let y = CHUNK_HEIGHT - 1; y >= 0; y -= 1) {
            const block = this.world.getBlock(worldX, y, worldZ);
            const opacity = blockLightProperties[block].opacity;
            if (opacity >= 15) break; // Only stop at fully opaque blocks
            chunk.setLight('skyLight', worldX, y, worldZ, 15);
            this.skyQueue.push({ x: worldX, y, z: worldZ, level: 15, channel: 'skyLight' });
          }
        }
      }
    }
  }

  private seedBlockLight() {
    for (const chunk of this.world.chunks.values()) {
      for (let y = 0; y < CHUNK_HEIGHT; y += 1) {
        for (let localZ = 0; localZ < CHUNK_SIZE; localZ += 1) {
          for (let localX = 0; localX < CHUNK_SIZE; localX += 1) {
            const x = chunk.minX + localX;
            const z = chunk.minZ + localZ;
            const id = chunk.getBlock(x, y, z);
            const emission = this.world.emissionAt(id, x, y, z);
            if (emission === 0) continue;
            chunk.setLight('blockLight', x, y, z, emission);
            this.blockQueue.push({ x, y, z, level: emission, channel: 'blockLight' });
          }
        }
      }
    }
  }

  private propagate(channel: 'skyLight' | 'blockLight', queue: LightNode[]) {
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      for (const [dx, dy, dz] of DIRECTIONS) {
        const x = node.x + dx;
        const y = node.y + dy;
        const z = node.z + dz;
        if (y < 0 || y >= CHUNK_HEIGHT) continue;
        const id = this.world.getBlock(x, y, z);
        const opacity = blockLightProperties[id].opacity;
        if (opacity >= 15) continue; // Fully opaque blocks block light completely
        const nextLevel = node.level - Math.max(1, opacity);
        if (nextLevel <= this.world.getLight(channel, x, y, z)) continue;
        if (!this.world.setLight(channel, x, y, z, nextLevel)) continue;
        queue.push({ x, y, z, level: nextLevel, channel });
      }
    }
    queue.length = 0;
  }

  private queueIncrease(channel: LightChannel, x: number, y: number, z: number) {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const node = { x, y, z, level: this.world.getLight(channel, x, y, z), channel };
    const key = this.nodeKey(node);
    if (this.queuedIncreases.has(key)) return;
    this.queuedIncreases.add(key);
    this.increaseQueue.push(node);
  }

  private queueDecrease(channel: LightChannel, x: number, y: number, z: number, level: number) {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    const node = { x, y, z, level, channel };
    const key = this.nodeKey(node);
    if (this.queuedDecreases.has(key)) return;
    this.queuedDecreases.add(key);
    this.decreaseQueue.push(node);
  }

  private processDecrease(node: LightNode) {
    const current = this.world.getLight(node.channel, node.x, node.y, node.z);
    if (current > 0) this.world.setLight(node.channel, node.x, node.y, node.z, 0);
    for (const [dx, dy, dz] of DIRECTIONS) {
      const x = node.x + dx;
      const y = node.y + dy;
      const z = node.z + dz;
      const neighborLevel = this.world.getLight(node.channel, x, y, z);
      if (neighborLevel === 0) continue;
      if (neighborLevel < node.level) this.queueDecrease(node.channel, x, y, z, neighborLevel);
      else this.queueIncrease(node.channel, x, y, z);
    }
  }

  private processIncrease(node: LightNode) {
    const id = this.world.getBlock(node.x, node.y, node.z);
    const emission = node.channel === 'blockLight' ? this.world.emissionAt(id, node.x, node.y, node.z) : 0;
    const opacity = blockLightProperties[id].opacity;
    if (opacity >= 15) {
      this.world.setLight(node.channel, node.x, node.y, node.z, emission);
      return;
    }
    let target = Math.max(emission, node.channel === 'skyLight' && this.hasSkyAccess(node.x, node.y, node.z) ? 15 : 0);
    for (const [dx, dy, dz] of DIRECTIONS) {
      const neighbor = this.world.getLight(node.channel, node.x + dx, node.y + dy, node.z + dz);
      target = Math.max(target, neighbor - 1);
    }
    const current = this.world.getLight(node.channel, node.x, node.y, node.z);
    if (target > current) {
      this.world.setLight(node.channel, node.x, node.y, node.z, target);
      if (target > 1) for (const [dx, dy, dz] of DIRECTIONS) this.queueIncrease(node.channel, node.x + dx, node.y + dy, node.z + dz);
    } else if (target < current) {
      this.queueDecrease(node.channel, node.x, node.y, node.z, current);
    }
  }

  private nodeKey(node: LightNode) {
    return `${node.channel}:${node.x},${node.y},${node.z}`;
  }

  private hasSkyAccess(x: number, y: number, z: number) {
    for (let checkY = y + 1; checkY < CHUNK_HEIGHT; checkY += 1) {
      if (blockLightProperties[this.world.getBlock(x, checkY, z)].opacity > 0) return false;
    }
    return true;
  }
}

type LightChannel = 'skyLight' | 'blockLight';

type LightNode = {
  x: number;
  y: number;
  z: number;
  level: number;
  channel: LightChannel;
};

import * as THREE from 'three';
import { BlockId } from './block';
import type { World } from './world';
import type { LoopHandle, SoundManager } from './sound-manager';

type AmbientType = 'fire' | 'water' | 'lava';

const RADIUS = 8;
const SCAN_INTERVAL = 0.25; // seconds between block scans
const MAX_VOLUME: Record<AmbientType, number> = { fire: 0.5, water: 0.32, lava: 0.5 };

/**
 * "Static" block sounds: the player hears fire / water / lava ambience from any
 * such block within 8 blocks, but only ONE looping instance per type at a time,
 * its volume scaled by the nearest source. Lava also pops occasionally.
 */
export class AmbientSoundEngine {
  private readonly loops = new Map<AmbientType, LoopHandle>();
  private readonly nearest = new Map<AmbientType, number>(); // nearest distance, or Infinity
  private scanAccum = SCAN_INTERVAL;
  private lavaPopTimer = 0;

  constructor(
    private readonly sound: SoundManager,
    private readonly world: World,
  ) {}

  update(pos: THREE.Vector3, dt: number): void {
    this.scanAccum += dt;
    if (this.scanAccum >= SCAN_INTERVAL) {
      this.scanAccum = 0;
      this.scan(pos);
    }

    // Occasional lava pop while lava is in range.
    const lavaDist = this.nearest.get('lava') ?? Infinity;
    if (lavaDist <= RADIUS) {
      this.lavaPopTimer -= dt;
      if (this.lavaPopTimer <= 0) {
        this.lavaPopTimer = 1.5 + Math.random() * 2.5;
        this.sound.playOne('liquids/Lava_pop', this.volumeFor('lava', lavaDist) * 0.8);
      }
    } else {
      this.lavaPopTimer = 0;
    }
  }

  /** Stop every ambient loop (leaving the world, death screen, etc.). */
  stopAll(): void {
    for (const handle of this.loops.values()) handle.stop();
    this.loops.clear();
    this.nearest.clear();
  }

  private volumeFor(type: AmbientType, dist: number): number {
    return Math.max(0, MAX_VOLUME[type] * (1 - dist / RADIUS));
  }

  private scan(pos: THREE.Vector3): void {
    const cx = Math.round(pos.x);
    const cy = Math.round(pos.y);
    const cz = Math.round(pos.z);

    let fire = Infinity;
    let water = Infinity;
    let lava = Infinity;

    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        for (let dz = -RADIUS; dz <= RADIUS; dz++) {
          const id = this.world.getBlock(cx + dx, cy + dy, cz + dz);
          if (id !== BlockId.FIRE && id !== BlockId.WATER && id !== BlockId.LAVA) continue;
          const d = Math.hypot(dx, dy, dz);
          if (d > RADIUS) continue;
          if (id === BlockId.FIRE) fire = Math.min(fire, d);
          else if (id === BlockId.WATER) water = Math.min(water, d);
          else lava = Math.min(lava, d);
        }
      }
    }

    this.apply('fire', fire, 'blocks/Fire');
    this.apply('water', water, `liquids/Water${1 + Math.floor(Math.random() * 2)}`);
    this.apply('lava', lava, 'liquids/Lava');
  }

  private apply(type: AmbientType, dist: number, relPath: string): void {
    this.nearest.set(type, dist);
    const present = dist <= RADIUS;
    const handle = this.loops.get(type);

    if (present && !handle) {
      this.loops.set(type, this.sound.startLoop(relPath, this.volumeFor(type, dist)));
    } else if (present && handle) {
      handle.setVolume(this.volumeFor(type, dist));
    } else if (!present && handle) {
      handle.stop();
      this.loops.delete(type);
    }
  }
}

import * as THREE from 'three';
import { DayNightCycle, DayNightState } from './day-night-cycle';
import { UnderwaterManager, UnderwaterState } from './underwater-manager';
import type { LightEngine } from './light-engine';
import type { PlayerController } from './player';
import type { World } from './world';
import type { PauseMenu } from './pause-menu';

export type GameLoopMetrics = {
  lightMs: number;
  meshMs: number;
  renderMs: number;
  lightReason: string;
  processedLight: number;
  pendingLight: number;
  dirtySubchunks: number;
};

export type GameLoopState = {
  dayNight: DayNightState;
  underwater: UnderwaterState;
  metrics: GameLoopMetrics;
};

const TARGET_FRAME_MS = 1000 / 60;
const EMA_SMOOTHING = 0.1;

/**
 * Scales a per-frame work budget (chunk streaming, mesh rebuilds) by how much
 * headroom recent frames actually had relative to 60fps, instead of a fixed
 * number picked once and never revisited. A smoothed (EMA) frame time avoids
 * reacting to a single jittery frame - a machine that's consistently slow
 * gets less streaming work per frame (leaving more room for rendering), a
 * machine with headroom gets more (loads the world faster without wasting
 * margin it doesn't need). min/max keep it from ever hitting 0 (world never
 * finishes loading) or going unbounded (recreates the stutter this exists to
 * avoid).
 */
class FrameBudget {
  private emaMs = TARGET_FRAME_MS;

  update(lastFrameMs: number): void {
    this.emaMs += (lastFrameMs - this.emaMs) * EMA_SMOOTHING;
  }

  scale(base: number, min: number, max: number): number {
    const factor = TARGET_FRAME_MS / Math.max(this.emaMs, 1);
    return Math.max(min, Math.min(max, base * factor));
  }
}

export class GameLoop {
  private readonly frameBudget = new FrameBudget();
  constructor(
    private readonly world: World,
    private readonly player: PlayerController,
    private readonly lightEngine: LightEngine,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: THREE.Scene,
    private readonly pauseMenu: PauseMenu,
    private readonly dayNightCycle: DayNightCycle,
    private readonly underwaterManager: UnderwaterManager,
  ) {}

  update(delta: number, elapsedTime: number): GameLoopState {
    // Cap delta to prevent spiral of death
    const cappedDelta = Math.min(delta, 0.05);
    this.frameBudget.update(delta * 1000); // delta is the PREVIOUS frame's duration (main.ts's clock.getDelta())

    // Player input and movement. Runs whenever the game isn't paused (Tab menu) -
    // UI overlays like the inventory only block movement input (see
    // PlayerController.setMovementLocked), they don't freeze physics/gravity.
    if (!this.pauseMenu.isPaused) {
      this.player.update(cappedDelta);
    }

    // World updates
    this.world.updateLoadedChunks(this.player.state.position.x, this.player.state.position.z);
    this.world.loadPendingChunks(
      this.frameBudget.scale(3, 1, 6),
      Math.round(this.frameBudget.scale(32, 8, 48)),
    ); // build queued chunks, time-budgeted (adaptive - see FrameBudget)
    this.world.updateLeavesDecay(cappedDelta);
    this.world.updateWaterAnimation(elapsedTime);
    this.world.updateWater(cappedDelta);
    this.world.updateFire(cappedDelta);

    // Light updates
    const lightStartedAt = performance.now();
    let lightReason = this.world.consumeLightUpdateReason();
    this.world.processLightUpdates();
    const lightMs = performance.now() - lightStartedAt;

    // Mesh updates
    const meshStartedAt = performance.now();
    this.world.rebuildDirtyMeshes(
      this.player.state.position.x,
      this.player.state.position.y,
      this.player.state.position.z,
      Math.round(this.frameBudget.scale(3, 1, 6)), // subchunk mesh rebuilds per frame (adaptive)
    );
    let meshMs = performance.now() - meshStartedAt;

    // Day-night cycle (updates lights and may trigger mesh rebuilds)
    const dayNightState = this.dayNightCycle.update(elapsedTime);
    if (dayNightState.changed) {
      lightReason = 'day-night';
    }

    // Underwater effects
    const skyColor = new THREE.Color();
    skyColor.copy(this.scene.background as THREE.Color);
    const underwaterState = this.underwaterManager.update(skyColor);
    this.pauseMenu.setUnderwater(underwaterState.isUnderwater);

    // Chunk culling
    for (const chunk of this.world.chunks.values()) {
      chunk.updateCulling(this.camera, 96);
    }

    return {
      dayNight: dayNightState,
      underwater: underwaterState,
      metrics: {
        lightMs,
        meshMs,
        renderMs: 0, // Will be set by caller after rendering
        lightReason,
        processedLight: this.lightEngine.processedUpdates,
        pendingLight: this.lightEngine.pendingUpdates,
        dirtySubchunks: this.world.dirtySubchunks,
      },
    };
  }
}

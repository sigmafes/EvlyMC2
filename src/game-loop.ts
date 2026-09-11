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

export class GameLoop {
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

    // Player input and movement. Runs whenever the game isn't paused (Tab menu) -
    // UI overlays like the inventory only block movement input (see
    // PlayerController.setMovementLocked), they don't freeze physics/gravity.
    if (!this.pauseMenu.isPaused) {
      this.player.update(cappedDelta);
    }

    // World updates
    this.world.updateLoadedChunks(this.player.state.position.x, this.player.state.position.z);
    this.world.loadPendingChunks(3); // build queued chunks, time-budgeted
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
      3, // subchunk mesh rebuilds per frame
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

import * as THREE from 'three';
import type { LightEngine } from './light-engine';
import type { World } from './world';
import {
  DAY_LENGTH, TRANSITION_LENGTH, NIGHT_SKY_DARKEN, CYCLE_LENGTH,
  cycleTimeFor, computeDayNightState, resolveCycleTime, type TimePhase,
} from './day-night-math';

export type { TimePhase };

export type DayNightState = {
  skyDarken: number;
  cycleProgress: number;
  /** 0..1, LCE convention: 0 = noon, 0.5 = midnight. Drives the sky renderer. */
  timeOfDay: number;
  changed: boolean;
};

export class DayNightCycle {
  private readonly dayLength = DAY_LENGTH;
  private readonly transitionLength = TRANSITION_LENGTH;
  private readonly nightSkyDarken = NIGHT_SKY_DARKEN;
  private readonly cycleLength = CYCLE_LENGTH;

  private readonly daySkyColor: THREE.Color;
  private readonly nightSkyColor: THREE.Color;
  private lastSkyDarken = -1;
  private timeOffset = 0;
  private pendingPhase: TimePhase | null = null;
  /** Current position in the cycle (seconds), tracked for world save. */
  private lastCycleTime = this.dayLength / 2;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fog: THREE.Fog,
    private readonly lightEngine: LightEngine,
    private readonly world: World,
    daySkyColor: THREE.Color,
    nightSkyColor: THREE.Color,
  ) {
    this.daySkyColor = daySkyColor.clone();
    this.nightSkyColor = nightSkyColor.clone();
  }

  /** `/time set day|night|sunset|sunrise`: jump the cycle to that moment. */
  setPhase(phase: TimePhase) {
    this.pendingPhase = phase;
  }

  /** Position in the day/night cycle (seconds), for the world save. */
  getCycleTime(): number {
    return this.lastCycleTime;
  }

  /** True from halfway through dusk to halfway through dawn - drives day-only/night-only mob spawning. */
  isNight(): boolean {
    return this.lastSkyDarken > this.nightSkyDarken / 2;
  }

  /** Restore a saved cycle position (call before the first update, elapsed ~= 0). */
  restoreTime(cycleTime: number) {
    this.timeOffset = ((cycleTime % this.cycleLength) + this.cycleLength) % this.cycleLength;
    this.lastCycleTime = this.timeOffset;
  }

  update(elapsedTime: number): DayNightState {
    const rawCycle = elapsedTime % this.cycleLength;
    if (this.pendingPhase) {
      this.timeOffset = cycleTimeFor(this.pendingPhase) - rawCycle;
      this.pendingPhase = null;
    }
    const cycleTime = resolveCycleTime(elapsedTime, this.timeOffset);
    this.lastCycleTime = cycleTime;
    const { skyDarken: nextSkyDarken, timeOfDay } = computeDayNightState(cycleTime);

    let changed = false;
    if (Math.floor(nextSkyDarken) !== this.lastSkyDarken) {
      this.lastSkyDarken = Math.floor(nextSkyDarken);
      this.lightEngine.setSkyDarken(this.lastSkyDarken);
      this.world.rebuildMeshes();
      changed = true;
    }

    const skyColor = this.daySkyColor.clone().lerp(this.nightSkyColor, nextSkyDarken / this.nightSkyDarken);
    this.scene.background = skyColor;
    this.fog.color.copy(skyColor);

    return {
      skyDarken: this.lastSkyDarken,
      cycleProgress: cycleTime / this.cycleLength,
      timeOfDay,
      changed,
    };
  }
}

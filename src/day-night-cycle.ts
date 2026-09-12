import * as THREE from 'three';
import type { LightEngine } from './light-engine';
import type { World } from './world';

export type TimePhase = 'day' | 'night' | 'sunset' | 'sunrise';

export type DayNightState = {
  skyDarken: number;
  cycleProgress: number;
  /** 0..1, LCE convention: 0 = noon, 0.5 = midnight. Drives the sky renderer. */
  timeOfDay: number;
  changed: boolean;
};

export class DayNightCycle {
  private readonly dayLength = 8 * 60;
  private readonly transitionLength = 60;
  private readonly nightSkyDarken = 11;
  private readonly cycleLength = this.dayLength + this.transitionLength + this.dayLength + this.transitionLength;

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

  private cycleTimeFor(phase: TimePhase): number {
    const day = this.dayLength;
    const trans = this.transitionLength;
    switch (phase) {
      case 'day': return day / 2;                    // noon
      case 'sunset': return day + trans / 2;         // mid dusk transition
      case 'night': return day + trans + day / 2;    // midnight
      case 'sunrise': return 2 * day + trans * 1.5;  // mid dawn transition
    }
  }

  update(elapsedTime: number): DayNightState {
    const rawCycle = elapsedTime % this.cycleLength;
    if (this.pendingPhase) {
      this.timeOffset = this.cycleTimeFor(this.pendingPhase) - rawCycle;
      this.pendingPhase = null;
    }
    const cycleTime = (((elapsedTime + this.timeOffset) % this.cycleLength) + this.cycleLength) % this.cycleLength;
    this.lastCycleTime = cycleTime;
    let nextSkyDarken = 0;

    if (cycleTime >= this.dayLength && cycleTime < this.dayLength + this.transitionLength) {
      nextSkyDarken = ((cycleTime - this.dayLength) / this.transitionLength) * this.nightSkyDarken;
    } else if (cycleTime >= this.dayLength + this.transitionLength && cycleTime < this.dayLength + this.transitionLength + this.dayLength) {
      nextSkyDarken = this.nightSkyDarken;
    } else if (cycleTime >= this.dayLength + this.transitionLength + this.dayLength) {
      nextSkyDarken = (1 - (cycleTime - this.dayLength - this.transitionLength - this.dayLength) / this.transitionLength) * this.nightSkyDarken;
    }

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

    // Phase-aligned so the middle of the day period is noon (0) and the middle
    // of the night period is midnight (0.5).
    const timeOfDay = ((cycleTime - this.dayLength / 2) / this.cycleLength + 1) % 1;

    return {
      skyDarken: this.lastSkyDarken,
      cycleProgress: cycleTime / this.cycleLength,
      timeOfDay,
      changed,
    };
  }
}

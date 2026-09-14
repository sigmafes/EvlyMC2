/**
 * Pure day/night cycle math, shared between singleplayer's DayNightCycle
 * (day-night-cycle.ts, which wraps this with THREE.js/World side effects:
 * writing the scene background, fog colour, lightEngine.setSkyDarken and
 * triggering a remesh) and the multiplayer server/client (world-do.ts owns
 * the authoritative clock headlessly; multiplayer-game.ts renders it,
 * including running its own client-side LightEngine - see that file's doc
 * comment). No THREE/DOM/Worker-runtime dependency, so it works unmodified
 * on both sides of the multiplayer split, the same way TerrainNoise/Chunk
 * already do.
 */

export const DAY_LENGTH = 8 * 60;
export const TRANSITION_LENGTH = 60;
export const NIGHT_SKY_DARKEN = 11;
export const CYCLE_LENGTH = DAY_LENGTH + TRANSITION_LENGTH + DAY_LENGTH + TRANSITION_LENGTH;

export type TimePhase = 'day' | 'night' | 'sunset' | 'sunrise';

export type DayNightState = {
  skyDarken: number;
  cycleProgress: number;
  /** 0..1, LCE convention: 0 = noon, 0.5 = midnight. */
  timeOfDay: number;
};

/** Position in the cycle (seconds) for a named phase's midpoint - used by `/time set`. */
export function cycleTimeFor(phase: TimePhase): number {
  switch (phase) {
    case 'day': return DAY_LENGTH / 2;
    case 'sunset': return DAY_LENGTH + TRANSITION_LENGTH / 2;
    case 'night': return DAY_LENGTH + TRANSITION_LENGTH + DAY_LENGTH / 2;
    case 'sunrise': return 2 * DAY_LENGTH + TRANSITION_LENGTH * 1.5;
  }
}

/** `cycleTime` must already be resolved into [0, CYCLE_LENGTH) - see resolveCycleTime(). */
export function computeDayNightState(cycleTime: number): DayNightState {
  let skyDarken = 0;
  if (cycleTime >= DAY_LENGTH && cycleTime < DAY_LENGTH + TRANSITION_LENGTH) {
    skyDarken = ((cycleTime - DAY_LENGTH) / TRANSITION_LENGTH) * NIGHT_SKY_DARKEN;
  } else if (cycleTime >= DAY_LENGTH + TRANSITION_LENGTH && cycleTime < DAY_LENGTH + TRANSITION_LENGTH + DAY_LENGTH) {
    skyDarken = NIGHT_SKY_DARKEN;
  } else if (cycleTime >= DAY_LENGTH + TRANSITION_LENGTH + DAY_LENGTH) {
    skyDarken = (1 - (cycleTime - DAY_LENGTH - TRANSITION_LENGTH - DAY_LENGTH) / TRANSITION_LENGTH) * NIGHT_SKY_DARKEN;
  }

  // Phase-aligned so the middle of the day period is noon (0) and the middle
  // of the night period is midnight (0.5).
  const timeOfDay = ((cycleTime - DAY_LENGTH / 2) / CYCLE_LENGTH + 1) % 1;

  return { skyDarken, cycleProgress: cycleTime / CYCLE_LENGTH, timeOfDay };
}

/** Wraps `elapsedTime + timeOffset` into [0, CYCLE_LENGTH) - the one bit of modular arithmetic every caller needs before computeDayNightState(). */
export function resolveCycleTime(elapsedTime: number, timeOffset: number): number {
  return (((elapsedTime + timeOffset) % CYCLE_LENGTH) + CYCLE_LENGTH) % CYCLE_LENGTH;
}

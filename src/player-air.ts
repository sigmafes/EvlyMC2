/**
 * Breath / air supply, ported from LCE `Mob::aiStep`:
 * `TOTAL_AIR_SUPPLY = 20 * 15` ticks (15 s). Each tick with the head submerged
 * drains one; once empty an "overdraw" counter runs to -20 (1 s), then resets
 * and deals 2 drowning damage. Surfacing refills instantly.
 */
const MAX = 20 * 15; // 300 ticks
const TICK = 0.05;    // seconds per tick (20 tps)

export class PlayerAir {
  private supply = MAX;
  private overdraw = 0;
  private accum = 0;

  constructor(private readonly onDrownTick: () => void) {}

  update(dt: number, headUnderwater: boolean): void {
    this.accum += dt;
    // Guard against huge dt spikes (tab refocus) draining a full lungful at once.
    let steps = Math.min(Math.floor(this.accum / TICK), 40);
    this.accum -= steps * TICK;
    while (steps-- > 0) this.tick(headUnderwater);
  }

  private tick(headUnderwater: boolean): void {
    if (!headUnderwater) {
      this.supply = MAX;
      this.overdraw = 0;
      return;
    }
    if (this.supply > 0) {
      this.supply--;
      return;
    }
    this.overdraw--;
    if (this.overdraw <= -20) {
      this.overdraw = 0;
      this.onDrownTick();
    }
  }

  reset(): void {
    this.supply = MAX;
    this.overdraw = 0;
    this.accum = 0;
  }

  /** Bubbles to show, 0..10. */
  get points(): number {
    return Math.max(0, Math.min(10, Math.round(this.supply / (MAX / 10))));
  }

  /** True when the air bar should be hidden (full / not submerged). */
  get full(): boolean {
    return this.supply >= MAX;
  }
}

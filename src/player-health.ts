export type DamageCause = 'fall' | 'fire' | 'drown' | 'generic';

export type DamageOptions = {
  /** Skip i-frames (environmental damage-over-time: lava, fire, drowning). */
  ignoreInvuln?: boolean;
  cause?: DamageCause;
};

/**
 * Player health, LCE-style: 20 points (10 hearts, 2 per heart, 1 per half).
 * A brief invulnerability window after each hit keeps repeated contact damage
 * from draining health instantly.
 */
export class PlayerHealth {
  readonly max = 20;
  current = 20;
  private invuln = 0; // seconds of i-frames remaining
  private dead = false;

  constructor(
    private readonly onDeath: () => void,
    private readonly onHurt: (cause: DamageCause) => void = () => {},
  ) {}

  get isDead(): boolean {
    return this.dead;
  }

  /** Advance i-frame timer; call once per frame. */
  tick(delta: number): void {
    if (this.invuln > 0) this.invuln -= delta;
  }

  damage(amount: number, opts: DamageOptions = {}): void {
    if (this.dead || amount <= 0) return;
    const ignoreInvuln = opts.ignoreInvuln ?? false;
    if (this.invuln > 0 && !ignoreInvuln) return;
    const before = this.current;
    this.current = Math.max(0, this.current - amount);
    if (!ignoreInvuln) this.invuln = 0.5;
    if (this.current <= 0) {
      this.dead = true;
      this.onDeath();
    } else if (this.current < before) {
      this.onHurt(opts.cause ?? 'generic');
    }
  }

  heal(amount: number): void {
    if (this.dead) return;
    this.current = Math.min(this.max, this.current + amount);
  }

  /** Back to full health, alive. */
  reset(): void {
    this.current = this.max;
    this.invuln = 0;
    this.dead = false;
  }
}

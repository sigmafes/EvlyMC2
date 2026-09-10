/**
 * Walking view bob, ported from LCE (`Player::aiStep` accumulators +
 * `GameRenderer::bobView`). Per-tick LCE eases are converted to frame-rate
 * independent `1 - exp(-k·dt)` with k chosen so the factor matches at 20 tps.
 */
export class ViewBob {
  /** Accumulated walk distance; drives the sin/cos phase. */
  walkDist = 0;
  /** 0..~0.1, eased toward the clamped horizontal speed (0 while airborne). */
  bob = 0;
  /** Degrees of extra camera pitch from vertical speed (the landing nod). */
  tilt = 0;
  /** View angles eased at 0.5/tick, for the hand's counter-rotation lag. */
  yawBob = 0;
  pitchBob = 0;

  update(dt: number, o: {
    horizontalDistance: number; // blocks moved on XZ this frame
    horizontalSpeed: number;    // blocks/sec on XZ
    verticalVelocity: number;   // blocks/sec
    grounded: boolean;
    sneaking: boolean;
    yaw: number;
    pitch: number;
  }): void {
    if (o.grounded && !o.sneaking) {
      this.walkDist += o.horizontalDistance * 0.6;
    }
    this.walkDist %= 2; // sin/cos of (phase·π) has period 2 -> no visible jump

    // LCE tBob = min(|per-tick horizontal move|, 0.1); per-tick = speed / 20.
    let tBob = Math.min(o.horizontalSpeed / 20, 0.1);
    if (!o.grounded) tBob = 0;
    this.bob += (tBob - this.bob) * (1 - Math.exp(-10 * dt)); // LCE 0.4/tick

    // LCE tTilt uses the per-tick vertical delta (bps / 20).
    let tTilt = Math.atan((-o.verticalVelocity / 20) * 0.2) * 15;
    if (o.grounded) tTilt = 0;
    this.tilt += (tTilt - this.tilt) * (1 - Math.exp(-30 * dt)); // LCE 0.8/tick

    const k = 1 - Math.exp(-13.9 * dt); // LCE xBob/yBob 0.5/tick
    this.pitchBob += (o.pitch - this.pitchBob) * k;
    this.yawBob += (o.yaw - this.yawBob) * k;
  }

  /** Walk phase fed to sin()/cos() in the bob transform. */
  get phase(): number {
    return -this.walkDist;
  }

  reset(yaw: number, pitch: number): void {
    this.walkDist = 0;
    this.bob = 0;
    this.tilt = 0;
    this.yawBob = yaw;
    this.pitchBob = pitch;
  }
}

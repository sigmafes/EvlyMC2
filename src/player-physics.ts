import * as THREE from 'three';
import type { BlockCollider } from './chunk';
import type { WorldBounds } from './world';

export type PlayerPhysicsState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  grounded: boolean;
  sneaking: boolean;
  eyeHeight: number;
};

/**
 * Pure physics simulation for a player entity.
 * No input handling, no camera, no UI state.
 * Testeable without world or any side effects.
 */
export class PlayerPhysics {
  private readonly playerRadius = 0.3;
  private readonly playerEyeHeight = 1.75;
  private readonly playerHeadClearance = 0.05;
  private readonly spawnPosition: THREE.Vector3;

  // Physics constants
  private readonly GRAVITY = 24;
  private readonly WALK_SPEED = 4.5;
  private readonly SPRINT_SPEED = 6.5;
  private readonly CROUCH_SPEED = 1;
  private readonly JUMP_FORCE = 8;
  private readonly FRICTION = 15;
  private readonly ICE_FRICTION = 2; // much lower friction on ice for slipping
  private readonly AIR_FRICTION = 0.5; // much weaker: preserves momentum while airborne (jumps, falls)
  private readonly ACCELERATION = 35; // blocks/second^2 - how fast velocity ramps up toward target
  private readonly CROUCH_HITBOX = 1.6;
  private readonly NORMAL_HITBOX = 1.9;

  readonly state: PlayerPhysicsState = {
    position: new THREE.Vector3(0, 48.25, 0),
    velocity: new THREE.Vector3(),
    grounded: false,
    sneaking: false,
    eyeHeight: 1.62,
  };

  /** Highest Y reached since leaving the ground; null while grounded/in water. */
  private airPeakY: number | null = null;
  /** Fall distance (blocks) on the frame the player just landed; 0 otherwise. */
  fallImpact = 0;

  constructor(
    private readonly getBlocks: () => Iterable<BlockCollider>,
    private readonly worldBounds?: WorldBounds,
    private readonly isWater?: (x: number, y: number, z: number) => boolean,
    private readonly getWaterFlow?: (x: number, y: number, z: number) => THREE.Vector3,
    private readonly isIce?: (x: number, y: number, z: number) => boolean,
  ) {
    this.spawnPosition = new THREE.Vector3(0, 48.25, 0);
  }

  setSpawn(x: number, y: number, z: number) {
    this.spawnPosition.set(x, y, z);
    this.state.position.copy(this.spawnPosition);
    this.state.velocity.set(0, 0, 0);
    this.airPeakY = null;
    this.fallImpact = 0;
  }

  setSneaking(sneaking: boolean) {
    this.state.sneaking = sneaking;
    this.state.eyeHeight = sneaking ? 1.27 : 1.62;
  }

  isInWater(): boolean {
    if (!this.isWater) return false;
    const minX = Math.round(this.state.position.x - this.playerRadius);
    const maxX = Math.round(this.state.position.x + this.playerRadius);
    const minY = Math.round(this.state.position.y - this.playerEyeHeight);
    const maxY = Math.round(this.state.position.y + this.playerHeadClearance);
    const minZ = Math.round(this.state.position.z - this.playerRadius);
    const maxZ = Math.round(this.state.position.z + this.playerRadius);

    for (let y = minY; y <= maxY; y += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (this.isWater(x, y, z)) return true;
        }
      }
    }
    return false;
  }

  isOnIce(): boolean {
    if (!this.isIce || !this.state.grounded) return false;
    const centerX = Math.round(this.state.position.x);
    const footY = Math.round(this.state.position.y - this.playerEyeHeight);
    const centerZ = Math.round(this.state.position.z);
    return this.isIce(centerX, footY, centerZ);
  }

  /**
   * Update physics given input direction and whether player wants to jump.
   * Movement already rotated by player yaw.
   */
  updatePhysics(direction: THREE.Vector3, wantJump: boolean, sprinting: boolean, delta: number) {
    const inWater = this.isInWater();

    if (inWater) {
      const speed = sprinting ? 3.8 : 2.5;
      const acceleration = direction.lengthSq() > 0 ? 8 : 3;
      const flow = this.getWaterFlow
        ? this.getWaterFlow(this.state.position.x, this.state.position.y - 0.8, this.state.position.z)
        : new THREE.Vector3();

      const targetVelX = direction.x * speed + flow.x * 2.2;
      const targetVelZ = direction.z * speed + flow.z * 2.2;
      this.state.velocity.x = THREE.MathUtils.damp(this.state.velocity.x, targetVelX, acceleration, delta);
      this.state.velocity.z = THREE.MathUtils.damp(this.state.velocity.z, targetVelZ, acceleration, delta);

      if (wantJump) {
        this.state.velocity.y = THREE.MathUtils.damp(this.state.velocity.y, 3.2, 8, delta);
      } else {
        const fallSpeed = flow.y < 0 ? -3.5 : -1.8;
        this.state.velocity.y = THREE.MathUtils.damp(this.state.velocity.y, fallSpeed, 5, delta);
      }
      this.state.grounded = false;
    } else {
      // Movement speeds
      let speed = this.WALK_SPEED;
      if (sprinting) {
        speed = this.SPRINT_SPEED;
      } else if (this.state.sneaking) {
        speed = this.CROUCH_SPEED;
      }

      // Apply movement with direction - ramp velocity toward target instead of snapping instantly
      const onIce = this.isOnIce();
      if (direction.lengthSq() > 0) {
        const targetVelX = direction.x * speed;
        const targetVelZ = direction.z * speed;
        let acceleration = this.ACCELERATION;
        if (onIce) {
          acceleration *= 0.3; // Reduce acceleration on ice
        } else if (!this.state.grounded) {
          acceleration *= 0.15; // Much less air control to prevent easy direction changes mid-air
        }
        const maxStep = acceleration * delta;
        this.state.velocity.x = this.moveTowards(this.state.velocity.x, targetVelX, maxStep);
        this.state.velocity.z = this.moveTowards(this.state.velocity.z, targetVelZ, maxStep);
      } else {
        // Friction: decay velocity toward 0 when not moving (was *= FRICTION,
        // which multiplied by 2 each frame and made velocity explode exponentially).
        // Much weaker in the air so jumps/falls preserve horizontal momentum
        // instead of stopping dead as soon as you release the movement key.
        let friction = this.AIR_FRICTION;
        if (this.state.grounded) {
          friction = onIce ? this.ICE_FRICTION : this.FRICTION;
        }
        const frictionFactor = Math.max(0, 1 - friction * delta);
        this.state.velocity.x *= frictionFactor;
        this.state.velocity.z *= frictionFactor;
      }

      // Jump (velocity is in blocks/second, delta is applied later at the position step)
      if (wantJump && this.state.grounded) {
        this.state.velocity.y = this.JUMP_FORCE;
        this.state.grounded = false;
      }

      // Gravity (acceleration integrated over time -> blocks/second)
      this.state.velocity.y -= this.GRAVITY * delta;
    }

    // Snap resting vertical velocity so gravity doesn't slowly sink the player
    // into the ground while grounded (which caused false horizontal collisions
    // with the floor block and violent sideways ejections).
    if (this.state.grounded && this.state.velocity.y < 0) {
      this.state.velocity.y = 0;
    }

    const previousBottom = this.state.position.y - this.playerEyeHeight;
    const ledgeGuard = this.state.sneaking && this.state.grounded && this.state.velocity.y <= 0;

    const beforeX = this.state.position.x;
    this.state.position.x += this.state.velocity.x * delta;
    this.resolveHorizontalCollisions('x');
    this.constrainToWorld('x');
    if (ledgeGuard && this.state.position.x !== beforeX && !this.hasGroundBelow()) {
      this.state.position.x = beforeX;
      this.state.velocity.x = 0;
    }

    const beforeZ = this.state.position.z;
    this.state.position.z += this.state.velocity.z * delta;
    this.resolveHorizontalCollisions('z');
    this.constrainToWorld('z');
    if (ledgeGuard && this.state.position.z !== beforeZ && !this.hasGroundBelow()) {
      this.state.position.z = beforeZ;
      this.state.velocity.z = 0;
    }

    this.state.position.y += this.state.velocity.y * delta;
    this.resolveVerticalCollisions(previousBottom);

    if (this.state.position.y < -8) {
      this.state.position.copy(this.spawnPosition);
      this.state.velocity.set(0, 0, 0);
      this.airPeakY = null;
    }

    // Track fall distance so the health system can apply fall damage on landing.
    this.fallImpact = 0;
    if (this.isInWater()) {
      this.airPeakY = null;
    } else if (this.state.grounded) {
      if (this.airPeakY !== null) {
        this.fallImpact = Math.max(0, this.airPeakY - this.state.position.y);
        this.airPeakY = null;
      }
    } else if (this.airPeakY === null || this.state.position.y > this.airPeakY) {
      this.airPeakY = this.state.position.y;
    }
  }

  /**
   * Move a value toward a target by at most maxStep. Linear ramp, frame-rate
   * independent, and never overshoots (unlike a multiplicative/exponential
   * approach which can blow up if the factor is miscalibrated).
   */
  private moveTowards(current: number, target: number, maxStep: number): number {
    const diff = target - current;
    if (Math.abs(diff) <= maxStep) return target;
    return current + Math.sign(diff) * maxStep;
  }

  /**
   * Get current hitbox height (reduced when crouching).
   */
  getHitboxHeight(): number {
    return this.state.sneaking ? this.CROUCH_HITBOX : this.NORMAL_HITBOX;
  }

  /** Horizontal half-extent of the (square) hitbox, in blocks. */
  get radius(): number {
    return this.playerRadius;
  }

  /** Distance from the hitbox bottom (feet) up to state.position, in blocks. */
  get collisionEyeHeight(): number {
    return this.playerEyeHeight;
  }

  /**
   * Prevent falling off edges when crouching.
   * Pulls player back if they're at the edge of a block.
   */
  /** True if any block top sits just under the player's feet, within the hitbox footprint. */
  private hasGroundBelow(): boolean {
    const feet = this.state.position.y - this.playerEyeHeight;
    for (const block of this.getBlocks()) {
      const c = block.collider;
      if (c.max.y < feet - 0.5 || c.max.y > feet + 0.1) continue; // not a floor right below us
      const overlapsX = this.state.position.x + this.playerRadius > c.min.x
        && this.state.position.x - this.playerRadius < c.max.x;
      const overlapsZ = this.state.position.z + this.playerRadius > c.min.z
        && this.state.position.z - this.playerRadius < c.max.z;
      if (overlapsX && overlapsZ) return true;
    }
    return false;
  }

  intersectsBlock(x: number, y: number, z: number) {
    const block = new THREE.Box3(
      new THREE.Vector3(x - 0.5, y - 0.5, z - 0.5),
      new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
    );
    return this.overlapsHorizontally(block) && this.overlapsVertically(block);
  }

  private overlapsHorizontally(block: THREE.Box3) {
    return this.state.position.x + this.playerRadius > block.min.x
      && this.state.position.x - this.playerRadius < block.max.x
      && this.state.position.z + this.playerRadius > block.min.z
      && this.state.position.z - this.playerRadius < block.max.z;
  }

  private overlapsVertically(block: THREE.Box3) {
    const hitboxHeight = this.getHitboxHeight();
    const bottom = this.state.position.y - this.playerEyeHeight;
    const top = this.state.position.y + (hitboxHeight - this.playerEyeHeight);
    return top > block.min.y && bottom < block.max.y;
  }

  private resolveHorizontalCollisions(axis: 'x' | 'z') {
    for (const block of this.getBlocks()) {
      if (!this.overlapsVertically(block.collider)) continue;
      const overlapsX = this.state.position.x + this.playerRadius > block.collider.min.x
        && this.state.position.x - this.playerRadius < block.collider.max.x;
      const overlapsZ = this.state.position.z + this.playerRadius > block.collider.min.z
        && this.state.position.z - this.playerRadius < block.collider.max.z;
      if (!overlapsX || !overlapsZ) continue;

      if (axis === 'x') {
        this.state.position.x = this.state.velocity.x > 0
          ? block.collider.min.x - this.playerRadius
          : block.collider.max.x + this.playerRadius;
        this.state.velocity.x = 0;
      } else {
        this.state.position.z = this.state.velocity.z > 0
          ? block.collider.min.z - this.playerRadius
          : block.collider.max.z + this.playerRadius;
        this.state.velocity.z = 0;
      }
    }
  }

  private resolveVerticalCollisions(previousBottom: number) {
    this.state.grounded = false;
    const hitboxHeight = this.getHitboxHeight();
    const headOffset = hitboxHeight - this.playerEyeHeight; // top of hitbox above state.position
    const previousTop = previousBottom + hitboxHeight;
    for (const block of this.getBlocks()) {
      if (!this.overlapsHorizontally(block.collider)) continue;
      const bottom = this.state.position.y - this.playerEyeHeight;
      const top = bottom + hitboxHeight;
      if (this.state.velocity.y <= 0 && previousBottom >= block.collider.max.y && bottom <= block.collider.max.y) {
        this.state.position.y = block.collider.max.y + this.playerEyeHeight;
        this.state.velocity.y = 0;
        this.state.grounded = true;
      } else if (this.state.velocity.y > 0 && previousTop <= block.collider.min.y && top >= block.collider.min.y) {
        // Head hit the ceiling: clamp so the hitbox top rests just under the block,
        // swept across the whole frame so fast jumps can't tunnel through.
        this.state.position.y = block.collider.min.y - this.playerHeadClearance - headOffset;
        this.state.velocity.y = 0;
      }
    }
  }

  private constrainToWorld(axis: 'x' | 'z') {
    if (!this.worldBounds) return;
    const min = axis === 'x' ? this.worldBounds.minX + this.playerRadius : this.worldBounds.minZ + this.playerRadius;
    const max = axis === 'x' ? this.worldBounds.maxX - this.playerRadius : this.worldBounds.maxZ - this.playerRadius;
    this.state.position[axis] = THREE.MathUtils.clamp(this.state.position[axis], min, max);
    if (this.state.position[axis] === min || this.state.position[axis] === max) this.state.velocity[axis] = 0;
  }
}

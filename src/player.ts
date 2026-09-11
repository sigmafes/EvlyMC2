import * as THREE from 'three';
import { BlockId, isSolidBlock } from './block';
import { PlayerPhysics } from './player-physics';
import { ViewBob } from './view-bob';
import { getBlockSound } from './block-sounds';

const DEG = Math.PI / 180;
import type { BlockCollider } from './chunk';
import type { WorldBounds } from './world';
import type { SoundManager } from './sound-manager';

export type PlayerState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  sneaking: boolean;
};

/**
 * Player controller: handles input, camera, and delegates physics to PlayerPhysics.
 * Responsible for UI state (sprinting, third-person, camera position/rotation).
 */
export class PlayerController {
  readonly state: PlayerState = {
    position: new THREE.Vector3(0, 48.25, 0),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: -0.12,
    grounded: false,
    sneaking: false,
  };

  private readonly physics: PlayerPhysics;
  private readonly thirdPersonOffset = new THREE.Vector3(0, 0, 4.5);
  private readonly keys = new Set<string>();
  private readonly baseFov: number;
  /** LCE F5 cycle: 0 = first person, 1 = third-person behind, 2 = third-person front. */
  private cameraMode = 0;
  private cameraControlEnabled = true;
  private sprinting = false;
  /** On-screen d-pad axis (-1..1 each), merged with the keyboard each frame. */
  private touchMoveX = 0;
  private touchMoveZ = 0;
  private touchJump = false;
  /** True while a UI (inventory) blocks movement input; physics still runs so the world doesn't freeze. */
  private movementLocked = false;
  private lastFootstepTime = 0;
  /** Eased downward camera offset while sneaking (blocks). */
  private crouchCam = 0;
  private static readonly CROUCH_CAM_DROP = 0.3;

  /** Walking view bob (LCE-style). Also drives the first-person hand's bob. */
  readonly viewBob = new ViewBob();
  private viewBobEnabled = true;
  private readonly prevXZ = new THREE.Vector2();
  /** Camera roll impulse from taking damage (seconds remaining, and its sign). */
  private hurtTime = 0;
  private hurtDir = 1;
  private static readonly HURT_DURATION = 0.4;
  /** Rising-edge latch for entering water (splash sound). */
  private wasInWater = false;
  private waterEntered = false;
  /** Timestamp (ms) of the last jump-button press, for double-tap-to-fly. */
  private lastJumpPressTime = 0;
  private static readonly DOUBLE_JUMP_MS = 300;
  /** On death: forced third-person, camera slowly booming out from the death spot. */
  private deathZoomActive = false;
  private deathZoomTimer = 0;
  private static readonly DEATH_ZOOM_DURATION = 10;
  private static readonly DEATH_ZOOM_EXTRA = 8; // blocks added to the third-person distance over DEATH_ZOOM_DURATION

  constructor(
    private readonly camera: THREE.Camera,
    getBlocks: () => Iterable<BlockCollider>,
    worldBounds?: WorldBounds,
    isWater?: (x: number, y: number, z: number) => boolean,
    getWaterFlow?: (x: number, y: number, z: number) => THREE.Vector3,
    isIce?: (x: number, y: number, z: number) => boolean,
    private readonly getBlock?: (x: number, y: number, z: number) => BlockId,
    private readonly soundManager?: SoundManager,
  ) {
    this.physics = new PlayerPhysics(
      getBlocks, worldBounds, isWater, getWaterFlow, isIce,
      this.getBlock ? (x, y, z) => isSolidBlock(this.getBlock!(x, y, z)) : undefined,
    );
    this.baseFov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 0;
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
  }

  /** Blocks movement/jump input while a UI like the inventory is open, without pausing physics. */
  setMovementLocked(locked: boolean) {
    this.movementLocked = locked;
  }

  /** When disabled, the player stops driving the camera (used by free camera mode). */
  setCameraControlEnabled(enabled: boolean) {
    this.cameraControlEnabled = enabled;
  }

  // --- Touch / on-screen controls -----------------------------------------

  /** Virtual analog stick from the on-screen d-pad, x = strafe, z = forward(-)/back(+). */
  setMoveAxis(x: number, z: number) {
    this.touchMoveX = THREE.MathUtils.clamp(x, -1, 1);
    this.touchMoveZ = THREE.MathUtils.clamp(z, -1, 1);
  }

  /** On-screen jump button held state. */
  setJumpHeld(held: boolean) {
    if (held && !this.touchJump) this.registerJumpPress();
    this.touchJump = held;
  }

  /** /fly permission: without it, double-tapping jump does nothing. */
  setFlyEnabled(enabled: boolean) {
    this.physics.setCanFly(enabled);
  }

  get flyEnabled(): boolean {
    return this.physics.flyEnabled;
  }

  get isFlying(): boolean {
    return this.physics.isFlying;
  }

  /** Two jump presses within DOUBLE_JUMP_MS toggle flight (needs /fly on first). */
  private registerJumpPress() {
    const now = performance.now();
    if (now - this.lastJumpPressTime < PlayerController.DOUBLE_JUMP_MS) {
      this.physics.setFlying(!this.physics.isFlying);
      this.lastJumpPressTime = 0;
    } else {
      this.lastJumpPressTime = now;
    }
  }

  /** Fired whenever sneak is forced off/on programmatically (sprint <-> sneak exclusion), so the on-screen sneak button can stay in sync. */
  onSneakChange?: (on: boolean) => void;

  /** On-screen sneak toggle. */
  setSneak(on: boolean) {
    if (on) this.setSprint(false);
    this.physics.setSneaking(on);
  }

  /** On-screen third-person button: LCE F5 cycle (1st -> 3rd back -> 3rd front). */
  cycleCameraMode() {
    this.cameraMode = (this.cameraMode + 1) % 3;
  }

  /** Double-tap-forward sprint (auto-clears when movement stops, like MCPE). */
  setSprint(on: boolean) {
    this.sprinting = on;
    // Sprint and sneak are mutually exclusive (can't run while crouched, or
    // vice versa): activating one cancels the other, and the on-screen
    // sneak button is told so its pressed-visual doesn't get out of sync.
    if (on && this.state.sneaking) {
      this.physics.setSneaking(false);
      this.onSneakChange?.(false);
    }
  }

  get sneaking() {
    return this.state.sneaking;
  }

  update(delta: number) {
    const direction = new THREE.Vector3();
    if (!this.movementLocked) {
      if (this.keys.has('KeyW')) direction.z -= 1;
      if (this.keys.has('KeyS')) direction.z += 1;
      if (this.keys.has('KeyA')) direction.x -= 1;
      if (this.keys.has('KeyD')) direction.x += 1;
      direction.x += this.touchMoveX;
      direction.z += this.touchMoveZ;
      direction.x = THREE.MathUtils.clamp(direction.x, -1, 1);
      direction.z = THREE.MathUtils.clamp(direction.z, -1, 1);
    }
    const isMoving = direction.lengthSq() > 0;
    if (!isMoving) this.sprinting = false;
    if (isMoving) direction.normalize();
    direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.state.yaw);

    const wantJump = !this.movementLocked && (this.keys.has('Space') || this.touchJump);
    this.physics.updatePhysics(direction, wantJump, this.sprinting, delta);

    this.state.position.copy(this.physics.state.position);
    this.state.velocity.copy(this.physics.state.velocity);
    this.state.grounded = this.physics.state.grounded;
    this.state.sneaking = this.physics.state.sneaking;

    const inWater = this.physics.isInWater();
    if (inWater && !this.wasInWater) this.waterEntered = true;
    this.wasInWater = inWater;

    this.crouchCam = THREE.MathUtils.damp(
      this.crouchCam,
      this.state.sneaking ? PlayerController.CROUCH_CAM_DROP : 0,
      12,
      delta,
    );

    // Walking view bob: feed it this frame's horizontal travel + state.
    const dx = this.state.position.x - this.prevXZ.x;
    const dz = this.state.position.z - this.prevXZ.y;
    this.prevXZ.set(this.state.position.x, this.state.position.z);
    this.viewBob.update(delta, {
      horizontalDistance: Math.hypot(dx, dz),
      horizontalSpeed: Math.hypot(this.state.velocity.x, this.state.velocity.z),
      verticalVelocity: this.state.velocity.y,
      grounded: this.state.grounded,
      sneaking: this.state.sneaking,
      yaw: this.state.yaw,
      pitch: this.state.pitch,
    });
    if (this.hurtTime > 0) this.hurtTime = Math.max(0, this.hurtTime - delta);

    // Play footstep sounds
    this.updateFootsteps(delta, direction);

    this.updateCamera();
  }

  private updateCamera() {
    if (!this.cameraControlEnabled) return;
    const eye = this.state.position.clone();
    eye.y -= this.crouchCam;
    if (this.cameraMode !== 0) {
      // Front view (mode 2) swings the boom to the opposite side; the camera
      // still looks back at the player (LCE F5 third-person-front).
      const front = this.cameraMode === 2;
      const desiredOffset = this.thirdPersonOffset.clone()
        .applyAxisAngle(new THREE.Vector3(1, 0, 0), (front ? 1 : -1) * -this.state.pitch)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.state.yaw + (front ? Math.PI : 0));
      const deathZoomOut = this.deathZoomActive
        ? PlayerController.DEATH_ZOOM_EXTRA * (this.deathZoomTimer / PlayerController.DEATH_ZOOM_DURATION)
        : 0;
      const maxDist = desiredOffset.length() + deathZoomOut;
      const dir = desiredOffset.clone().normalize();
      const dist = this.cameraCollisionDistance(eye, dir, maxDist);
      this.camera.position.copy(dir).multiplyScalar(dist).add(eye);
      this.camera.lookAt(eye);
    } else {
      this.camera.position.copy(eye);
      this.camera.rotation.set(this.state.pitch, this.state.yaw, 0, 'YXZ');
      this.applyViewBob();
    }
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const targetFov = this.baseFov + (this.sprinting ? 8 : 0);
      this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 8, 0.016);
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Voxel-stepping camera boom collision: walks from the player's eye toward
   * the desired third-person camera position and stops just before the first
   * solid block, so the boom no longer clips through walls/terrain.
   */
  private cameraCollisionDistance(eye: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number {
    if (!this.getBlock) return maxDist;
    const step = 0.1;
    for (let dist = step; dist <= maxDist; dist += step) {
      const p = eye.x + dir.x * dist, py = eye.y + dir.y * dist, pz = eye.z + dir.z * dist;
      const id = this.getBlock(Math.floor(p), Math.floor(py), Math.floor(pz));
      if (isSolidBlock(id)) return Math.max(dist - step, 0.2);
    }
    return maxDist;
  }

  private applyViewBob() {
    const b = this.viewBob.phase;
    const sinb = Math.sin(b * Math.PI);
    const cosb = Math.cos(b * Math.PI);
    const { bob, tilt } = this.viewBob;

    if (this.viewBobEnabled) {
      this.camera.translateX(sinb * bob * 0.5);
      this.camera.translateY(-Math.abs(cosb * bob));
      this.camera.rotateZ(sinb * bob * 3 * DEG);
      this.camera.rotateX(Math.abs(Math.cos(b * Math.PI - 0.2) * bob) * 5 * DEG + tilt * DEG);
    }
    if (this.hurtTime > 0) {
      const h = this.hurtTime / PlayerController.HURT_DURATION;
      this.camera.rotateZ(Math.sin(h * h * h * h * Math.PI) * 14 * DEG * this.hurtDir);
    }
  }

  setViewBobEnabled(enabled: boolean) {
    this.viewBobEnabled = enabled;
  }

  /** Kick the camera roll from taking damage (LCE bobHurt). */
  hurtImpulse() {
    this.hurtTime = PlayerController.HURT_DURATION;
    this.hurtDir = Math.random() < 0.5 ? -1 : 1;
  }

  /** Knockback from a mob attack: a horizontal shove (dirX,dirZ need not be normalised) at `speed`, plus a small hop. */
  applyKnockback(dirX: number, dirZ: number, speed: number, upSpeed: number) {
    const len = Math.hypot(dirX, dirZ) || 1;
    this.physics.applyKnockback((dirX / len) * speed, (dirZ / len) * speed, upSpeed);
    this.state.velocity.copy(this.physics.state.velocity);
  }

  look(deltaX: number, deltaY: number) {
    // While the free camera owns the view, the player must not rotate.
    if (!this.cameraControlEnabled) return;
    this.state.yaw -= deltaX * 0.0022;
    this.state.pitch -= deltaY * 0.0022;
    this.state.pitch = THREE.MathUtils.clamp(this.state.pitch, -Math.PI / 2.1, Math.PI / 2.1);
  }

  setSpawn(x: number, y: number, z: number) {
    this.physics.setSpawn(x, y, z);
    this.state.position.copy(this.physics.state.position);
    this.state.velocity.copy(this.physics.state.velocity);
    this.prevXZ.set(x, z);
    this.viewBob.reset(this.state.yaw, this.state.pitch);
    this.wasInWater = false;
    this.waterEntered = false;
  }

  /** Fall distance (blocks) from the last landing, cleared on read. 0 if none. */
  consumeFallImpact(): number {
    const v = this.physics.fallImpact;
    this.physics.fallImpact = 0;
    return v;
  }

  /** True once on the frame the player's body first entered water. */
  consumeWaterEntry(): boolean {
    const v = this.waterEntered;
    this.waterEntered = false;
    return v;
  }

  /** Position + look angles, for world save. */
  snapshot() {
    const p = this.state.position;
    return { x: p.x, y: p.y, z: p.z, yaw: this.state.yaw, pitch: this.state.pitch };
  }

  /** Restore a snapshot from a saved world. */
  restore(s: { x: number; y: number; z: number; yaw: number; pitch: number }) {
    this.physics.setSpawn(s.x, s.y, s.z);
    this.state.position.copy(this.physics.state.position);
    this.state.velocity.set(0, 0, 0);
    this.state.yaw = s.yaw;
    this.state.pitch = s.pitch;
    this.prevXZ.set(this.state.position.x, this.state.position.z);
    this.viewBob.reset(s.yaw, s.pitch);
    this.hurtTime = 0;
    this.wasInWater = false;
    this.waterEntered = false;
    this.cameraMode = 0;
    this.deathZoomActive = false;
    this.deathZoomTimer = 0;
  }

  /** Called the moment the player dies: forces third-person so the death animation is visible. */
  startDeathCamera(): void {
    if (this.cameraMode === 0) this.cameraMode = 1;
    this.deathZoomActive = true;
    this.deathZoomTimer = 0;
  }

  /** Advances the death camera boom-out and applies it. Call every frame in place of update() while dead. */
  updateDeathCamera(delta: number): void {
    if (this.deathZoomActive) {
      this.deathZoomTimer = Math.min(this.deathZoomTimer + delta, PlayerController.DEATH_ZOOM_DURATION);
    }
    this.updateCamera();
  }

  isInWater(): boolean {
    return this.physics.isInWater();
  }

  intersectsBlock(x: number, y: number, z: number) {
    return this.physics.intersectsBlock(x, y, z);
  }

  /** Current hitbox dimensions (in blocks) for debug visualisation. */
  getHitbox() {
    return {
      radius: this.physics.radius,
      height: this.physics.getHitboxHeight(),
      collisionEyeHeight: this.physics.collisionEyeHeight,
    };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.code);
    if (event.code === 'ControlLeft' && !event.repeat && this.isMovementKeyPressed()) {
      this.setSprint(true);
    }
    if (event.code === 'KeyI' && !event.repeat) this.cameraMode = (this.cameraMode + 1) % 3;
    if (event.code === 'ShiftLeft') {
      this.setSneak(true);
    }
    if (event.code === 'Space') {
      event.preventDefault();
      if (!event.repeat && !this.movementLocked) this.registerJumpPress();
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
    if (event.code === 'ShiftLeft') {
      this.physics.setSneaking(false);
      this.onSneakChange?.(false);
    }
  };

  private isMovementKeyPressed() {
    return this.keys.has('KeyW') || this.keys.has('KeyS') || this.keys.has('KeyA') || this.keys.has('KeyD');
  }

  private updateFootsteps(delta: number, direction: THREE.Vector3) {
    this.lastFootstepTime -= delta;

    // Play footstep sound if moving and grounded
    if (direction.lengthSq() > 0 && this.state.grounded && this.lastFootstepTime <= 0) {
      this.lastFootstepTime = this.sprinting ? 0.3 : 0.5;

      if (!this.getBlock || !this.soundManager) return;

      // Get the block beneath the player
      const footX = Math.round(this.state.position.x);
      const footY = Math.round(this.state.position.y - 1.8);
      const footZ = Math.round(this.state.position.z);
      const blockBelow = this.getBlock(footX, footY, footZ);

      const sound = getBlockSound(blockBelow, 'hit');
      if (sound) this.soundManager.playSound(sound, 0.5);
    }
  }
}

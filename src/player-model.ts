import * as THREE from 'three';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh, tintByLight } from './block-preview';
import { BLOCK_CATALOG } from './creative-palette';
import { BlockId } from './block';
import { ITEMS, isBlock } from './item';
import {
  getAtlasMaterial, getOverlayMaterial, getSkinAtlasMaterial, applySkinTexture, resetSkinTexture,
  buildArmGeometry, buildArmMesh, buildPlayerModelParts, type PlayerModelParts,
} from './player-model-geometry';

export type ModelAdjustments = {
  head: { x: number; y: number; z: number };
  torso: { x: number; y: number; z: number };
  armLeft: { x: number; y: number; z: number };
  armRight: { x: number; y: number; z: number };
  legs: { x: number; y: number; z: number };
};

export { applySkinTexture, resetSkinTexture, buildArmGeometry, getSkinAtlasMaterial };

/** Shortest signed angle in (-PI, PI]. */
function wrapAngle(a: number): number {
  a = a % (Math.PI * 2);
  if (a <= -Math.PI) a += Math.PI * 2;
  else if (a > Math.PI) a -= Math.PI * 2;
  return a;
}

// --- Sneak pose (MCPE 0.6.1 HumanoidModel::setupAnim) ---
const SNEAK_TORSO_PITCH = -0.5;  // rad, torso leans forward about the neck pivot
const SNEAK_ARM_PITCH = -0.4;    // rad, added on top of the walk swing (same sign as torso lean)
const SNEAK_HEAD_DY = -0.16;      // head drops with the crouch
const SNEAK_HEAD_DZ = -0.07;      // and leans forward (-Z) over the tilted torso
const SNEAK_BODY_DY = -0.08;      // torso + arms + legs sink (head excluded)
const SNEAK_BODY_DZ = -0.03;      // torso + arms + legs shift forward (-Z)
const SNEAK_DAMP = 14;           // higher = snappier in/out
const TORSO_LEN = 0.76;          // torso height; the hips sit this far below the neck pivot

/**
 * Creates a 3D player model (Steve from Minecraft) and drives its animation
 * state (walk cycle, swing, hurt flash, death, sneak). The static geometry
 * itself is built by player-model-geometry.ts.
 */
export class PlayerModel {
  readonly group: THREE.Group;
  private readonly parts: PlayerModelParts;
  private armLeft?: THREE.Mesh;
  private armRight?: THREE.Mesh;
  private armLeftRotation = 0;
  private armRightRotation = 0;
  private heldMesh?: THREE.Group;
  private heldId: number | null = null;
  private lightLevel = 1;
  private legLeftRotation = 0;
  private legRightRotation = 0;
  private isWalking = false;
  private isReturning = false;
  private walkCycleTime = 0;
  private returnStartTime = 0;
  private readonly WALK_CYCLE_DURATION = 1.0; // 1 second for full cycle (0.25s per phase)
  private readonly RETURN_DURATION = 0.3; // 0.3 seconds to return to idle
  private returnStartAngleLeft = 0;
  private returnStartAngleRight = 0;
  private returnStartLegAngleLeft = 0;
  private returnStartLegAngleRight = 0;
  // Third-person attack/mine swing (loro Player::swing) - an overlay on top
  // of the right arm's walk-cycle/idle angle, same duration as the
  // first-person hand's own swing (first-person-hand.ts SWING_DURATION).
  private swinging = false;
  private swingTime = 0;
  private readonly SWING_DURATION = 0.3;
  private readonly SWING_ARC = Math.PI / 2;
  // Hurt flash (same non-emissive 75%-red tint as MobModel.hurt()).
  private hurtFlashTimer = 0;
  private static readonly HURT_FLASH_DURATION = 0.2;
  private static readonly HURT_TINT_STRENGTH = 0.75;
  private static readonly HURT_RED = new THREE.Color(1, 0, 0);
  private static readonly hurtTintScratch = new THREE.Color();
  // Death animation (same treatment as MobModel: topple over Z while
  // permanently red-tinted - see startDeath()/updateDeathAnimation()).
  private dying = false;
  private forcedTint = false;
  private deathTimer = 0;
  static readonly DEATH_SPIN_DURATION = 0.75;
  private slimArms = false;
  private bodyYaw = 0;
  private bodyYawInit = false;
  private sneakTarget = 0;
  private sneakAmount = 0;
  /** Extra arm pitch from the current sneak amount; folded in by the arm setters. */
  private armSneakOffset = 0;

  constructor() {
    this.group = new THREE.Group();
    this.parts = buildPlayerModelParts(this.group);
    this.armLeft = buildArmMesh(this.parts.armLeftGroup, 'left', this.slimArms);
    this.armRight = buildArmMesh(this.parts.armRightGroup, 'right', this.slimArms);
  }

  /** Toggle slim ("Alex") arms. Rebuilds both arm meshes. */
  setSlimArms(slim: boolean) {
    if (this.slimArms === slim) return;
    this.slimArms = slim;
    this.armLeft = buildArmMesh(this.parts.armLeftGroup, 'left', slim, this.armLeft);
    this.armRight = buildArmMesh(this.parts.armRightGroup, 'right', slim, this.armRight);
  }

  /**
   * Get the group for adding to scene.
   */
  getGroup(): THREE.Group {
    return this.group;
  }

  /**
   * Apply position adjustments to model parts.
   */
  setAdjustments(adjustments: ModelAdjustments) {
    const s = this.sneakAmount;
    const { head, torsoGroup, armLeftGroup, armRightGroup, legLeftGroup, legRightGroup } = this.parts;
    head.position.x = adjustments.head.x;
    head.position.y = 0.02 + adjustments.head.y + SNEAK_HEAD_DY * s;
    head.position.z = adjustments.head.z + SNEAK_HEAD_DZ * s;
    // Whole-body crouch shift (head excluded).
    const bodyDy = SNEAK_BODY_DY * s;
    const bodyDz = SNEAK_BODY_DZ * s;
    torsoGroup.position.x = adjustments.torso.x;
    torsoGroup.position.y = -0.24 + adjustments.torso.y + bodyDy;
    torsoGroup.position.z = adjustments.torso.z + bodyDz;
    armLeftGroup.position.x = -0.4125 + adjustments.armLeft.x;
    armLeftGroup.position.y = -0.24 + adjustments.armLeft.y + bodyDy;
    armLeftGroup.position.z = adjustments.armLeft.z + bodyDz;
    armRightGroup.position.x = 0.4125 + adjustments.armRight.x;
    armRightGroup.position.y = -0.24 + adjustments.armRight.y + bodyDy;
    armRightGroup.position.z = adjustments.armRight.z + bodyDz;
    // Follow the torso's bottom edge as it swings on the neck pivot, so the hips
    // stay glued to the torso instead of tearing away.
    const theta = SNEAK_TORSO_PITCH * s;
    const hipDy = TORSO_LEN * (1 - Math.cos(theta)); // rises slightly
    const hipDz = -TORSO_LEN * Math.sin(theta);      // moves forward (-Z)
    legLeftGroup.position.x = -0.13875 + adjustments.legs.x;
    legLeftGroup.position.y = -0.99 + adjustments.legs.y + hipDy + bodyDy;
    legLeftGroup.position.z = adjustments.legs.z + hipDz + bodyDz;
    legRightGroup.position.x = 0.13875 + adjustments.legs.x;
    legRightGroup.position.y = -0.99 + adjustments.legs.y + hipDy + bodyDy;
    legRightGroup.position.z = adjustments.legs.z + hipDz + bodyDz;
  }

  /**
   * Rotate left arm on X axis (angle in radians, positive = forward swing).
   */
  setLeftArmRotation(angle: number) {
    this.armLeftRotation = angle;
    this.parts.armLeftGroup.rotation.x = angle + this.armSneakOffset;
  }

  /**
   * Get left arm rotation angle.
   */
  getLeftArmRotation(): number {
    return this.armLeftRotation;
  }

  /**
   * Rotate right arm on X axis (angle in radians, positive = backward swing).
   */
  setRightArmRotation(angle: number) {
    this.armRightRotation = angle;
    this.parts.armRightGroup.rotation.x = angle + this.armSneakOffset;
  }

  /**
   * Get right arm rotation angle.
   */
  getRightArmRotation(): number {
    return this.armRightRotation;
  }

  /**
   * Rotate left leg on X axis (angle in radians, opposite of left arm).
   */
  setLeftLegRotation(angle: number) {
    this.legLeftRotation = angle;
    this.parts.legLeftGroup.rotation.x = angle;
  }

  /**
   * Rotate right leg on X axis (angle in radians, opposite of right arm).
   */
  setRightLegRotation(angle: number) {
    this.legRightRotation = angle;
    this.parts.legRightGroup.rotation.x = angle;
  }

  /**
   * Start walking animation.
   */
  startWalking() {
    if (!this.isWalking) {
      this.walkCycleTime = 0;
    }
    this.isWalking = true;
  }

  /**
   * Stop walking animation, smoothly return to idle pose.
   */
  stopWalking() {
    if (this.isWalking) {
      this.isWalking = false;
      this.isReturning = true;
      this.returnStartTime = 0;
      this.returnStartAngleLeft = this.armLeftRotation;
      this.returnStartAngleRight = this.armRightRotation;
      this.returnStartLegAngleLeft = this.legLeftRotation;
      this.returnStartLegAngleRight = this.legRightRotation;
    }
  }

  /** Start (or restart) the third-person attack/mine swing overlay. */
  swingArm(): void {
    this.swingTime = 0;
    this.swinging = true;
  }

  /** Advances the swing timer and returns this frame's overlay angle for the right arm (0 when not swinging). */
  private updateSwing(deltaTime: number): number {
    if (!this.swinging) return 0;
    this.swingTime += deltaTime;
    if (this.swingTime >= this.SWING_DURATION) {
      this.swinging = false;
      return 0;
    }
    const t = this.swingTime / this.SWING_DURATION;
    // Single forward-and-back arc. setRightArmRotation's own doc comment
    // claims positive = backward, but that reads backward in practice (the
    // negative sign this used to have threw the arm behind the body instead
    // of forward into the swing) - positive is what actually swings forward.
    return Math.sin(t * Math.PI) * this.SWING_ARC;
  }

  /**
   * Update walking animation (call every frame with delta time in seconds).
   */
  updateWalkingAnimation(deltaTime: number) {
    const swingOffset = this.updateSwing(deltaTime);

    // Handle return to idle pose
    if (this.isReturning) {
      this.returnStartTime += deltaTime;
      const returnProgress = Math.min(this.returnStartTime / this.RETURN_DURATION, 1);

      // Smooth interpolation from current angles to 0
      const leftArmAngle = this.returnStartAngleLeft * (1 - returnProgress);
      const rightArmAngle = this.returnStartAngleRight * (1 - returnProgress);
      const leftLegAngle = this.returnStartLegAngleLeft * (1 - returnProgress);
      const rightLegAngle = this.returnStartLegAngleRight * (1 - returnProgress);

      this.setLeftArmRotation(leftArmAngle);
      this.setRightArmRotation(rightArmAngle + swingOffset);
      this.setLeftLegRotation(leftLegAngle);
      this.setRightLegRotation(rightLegAngle);

      if (returnProgress >= 1) {
        this.isReturning = false;
      }
      return;
    }

    if (!this.isWalking) {
      // Fully idle: the swing overlay still needs to play (and to reset the
      // arm to exactly 0 for one extra frame once it finishes, since the arc
      // only asymptotically nears 0 rather than landing on it exactly).
      if (swingOffset !== 0 || this.armRightRotation !== 0) this.setRightArmRotation(swingOffset);
      return;
    }

    this.walkCycleTime += deltaTime;
    if (this.walkCycleTime >= this.WALK_CYCLE_DURATION) {
      this.walkCycleTime -= this.WALK_CYCLE_DURATION;
    }

    const cycleProgress = this.walkCycleTime / this.WALK_CYCLE_DURATION;

    // Left arm animation (rotating around shoulder on Y axis):
    // 0.0-0.25: 0° to 45° (forward swing)
    // 0.25-0.5: 45° to 0° (returns)
    // 0.5-0.75: 0° to -45° (backward swing)
    // 0.75-1.0: -45° to 0° (returns)

    let leftArmAngle = 0;

    if (cycleProgress < 0.25) {
      // 0-0.5s: 0° -> 45°
      leftArmAngle = (Math.PI / 4) * (cycleProgress / 0.25);
    } else if (cycleProgress < 0.5) {
      // 0.5-1.0s: 45° -> 0°
      leftArmAngle = (Math.PI / 4) * (1 - (cycleProgress - 0.25) / 0.25);
    } else if (cycleProgress < 0.75) {
      // 1.0-1.5s: 0° -> -45°
      leftArmAngle = -(Math.PI / 4) * ((cycleProgress - 0.5) / 0.25);
    } else {
      // 1.5-2.0s: -45° -> 0°
      leftArmAngle = -(Math.PI / 4) * (1 - (cycleProgress - 0.75) / 0.25);
    }

    // Right arm animation: opposite of left
    let rightArmAngle = 0;

    if (cycleProgress < 0.25) {
      // 0-0.5s: 0° -> -45°
      rightArmAngle = -(Math.PI / 4) * (cycleProgress / 0.25);
    } else if (cycleProgress < 0.5) {
      // 0.5-1.0s: -45° -> 0°
      rightArmAngle = -(Math.PI / 4) * (1 - (cycleProgress - 0.25) / 0.25);
    } else if (cycleProgress < 0.75) {
      // 1.0-1.5s: 0° -> 45°
      rightArmAngle = (Math.PI / 4) * ((cycleProgress - 0.5) / 0.25);
    } else {
      // 1.5-2.0s: 45° -> 0°
      rightArmAngle = (Math.PI / 4) * (1 - (cycleProgress - 0.75) / 0.25);
    }

    // Legs animate opposite to arms: when left arm goes forward, left leg goes back
    let leftLegAngle = -leftArmAngle;
    let rightLegAngle = -rightArmAngle;

    this.setLeftArmRotation(leftArmAngle);
    this.setRightArmRotation(rightArmAngle + swingOffset);
    this.setLeftLegRotation(leftLegAngle);
    this.setRightLegRotation(rightLegAngle);
  }

  /**
   * Orient the model to a fixed yaw and reset the head to neutral.
   * Used by free camera mode, where the player itself never rotates.
   */
  faceYaw(yaw: number) {
    this.group.rotation.y = yaw;
    this.bodyYaw = yaw;
    this.bodyYawInit = true;
    this.parts.head.rotation.set(0, 0, 0);
  }

  /**
   * Directly pose the model for the inventory doll — no easing, no head clamp
   * (LCE UIControl_MinecraftPlayer). `headYawLocal` is relative to the body.
   */
  setInventoryPose(bodyYaw: number, headYawLocal: number, headPitch: number) {
    this.group.rotation.y = bodyYaw;
    this.bodyYaw = bodyYaw;
    this.bodyYawInit = true;
    const head = this.parts.head;
    head.rotation.order = 'YXZ';
    head.rotation.y = headYawLocal;
    head.rotation.x = headPitch;
  }

  /**
   * Minecraft-style body/head rotation (port of Mob::tick + MobRenderer):
   * the body eases toward the movement direction with lag, the head points where
   * the player looks, and the head is clamped to +/-75 deg from the body.
   */
  setOrientation(lookYaw: number, lookPitch: number, velX: number, velZ: number, delta: number) {
    if (!this.bodyYawInit) {
      this.bodyYaw = lookYaw;
      this.bodyYawInit = true;
    }

    // Body target: movement direction when moving, otherwise hold.
    let bodyTarget = this.bodyYaw;
    if (velX * velX + velZ * velZ > 0.0025) {
      bodyTarget = Math.atan2(-velX, -velZ); // model forward is -Z
    }

    // Ease toward target. MC uses 0.3 per 50 ms tick -> lambda ~= 7.1.
    this.bodyYaw += wrapAngle(bodyTarget - this.bodyYaw) * (1 - Math.exp(-7.1 * delta));

    // Head/body coupling: head is limited to +/-75 deg of the body.
    const CLAMP = (75 * Math.PI) / 180;
    const EXTRA = (50 * Math.PI) / 180;
    let headDiff = wrapAngle(lookYaw - this.bodyYaw);
    headDiff = THREE.MathUtils.clamp(headDiff, -CLAMP, CLAMP);
    this.bodyYaw = lookYaw - headDiff;
    if (headDiff * headDiff > EXTRA * EXTRA) {
      // Extra catch-up while the head is turned far (MC: += headDiff * 0.2/tick).
      this.bodyYaw += headDiff * (1 - Math.exp(-4.5 * delta));
    }

    this.group.rotation.y = this.bodyYaw;
    const head = this.parts.head;
    head.rotation.order = 'YXZ';
    // LCE HumanoidModel::setupAnim: head.yRot = headYaw - bodyYaw, head.xRot = pitch.
    // Sign check (same property the inventory doll drives): head.rotation.x < 0
    // tips the face DOWN, and `state.pitch` is negative when looking down, so
    // the raw look pitch passes straight through.
    head.rotation.y = wrapAngle(lookYaw - this.bodyYaw);
    head.rotation.x = lookPitch;
  }

  /**
   * Show the selected hotbar block/item in the model's right fist, for the
   * third-person views (LCE PlayerRenderer renders the held stack at the hand).
   * `null` empties the hand.
   */
  setHeldItem(id: number | null) {
    if (id === this.heldId) return;
    this.heldId = id;
    const handAnchor = this.parts.handAnchor;

    if (this.heldMesh) {
      handAnchor.remove(this.heldMesh);
      disposeBlockMesh(this.heldMesh);
      this.heldMesh = undefined;
    }
    if (id == null) return;

    if (id === BlockId.TORCH) {
      // Not a cube in the world - hold it like an item (pixel-extruded), but
      // upright (no tool-style Y-flip/roll: the flame has to stay pointing up).
      const mesh = buildItemMesh('blocks/torch.png');
      mesh.scale.setScalar(0.8);
      mesh.position.set(0, 0.05, -0.12);
      mesh.rotation.set(-10 * (Math.PI / 180), Math.PI / 2, 0);
      this.heldMesh = mesh;
    } else if (isBlock(id)) {
      const slot = BLOCK_CATALOG.find((b) => b.id === id);
      if (!slot) return;
      const mesh = buildBlockMesh(slot);
      // buildBlockMesh is a 1.5-unit cube; the model is ~1 unit per block, and
      // LCE holds roughly a 0.4-block cube in the fist.
      mesh.scale.setScalar(0.27);
      mesh.position.set(0, -0.12, -0.1);
      this.heldMesh = mesh;
    } else if (ITEMS[id]) {
      const mesh = buildItemMesh(ITEMS[id].texture);
      // Negative Y scale mirrors the sprite vertically (a flip, not a spin), so
      // the working end (axe blade, pick head) points DOWN out of the fist
      // without the texture also swapping left-to-right.
      mesh.scale.set(0.72, -0.72, 0.72);
      mesh.position.set(0, 0.10, -0.18);
      // Edge-on to the arm (normal along its side) and tipped forward, like LCE.
      // Z is the sprite's own in-plane roll: -40 - 80 - 180 deg, clockwise.
      mesh.rotation.set(-15 * (Math.PI / 180), Math.PI / 2, -300 * (Math.PI / 180));
      this.heldMesh = mesh;
    }
    if (this.heldMesh) {
      handAnchor.add(this.heldMesh);
      tintByLight(this.heldMesh, this.lightLevel);
    }
  }

  /**
   * Toggle visibility (only visible in 3rd person).
   */
  setVisible(visible: boolean) {
    this.group.visible = visible;
  }

  /** Target the crouch pose (MCPE-style: torso leans, arms lift, legs tuck back). */
  setSneaking(sneaking: boolean) {
    this.sneakTarget = sneaking ? 1 : 0;
  }

  /**
   * Advance the sneak pose toward its target. Call every frame BEFORE
   * setAdjustments and updateWalkingAnimation so the offsets compose.
   */
  updateSneak(deltaTime: number) {
    this.sneakAmount = THREE.MathUtils.damp(this.sneakAmount, this.sneakTarget, SNEAK_DAMP, deltaTime);
    if (Math.abs(this.sneakAmount - this.sneakTarget) < 0.001) this.sneakAmount = this.sneakTarget;

    this.armSneakOffset = SNEAK_ARM_PITCH * this.sneakAmount;
    // Re-apply so the offset shows even while idle (walk anim would otherwise not run).
    this.setLeftArmRotation(this.armLeftRotation);
    this.setRightArmRotation(this.armRightRotation);

    this.parts.torsoGroup.rotation.x = SNEAK_TORSO_PITCH * this.sneakAmount;
  }

  /** Flash red for HURT_FLASH_DURATION - call when the player takes damage. */
  hurt(): void {
    this.hurtFlashTimer = PlayerModel.HURT_FLASH_DURATION;
  }

  /** Starts the death animation (same treatment as MobModel): topple over Z while staying red-tinted. Call once, the instant the player dies. */
  startDeath(): void {
    this.dying = true;
    this.forcedTint = true;
    this.deathTimer = 0;
  }

  /** Advances the death topple; call every frame instead of updateWalkingAnimation while dying. Returns true once the topple has finished. */
  updateDeathAnimation(delta: number): boolean {
    if (!this.dying) return false;
    this.deathTimer = Math.min(this.deathTimer + delta, PlayerModel.DEATH_SPIN_DURATION);
    this.group.rotation.z = (Math.PI / 2) * (this.deathTimer / PlayerModel.DEATH_SPIN_DURATION);
    return this.deathTimer >= PlayerModel.DEATH_SPIN_DURATION;
  }

  /** Undoes startDeath() - call on respawn. */
  resetDeath(): void {
    this.dying = false;
    this.forcedTint = false;
    this.deathTimer = 0;
    this.group.rotation.z = 0;
    this.setVisible(true);
  }

  /**
   * Tint the whole model by the world light level at its position (0..1),
   * matching the terrain shading curve. Combines with the baked face shading.
   * `delta` (seconds since last call) decays a pending hurt() flash - pass 0
   * (the default) for a call that shouldn't advance it, e.g. the inventory
   * doll forcing itself back to full brightness on the same shared material.
   */
  setLightLevel(level01: number, delta = 0) {
    if (this.hurtFlashTimer > 0) this.hurtFlashTimer = Math.max(0, this.hurtFlashTimer - delta);

    const b = Math.pow(THREE.MathUtils.clamp(level01, 0, 1), 1.25);
    const atlas = getAtlasMaterial();
    const overlay = getOverlayMaterial();
    if (this.hurtFlashTimer > 0 || this.forcedTint) {
      // Non-emissive: tint the lit base colour toward red instead of
      // overriding it outright, so the flash still darkens in shade.
      PlayerModel.hurtTintScratch.setScalar(b).lerp(PlayerModel.HURT_RED, PlayerModel.HURT_TINT_STRENGTH);
      atlas.color.copy(PlayerModel.hurtTintScratch);
      overlay.color.copy(PlayerModel.hurtTintScratch);
    } else {
      atlas.color.setScalar(b);
      overlay.color.setScalar(b);
    }
    this.lightLevel = level01;
    if (this.heldMesh) tintByLight(this.heldMesh, level01);
  }

  /**
   * Get model dimensions for reference.
   */
  static getDimensions() {
    return {
      head: { w: 0.5, h: 0.5, d: 0.5 },
      torso: { w: 0.5, h: 0.75, d: 0.25 },
      arms: { w: 0.25, h: 0.75, d: 0.25 },
      legs: { w: 0.25, h: 0.75, d: 0.25 },
      totalHeight: 2,
      hitbox: { width: 0.6, height: 1.8 },
    };
  }
}

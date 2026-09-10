import * as THREE from 'three';
import { buildArmGeometry, getSkinAtlasMaterial } from './player-model';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh } from './block-preview';
import { BLOCK_CATALOG } from './creative-palette';
import { ITEMS, isBlock } from './item';
import type { InventorySlot } from './inventory';

const DEG = Math.PI / 180;

/** Per-frame view-bob state, forwarded from PlayerController so the hand moves with the camera. */
export type HandBobContext = {
  phase: number;
  bob: number;
  tilt: number;   // degrees
  yaw: number;
  pitch: number;
  yawLag: number;
  pitchLag: number;
};

// Resting poses (Phase A). Animations layer on top of these each frame.
const ARM_BASE_POS = new THREE.Vector3(0.58, -0.62, -0.72);
const ARM_BASE_ROT = new THREE.Euler(-78 * DEG, -22 * DEG, 12 * DEG);
const HELD_BASE_POS = new THREE.Vector3(0.62, -0.52, -0.78);
const HELD_BASE_YAW = 45 * DEG;

// Flat item / tool rest pose (loro ItemInHandRenderer 2D-item path): the sprite
// is held diagonally across the lower-right of the view, head up-left.
const ITEM_BASE_POS = new THREE.Vector3(0.52, -0.44, -0.90);
// Yaw is -50 - 40 + 10: the sprite is turned clockwise about Y, eased back 10 deg.
const ITEM_BASE_ROT = new THREE.Euler(-5 * DEG, -80 * DEG, 38 * DEG);

// LCE Player::SWING_DURATION is 6 ticks @ 20 tps == 0.3 s.
const SWING_DURATION = 0.3;
// LCE ItemInHandRenderer::tick moves `height` toward its target at 0.4 / tick == 8 / s.
const EQUIP_SPEED = 8;
// Global damper on the LCE translation magnitudes (its numbers are full blocks;
// the hand camera sits very close, so full swing would throw the item off-screen).
const T = 0.5;

/**
 * First-person view model: the player's right arm plus the held block, drawn as
 * a separate overlay layer (own scene + camera, depth cleared) so it never
 * clips into terrain.
 *
 * Phase B: swing on hit/place, dip-and-spring on place, slide-in on slot change.
 */
export class FirstPersonHand {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(70, 1, 0.01, 10);
  private readonly root = new THREE.Group();
  private readonly arm: THREE.Mesh;
  private held: THREE.Group | null = null;
  private heldId: number | null = null;
  private heldIsBlock = false;
  private slim = false;
  private visible = true;

  // Swing state (LCE Player::swing / getAttackAnim).
  private swinging = false;
  private swingTime = 0;
  // Equip slide (LCE ItemInHandRenderer::height): 0 = lowered off-screen, 1 = rest.
  private height = 1;
  private equipTarget = 1;
  // Eat animation progress 0..1 (LCE ItemInHandRenderer UseAnim_eat).
  private eatProgress = 0;

  private bobCtx: HandBobContext | null = null;

  constructor() {
    this.camera.position.set(0, 0, 0);
    this.scene.add(this.root);

    this.arm = new THREE.Mesh(buildArmGeometry('right', this.slim), getSkinAtlasMaterial());
    this.root.add(this.arm);
    this.applyPose(0);
  }

  /** Match the player's Classic/Slim arms. */
  setSlim(slim: boolean): void {
    if (slim === this.slim) return;
    this.slim = slim;
    this.arm.geometry.dispose();
    this.arm.geometry = buildArmGeometry('right', slim);
  }

  /** Show the block/item for the selected hotbar id (null -> empty hand). */
  setSlotById(id: number | null): void {
    if (id === this.heldId) return;
    this.heldId = id;
    this.eatProgress = 0;
    if (this.held) {
      this.root.remove(this.held);
      disposeBlockMesh(this.held);
      this.held = null;
    }
    this.heldIsBlock = false;
    if (id != null && isBlock(id)) {
      const slot: InventorySlot | undefined = BLOCK_CATALOG.find((b) => b.id === id);
      if (slot) {
        this.held = buildBlockMesh(slot);
        this.held.scale.setScalar(0.34); // buildBlockMesh cube is 1.5 units -> ~0.5 on screen
        this.root.add(this.held);
        this.heldIsBlock = true;
      }
    } else if (id != null && ITEMS[id]) {
      this.held = buildItemMesh(ITEMS[id].texture);
      this.held.scale.setScalar(0.85);
      this.root.add(this.held);
    }
    // Slide the new item up from below, like swapping hotbar slots in LCE.
    this.height = 0;
    this.equipTarget = 1;
  }

  /** Start (or restart) a swing. Called on break and on a successful place. */
  swing(): void {
    if (!this.swinging || this.swingTime >= SWING_DURATION * 0.5) {
      this.swingTime = 0;
      this.swinging = true;
    }
  }

  /** Dip the held item down and let it spring back (LCE itemPlaced/itemUsed). */
  bump(): void {
    this.height = 0;
    this.equipTarget = 1;
  }

  /** Eat animation progress, 0 = not eating, 1 = about to finish. */
  setEatProgress(t01: number): void {
    this.eatProgress = THREE.MathUtils.clamp(t01, 0, 1);
  }

  /** Advance timers and recompose the pose. Call once per frame. */
  update(delta: number, bob: HandBobContext | null = null): void {
    this.bobCtx = bob;
    if (this.swinging) {
      this.swingTime += delta;
      if (this.swingTime >= SWING_DURATION) {
        this.swingTime = 0;
        this.swinging = false;
      }
    }
    const attackAnim = this.swinging
      ? THREE.MathUtils.clamp(this.swingTime / SWING_DURATION, 0, 1)
      : 0;

    const step = EQUIP_SPEED * delta;
    this.height += THREE.MathUtils.clamp(this.equipTarget - this.height, -step, step);

    this.applyPose(attackAnim);
  }

  private applyPose(attackAnim: number): void {
    // With a block/item equipped only the held mesh shows (LCE hides the arm);
    // the bare arm is drawn only for an empty hand.
    this.arm.visible = !this.held;

    // Whole-hand bob: mirror the camera's view bob so the hand rides with it.
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    const c = this.bobCtx;
    if (c) {
      const sinb = Math.sin(c.phase * Math.PI);
      const cosb = Math.cos(c.phase * Math.PI);
      this.root.position.x = sinb * c.bob * 0.5;
      this.root.position.y = -Math.abs(cosb * c.bob);
      this.root.rotation.z = sinb * c.bob * 3 * DEG;
      this.root.rotation.x = Math.abs(Math.cos(c.phase * Math.PI - 0.2) * c.bob) * 5 * DEG + c.tilt * DEG;
      // Counter-rotation lag (LCE: (viewAngle - easedViewAngle) * 0.1).
      this.root.rotation.x += (c.pitch - c.pitchLag) * 0.1;
      this.root.rotation.y += (c.yaw - c.yawLag) * 0.1;
    }

    const drop = -(1 - this.height) * 0.6; // LCE: translate down by (1-h)*0.6

    if (this.held && this.heldIsBlock) {
      // Held block: LCE swingPowFactor = 4 slows the arc near the player.
      const s = Math.pow(attackAnim, 4);
      const s1 = Math.sin(s * Math.PI);
      const s2 = Math.sin(Math.sqrt(s) * Math.PI);
      const s3 = Math.sin(s * s * Math.PI);

      this.held.position.set(
        HELD_BASE_POS.x - s2 * 0.4 * T,
        HELD_BASE_POS.y + Math.sin(Math.sqrt(s) * Math.PI * 2) * 0.2 * T + drop,
        HELD_BASE_POS.z - s1 * 0.2 * T,
      );
      this.held.rotation.set(
        -s2 * 80 * DEG,                    // the downward chop
        HELD_BASE_YAW - s3 * 20 * DEG,
        -s2 * 20 * DEG,
      );

      // Arm just rests behind the block.
      this.arm.position.set(ARM_BASE_POS.x, ARM_BASE_POS.y + drop, ARM_BASE_POS.z);
      this.arm.rotation.copy(ARM_BASE_ROT);
    } else if (this.held) {
      // Flat item / tool: loro ItemInHandRenderer 2D-item path. `f = attackAnim`
      // directly (no pow-4 damping) so the sprite visibly swings while mining.
      const f = attackAnim;
      const f7 = Math.sin(f * f * Math.PI);              // late, sharp
      const f8 = Math.sin(Math.sqrt(f) * Math.PI);       // early, broad

      this.held.position.set(
        ITEM_BASE_POS.x - f8 * 0.35 * T,
        ITEM_BASE_POS.y + Math.sin(Math.sqrt(f) * Math.PI * 2) * 0.28 * T + drop,
        ITEM_BASE_POS.z - f7 * 0.28 * T,
      );
      this.held.rotation.set(
        ITEM_BASE_ROT.x - f7 * 55 * DEG,   // downward chop
        ITEM_BASE_ROT.y + f8 * 20 * DEG,
        ITEM_BASE_ROT.z + f7 * 20 * DEG,
      );

      // Eat pose (loro UseAnim_eat): sprite is raised to the mouth (screen-LEFT,
      // toward centre) and bobs while chewing.
      if (this.eatProgress > 0) {
        const p = this.eatProgress;
        const iss = 1 - Math.pow(1 - p, 27);                 // 0 -> 1, fast ramp
        const chew = p > 0.1 ? Math.abs(Math.cos(p * Math.PI * 9)) * 0.05 : 0;
        this.held.position.x -= iss * 0.34;                  // toward the mouth
        this.held.position.y += -iss * 0.12 + chew;
        this.held.position.z += iss * 0.16;
        this.held.rotation.y += iss * 55 * DEG;
        this.held.rotation.x += iss * 18 * DEG;
        this.held.rotation.z -= iss * 22 * DEG;
      }

      // Arm swings under the item.
      this.arm.position.set(
        ARM_BASE_POS.x - f8 * 0.22 * T,
        ARM_BASE_POS.y + drop + Math.sin(Math.sqrt(f) * Math.PI * 2) * 0.18 * T,
        ARM_BASE_POS.z - f7 * 0.18 * T,
      );
      this.arm.rotation.set(
        ARM_BASE_ROT.x - f7 * 28 * DEG,
        ARM_BASE_ROT.y + f8 * 12 * DEG,
        ARM_BASE_ROT.z,
      );
    } else {
      // Empty hand: LCE arcs the fist sideways instead of chopping down.
      const s = attackAnim;
      const s1 = Math.sin(s * Math.PI);
      const s2 = Math.sin(Math.sqrt(s) * Math.PI);
      const s3 = Math.sin(s * s * Math.PI);

      this.arm.position.set(
        ARM_BASE_POS.x - s2 * 0.3 * T,
        ARM_BASE_POS.y + Math.sin(Math.sqrt(s) * Math.PI * 2) * 0.4 * T + drop,
        ARM_BASE_POS.z - s1 * 0.4 * T,
      );
      this.arm.rotation.set(
        ARM_BASE_ROT.x,
        ARM_BASE_ROT.y + s2 * 70 * DEG,
        ARM_BASE_ROT.z - s3 * 20 * DEG,
      );
    }
  }

  /** Tint the held block by world light (0..1). The arm shares PlayerModel's material. */
  setLightLevel(level01: number): void {
    if (!this.held) return;
    const b = Math.pow(THREE.MathUtils.clamp(level01, 0, 1), 1.25);
    this.held.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          const base = (m as THREE.MeshBasicMaterial).userData?.baseColor as THREE.Color | undefined;
          if (base) (m as THREE.MeshBasicMaterial).color.copy(base).multiplyScalar(b);
        }
      }
    });
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Draw the hand layer. Caller must clear the depth buffer first. */
  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible) return;
    renderer.render(this.scene, this.camera);
  }
}

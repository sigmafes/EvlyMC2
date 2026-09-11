import * as THREE from 'three';
import { PlayerModel } from './player-model';

const DEG = Math.PI / 180;

export type InventoryDollOptions = {
  /** CSS selector for the <canvas> the doll renders into. */
  canvasSelector: string;
  /** CSS selector for the element whose mousemove drives the doll's head/body tracking. */
  containerSelector: string;
  width?: number;
  height?: number;
};

/**
 * Small player figure in the survival inventory's preview box. Ported from LCE
 * `UIControl_MinecraftPlayer::render`: the body + head turn toward the cursor
 * (head twice as far as the body) and the whole model leans on the pitch axis.
 * Reused (with a bigger canvas) for the Player Options skin preview.
 */
export class InventoryDoll {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly model = new PlayerModel();
  private readonly tiltGroup = new THREE.Group();
  private readonly clock = new THREE.Clock();
  private rafId = 0;
  private active = false;

  // Target pose from the cursor; eased in tick() for a little smoothing.
  private tBodyYaw = 0;
  private tHeadYaw = 0;
  private tHeadPitch = 0;
  private tTilt = 0;
  private bodyYaw = 0;
  private headYaw = 0;
  private headPitch = 0;
  private tilt = 0;

  constructor(opts: InventoryDollOptions = { canvasSelector: '#backpack-doll', containerSelector: '#backpack' }) {
    const width = opts.width ?? 98;
    const height = opts.height ?? 140;
    const canvas = document.querySelector<HTMLCanvasElement>(opts.canvasSelector)!;
    const container = document.querySelector<HTMLElement>(opts.containerSelector)!;
    this.camera = new THREE.PerspectiveCamera(32, width / height, 0.1, 100);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.setClearColor(0x000000, 0);

    const group = this.model.getGroup();
    group.position.y = 0.5; // lift feet into frame; model origin is at the eyes
    this.tiltGroup.add(group);
    this.scene.add(this.tiltGroup);
    this.model.setVisible(true);

    // Camera on -Z so it faces the model's front (model forward is -Z).
    this.camera.position.set(0, 0, -5);
    this.camera.lookAt(0, 0, 0);

    container.addEventListener('mousemove', (event) => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const K = rect.height * 0.5;                 // LCE's atan(delta/40) sensitivity, scaled
      const headOffset = rect.height * 0.22;       // LCE's -40: pivot at head height

      // Signs adapted for our camera (on -Z) and -Z-facing model.
      const ax = Math.atan((event.clientX - cx) / K);
      const ay = Math.atan(((cy - headOffset) - event.clientY) / K);

      this.tBodyYaw = ax * 20 * DEG;               // LCE yBodyRot = atan * 20
      this.tHeadYaw = ax * 20 * DEG;               // LCE head total = atan * 40, minus body
      this.tHeadPitch = ay * 20 * DEG;             // cursor below -> negative -> head looks down
      this.tTilt = -ay * 20 * DEG;                 // whole-model lean
    });
  }

  /** Match the player's Classic/Slim arms. */
  setSlim(slim: boolean): void {
    this.model.setSlimArms(slim);
  }

  /** Start/stop the render loop with the backpack. */
  setActive(active: boolean): void {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.clock.getDelta();
      this.tick();
    } else {
      cancelAnimationFrame(this.rafId);
    }
  }

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const k = 1 - Math.exp(-18 * delta);
    this.bodyYaw += (this.tBodyYaw - this.bodyYaw) * k;
    this.headYaw += (this.tHeadYaw - this.headYaw) * k;
    this.headPitch += (this.tHeadPitch - this.headPitch) * k;
    this.tilt += (this.tTilt - this.tilt) * k;

    this.model.setInventoryPose(this.bodyYaw, this.headYaw, this.headPitch);
    this.tiltGroup.rotation.x = this.tilt;
    // The skin atlas material is a shared singleton across every PlayerModel
    // instance (see getAtlasMaterial() in player-model.ts) - the in-world
    // player model retints it to the world's light level every frame, which
    // was leaking into the doll too since it only set its own tint once, at
    // construction. Force it back to full brightness right before every
    // render so the doll always reads unlit regardless of what the world
    // model did to the shared material in between.
    this.model.setLightLevel(1);
    this.renderer.render(this.scene, this.camera);
  };
}

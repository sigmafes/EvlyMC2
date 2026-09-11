import * as THREE from 'three';

const STAGES = 10; // break.png is a 160x16 atlas: 10 crack stages

/**
 * The block-cracking overlay: a slightly inflated textured cube showing the
 * current destroy stage from `break.png`, over the target block. Uses a
 * multiply blend at full opacity (vanilla Minecraft's own technique - dst =
 * src * dst) instead of a flat alpha blend, so the crack lines darken the
 * block's own texture underneath instead of hazing the whole face with a
 * translucent grey square. Its colour also tracks the target block's light
 * level (multiplied in the same way) so it isn't a bright patch in the dark.
 */
export class BreakOverlay {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.Texture;

  constructor() {
    this.texture = new THREE.TextureLoader().load(
      new URL('../textures/atlas/break.png', import.meta.url).href,
    );
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.repeat.set(1 / STAGES, 1); // show one 16x16 frame on every face

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 1,
      blending: THREE.MultiplyBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), this.material);
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  /**
   * `progress` in [0,1). Any value < 0 hides the overlay. `light01` (0..1) shades
   * the crack texture to match the block's world light.
   */
  setProgress(pos: THREE.Vector3, progress: number, light01 = 1): void {
    if (progress < 0) {
      this.mesh.visible = false;
      return;
    }
    const stage = Math.min(STAGES - 1, Math.max(0, Math.floor(progress * STAGES)));
    this.texture.offset.x = stage / STAGES;
    this.mesh.position.copy(pos);
    this.material.color.setScalar(Math.pow(THREE.MathUtils.clamp(light01, 0, 1), 1.25));
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

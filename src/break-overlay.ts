import * as THREE from 'three';

const STAGES = 10; // break.png is a 160x16 atlas: 10 crack stages

/**
 * The block-cracking overlay: a slightly inflated textured cube showing the
 * current destroy stage from `break.png` over the target block.
 *
 * How it blends into the block instead of sitting on top of it as a grey
 * haze: a MULTIPLY blend at full opacity, which is what LCE/loro do too
 * (LevelRenderer::renderHit -> glBlendFunc(GL_DST_COLOR, GL_SRC_COLOR),
 * i.e. out = 2*src*dst, against a terrain.png destroy tile whose background
 * is 50% grey so 2*0.5 = 1 leaves the block untouched). Our break.png is
 * authored differently - its background is pure WHITE (255,255,255) and the
 * crack lines are opaque dark grey (61 and 155) - so the equivalent for this
 * asset is a plain multiply, out = src*dst: white background multiplies to
 * 1 and passes the block's own texture through untouched, while the crack
 * pixels scale it down to ~24%/~61% and read as real cracks in the surface.
 *
 * Deliberately NOT light-tinted: under a multiply blend the overlay inherits
 * the destination's brightness for free, so tinting it would darken the
 * whole face a second time. (An earlier attempt at this blend looked solid
 * black, but that was the caller feeding it a light level of 0 sampled from
 * inside the solid block - see BlockInteraction.blockSurfaceLight.)
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

  /** `progress` in [0,1). Any value < 0 hides the overlay. */
  setProgress(pos: THREE.Vector3, progress: number): void {
    if (progress < 0) {
      this.mesh.visible = false;
      return;
    }
    const stage = Math.min(STAGES - 1, Math.max(0, Math.floor(progress * STAGES)));
    this.texture.offset.x = stage / STAGES;
    this.mesh.position.copy(pos);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

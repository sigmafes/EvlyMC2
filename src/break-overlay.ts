import * as THREE from 'three';
import type { ShapeBox } from './block-shapes';

const STAGES = 10; // break.png is a 160x16 atlas: 10 crack stages
const ATLAS_W = 160;
const ATLAS_H = 16;
/** How hard the cracks bite into the block: 0 = invisible, 1 = the raw texture. */
const CRACK_STRENGTH = 0.55;

/**
 * The block-cracking overlay: a slightly inflated textured cube showing the
 * current destroy stage from `break.png` over the target block.
 *
 * How it blends into the block instead of sitting on top of it as a flat
 * decal: a MULTIPLY blend (out = src*dst), so every crack pixel scales the
 * block's own colour rather than replacing it, and the white background
 * multiplies by 1 and leaves the face untouched. LCE/loro do the same thing
 * with a factor of two - LevelRenderer::renderHit ->
 * glBlendFunc(GL_DST_COLOR, GL_SRC_COLOR), i.e. out = 2*src*dst - because
 * their destroy tile (terrain.png row 15) is drawn on a 50% GREY background,
 * where 2*0.5 = 1 is the neutral value. Ours is drawn on white instead, so
 * plain multiply is the same idea in this asset's own encoding.
 *
 * Note the blend is spelled out with explicit blendSrc/blendDst factors
 * rather than THREE.MultiplyBlending: the preset didn't actually take effect
 * in this setup (proved by the overlay still honouring the texture's alpha -
 * a multiply ignores alpha entirely, and can never brighten, yet forcing the
 * background to alpha 255 painted the block solid white).
 *
 * The one adjustment: our crack pixels are quite dark (61 and 155 of 255),
 * and multiplying a block down to 24% of its colour reads as flat black
 * paint rather than a crack. So the atlas is softened toward white by
 * CRACK_STRENGTH once at load (61 -> ~0.58 of the block's colour instead of
 * 0.24), which is the same gentle darkening LCE lands on, and keeps enough
 * of the block's own colour showing through for the crack to look like it's
 * IN the surface.
 *
 * Deliberately NOT light-tinted: under a multiply blend the overlay inherits
 * the destination's brightness for free, so tinting it would darken the
 * whole face a second time. (An earlier attempt at this blend looked solid
 * black, but that was the caller feeding it a light level of 0 sampled from
 * inside the solid block - see BlockInteraction.blockSurfaceLight.)
 */
export class BreakOverlay {
  private readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly geometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly material: THREE.MeshBasicMaterial;
  private readonly texture: THREE.Texture;

  constructor() {
    // Starts as a blank white canvas, which under the multiply blend is a
    // no-op, and is repainted with the softened cracks once the PNG decodes.
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W;
    canvas.height = ATLAS_H;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);

    this.texture = new THREE.CanvasTexture(canvas);
    const image = new Image();
    image.onload = () => {
      ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, ATLAS_W, ATLAS_H);
      const d = pixels.data;
      for (let i = 0; i < d.length; i += 4) {
        // Lerp each channel toward white, weighted by the pixel's own alpha:
        // the "empty" background is white at alpha ~0 and must stay exactly
        // white (the blend's neutral), the opaque crack lines get softened.
        // The alpha channel is left alone on purpose - the multiply blend
        // ignores it, but it's what keeps the background invisible if the
        // blend ever falls back to plain alpha compositing (forcing it to
        // 255 here turned the whole face into an opaque white box).
        const a = d[i + 3] / 255;
        for (let c = 0; c < 3; c++) d[i + c] = 255 - (255 - d[i + c]) * CRACK_STRENGTH * a;
      }
      ctx.putImageData(pixels, 0, 0);
      this.texture.needsUpdate = true;
    };
    image.src = new URL('../textures/atlas/break.png', import.meta.url).href;

    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.repeat.set(1 / STAGES, 1); // show one 16x16 frame on every face

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.75,
      // out = 0*src + src*dst, spelled out with explicit factors rather than
      // the MultiplyBlending preset (which didn't take effect here - the
      // giveaway was that the overlay still honoured the texture's alpha).
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.group.visible = false;
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** Grows the box pool on demand - a stair needs up to three, everything else one. */
  private boxAt(index: number): THREE.Mesh {
    let mesh = this.meshes[index];
    if (!mesh) {
      mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.meshes[index] = mesh;
    }
    return mesh;
  }

  /**
   * `progress` in [0,1). Any value < 0 hides the overlay. `shape` (local
   * 0..1 cell coordinates) cracks a stair/slab across its actual faces
   * instead of wrapping a full cube around it; omit it for normal blocks.
   */
  setProgress(pos: THREE.Vector3, progress: number, shape?: ShapeBox[] | null): void {
    if (progress < 0) {
      this.hide();
      return;
    }
    const stage = Math.min(STAGES - 1, Math.max(0, Math.floor(progress * STAGES)));
    this.texture.offset.x = stage / STAGES;

    const boxes: ShapeBox[] = shape && shape.length > 0
      ? shape
      : [{ x0: 0, y0: 0, z0: 0, x1: 1, y1: 1, z1: 1 }];
    boxes.forEach((b, i) => {
      const mesh = this.boxAt(i);
      mesh.position.set(
        pos.x - 0.5 + (b.x0 + b.x1) / 2,
        pos.y - 0.5 + (b.y0 + b.y1) / 2,
        pos.z - 0.5 + (b.z0 + b.z1) / 2,
      );
      // The same 1.002 inflation the single cube used, to clear the surface.
      mesh.scale.set((b.x1 - b.x0) + 0.002, (b.y1 - b.y0) + 0.002, (b.z1 - b.z0) + 0.002);
    });
    for (let i = 0; i < this.meshes.length; i += 1) this.meshes[i].visible = i < boxes.length;
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

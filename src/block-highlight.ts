import * as THREE from 'three';
import { BlockId } from './block';
import type { ShapeBox } from './block-shapes';

/**
 * Visual highlight for currently targeted block.
 * Renders a wireframe box outline around the block - or, for a block that
 * doesn't fill its cell (stairs, slabs), one outline per sub-box so it hugs
 * the shape you can actually stand on instead of a full cube floating around
 * a half-height slab.
 */
export class BlockHighlight {
  private readonly boxes: THREE.LineSegments[] = [];
  private readonly group = new THREE.Group();
  private readonly geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  private readonly material = new THREE.LineBasicMaterial({
    // depthTest: true so the far (camera-hidden) edges of the box are occluded
    // by the block's own solid mesh instead of drawing through it like an
    // x-ray; the slight inflation below keeps the near/visible edges from
    // z-fighting against that same surface. depthWrite stays off so the thin
    // lines never occlude anything drawn after them.
    color: 0x000000, depthTest: true, depthWrite: false,
  });

  constructor() {
    this.group.visible = false;
  }

  attachToScene(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Grows the pool on demand - a stair needs up to three boxes, everything else one. */
  private boxAt(index: number): THREE.LineSegments {
    let box = this.boxes[index];
    if (!box) {
      box = new THREE.LineSegments(this.geometry, this.material);
      box.renderOrder = 2;
      this.group.add(box);
      this.boxes[index] = box;
    }
    return box;
  }

  private show(count: number) {
    for (let i = 0; i < this.boxes.length; i += 1) this.boxes[i].visible = i < count;
    this.group.visible = count > 0;
  }

  /**
   * Update highlight position and shape based on target block. `shape` (in
   * local 0..1 cell coordinates) outlines a stair/slab exactly; omit it for
   * blocks that fill their cell.
   *
   * Fire gets a thin horizontal outline. Torch isn't a full-cube block (a
   * couple of thin crossed quads) - a 1x1x1 wireframe around it just floats
   * in the air looking wrong, so it gets no outline at all, same as looking
   * at nothing.
   */
  updateTarget(blockPosition: THREE.Vector3, blockId: BlockId, shape?: ShapeBox[] | null) {
    if (blockId === BlockId.TORCH) {
      this.hideTarget();
      return;
    }

    if (shape && shape.length > 0) {
      shape.forEach((b, i) => {
        const box = this.boxAt(i);
        box.position.set(
          blockPosition.x - 0.5 + (b.x0 + b.x1) / 2,
          blockPosition.y - 0.5 + (b.y0 + b.y1) / 2,
          blockPosition.z - 0.5 + (b.z0 + b.z1) / 2,
        );
        box.scale.set(
          (b.x1 - b.x0) + 0.01,
          (b.y1 - b.y0) + 0.01,
          (b.z1 - b.z0) + 0.01,
        );
      });
      this.show(shape.length);
      return;
    }

    const box = this.boxAt(0);
    if (blockId === BlockId.FIRE) {
      box.position.set(blockPosition.x, blockPosition.y - 0.45, blockPosition.z);
      box.scale.set(1.01, 0.1, 1.01);
    } else {
      box.position.copy(blockPosition);
      box.scale.setScalar(1.01);
    }
    this.show(1);
  }

  hideTarget() {
    this.show(0);
  }
}

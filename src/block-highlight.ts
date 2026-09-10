import * as THREE from 'three';
import { BlockId } from './block';

/**
 * Visual highlight for currently targeted block.
 * Renders a wireframe box outline around the block.
 */
export class BlockHighlight {
  private readonly highlight: THREE.LineSegments;

  constructor() {
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false }),
    );
    this.highlight.scale.setScalar(1.01);
    this.highlight.renderOrder = 2;
    this.highlight.visible = false;
  }

  attachToScene(scene: THREE.Scene) {
    scene.add(this.highlight);
  }

  /**
   * Update highlight position and shape based on target block.
   * Fire blocks get a thin horizontal outline, others get full box.
   */
  updateTarget(blockPosition: THREE.Vector3, blockId: BlockId) {
    if (blockId === BlockId.FIRE) {
      this.highlight.position.set(blockPosition.x, blockPosition.y - 0.45, blockPosition.z);
      this.highlight.scale.set(1.01, 0.1, 1.01);
    } else {
      this.highlight.position.copy(blockPosition);
      this.highlight.scale.setScalar(1.01);
    }
    this.highlight.visible = true;
  }

  hideTarget() {
    this.highlight.visible = false;
  }
}

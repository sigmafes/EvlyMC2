import * as THREE from 'three';
import { BlockId } from './block';

/**
 * Block destruction logic.
 * Determines what can be broken and performs the breaking action.
 */
export class BlockBreaker {
  breakBlock(
    position: THREE.Vector3,
    getBlock: (x: number, y: number, z: number) => BlockId,
    removeBlock: (x: number, y: number, z: number) => boolean,
  ): boolean {
    const x = Math.round(position.x);
    const y = Math.round(position.y);
    const z = Math.round(position.z);

    const blockId = getBlock(x, y, z);

    // Cannot break bedrock
    if (blockId === BlockId.BEDROCK) {
      return false;
    }

    // Break the block
    return removeBlock(x, y, z);
  }
}

import * as THREE from 'three';
import { BlockId } from './block';

/**
 * Block placement logic.
 * Determines where and when blocks can be placed.
 */
export class BlockPlacer {
  placeBlock(
    targetPosition: THREE.Vector3,
    faceNormal: THREE.Vector3,
    blockToPlace: BlockId | null,
    getBlock: (x: number, y: number, z: number) => BlockId,
    playerIntersectsBlock: (x: number, y: number, z: number) => boolean,
    addBlock: (x: number, y: number, z: number, id: BlockId) => boolean,
  ): boolean {
    if (blockToPlace === null) {
      return false;
    }

    // Try to place on the target block first (to replace water/lava)
    const targetBlock = getBlock(targetPosition.x, targetPosition.y, targetPosition.z);
    const isTargetLiquid = targetBlock === BlockId.WATER || targetBlock === BlockId.LAVA;

    // If clicking on liquid and placing a solid block, replace the liquid
    if (isTargetLiquid && blockToPlace !== BlockId.WATER && blockToPlace !== BlockId.LAVA) {
      return addBlock(targetPosition.x, targetPosition.y, targetPosition.z, blockToPlace);
    }

    // Calculate where to place (adjacent to target, in direction of face normal)
    const position = targetPosition.clone().add(faceNormal);
    const blockX = Math.round(position.x);
    const blockY = Math.round(position.y);
    const blockZ = Math.round(position.z);

    // Liquids (water and lava) can always be placed, other blocks need space
    const isLiquid = blockToPlace === BlockId.WATER || blockToPlace === BlockId.LAVA;
    const canPlace = isLiquid || !playerIntersectsBlock(blockX, blockY, blockZ);

    if (!canPlace) {
      return false;
    }

    // Place the block
    return addBlock(blockX, blockY, blockZ, blockToPlace);
  }
}

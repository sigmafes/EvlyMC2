import * as THREE from 'three';
import { BlockId } from './block';

export type RaycastHit = {
  intersection: THREE.Intersection;
  blockPosition: THREE.Vector3;
};

/**
 * Pure raycasting logic for block selection.
 * No side effects, no state, no THREE.js objects.
 */
export class Raycast {
  private readonly raycaster = new THREE.Raycaster();
  private readonly screenCenter = new THREE.Vector2(0, 0);

  constructor(private readonly distance: number = 4) {}

  /**
   * Cast ray from camera and find first hittable block.
   * Skips water and resolves fire block position ambiguity.
   */
  castRay(
    camera: THREE.Camera,
    meshObjects: THREE.Object3D[],
    getBlock: (x: number, y: number, z: number) => BlockId,
    /** NDC point to aim from (-1..1 each axis); defaults to screen centre (desktop crosshair). Touch's freeform aim (LCE Android / loro's `updateFreeformPickDirection`) passes the finger's own screen position here instead. */
    ndc: THREE.Vector2 = this.screenCenter,
  ): RaycastHit | undefined {
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.far = this.distance;
    const hits = this.raycaster.intersectObjects(meshObjects, false);

    for (const hit of hits) {
      const blockPosition = this.resolveBlockPosition(hit, getBlock);
      const id = getBlock(blockPosition.x, blockPosition.y, blockPosition.z);

      if (id === BlockId.WATER) continue;
      return { intersection: hit, blockPosition };
    }
    return undefined;
  }

  /** World-space origin/direction for an NDC point (same unprojection castRay uses internally) - for callers that need a plain ray, e.g. mob hit-testing. */
  rayFromNdc(camera: THREE.Camera, ndc: THREE.Vector2 = this.screenCenter): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    this.raycaster.setFromCamera(ndc, camera);
    return { origin: this.raycaster.ray.origin.clone(), direction: this.raycaster.ray.direction.clone() };
  }

  /**
   * Resolve block position from raycast hit point.
   * Handles special case for fire blocks (vertical planes).
   */
  private resolveBlockPosition(hit: THREE.Intersection, getBlock: (x: number, y: number, z: number) => BlockId): THREE.Vector3 {
    const normal = hit.face?.normal ?? new THREE.Vector3();
    const rounded = hit.point.clone().addScaledVector(normal, -0.01).round();

    if (getBlock(rounded.x, rounded.y, rounded.z) === BlockId.FIRE) {
      return rounded;
    }

    // Fire is rendered as vertical planes, so a hit near one of its edges
    // can round to the neighboring cell. Resolve the grid cell from the hit
    // point before falling back to the normal-based block position.
    const gridPosition = new THREE.Vector3(
      Math.floor(hit.point.x + 0.5),
      Math.floor(hit.point.y + 0.5),
      Math.floor(hit.point.z + 0.5),
    );

    for (let y = gridPosition.y; y >= gridPosition.y - 2; y -= 1) {
      if (getBlock(gridPosition.x, y, gridPosition.z) === BlockId.FIRE) {
        return new THREE.Vector3(gridPosition.x, y, gridPosition.z);
      }
    }

    return rounded;
  }
}

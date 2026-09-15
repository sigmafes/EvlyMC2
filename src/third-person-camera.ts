import * as THREE from 'three';

/**
 * The LCE F5 third-person boom: a fixed-length arm behind (or, in "front"
 * mode, in front of) the player's eye, pulled in by voxel-stepping collision
 * so it never clips through a wall. Extracted from player.ts's own
 * updateCamera()/cameraCollisionDistance() so singleplayer and the
 * multiplayer client share the exact math instead of two copies that could
 * drift apart and make the two modes feel different for no reason.
 */
export const THIRD_PERSON_DISTANCE = 4.5;

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * `front`: false = camera behind the player looking the same way they are
 * (LCE F5 mode 1); true = camera in front, looking back at them (LCE F5
 * mode 2, "selfie" boom).
 * `extraDistance`: singleplayer's death-zoom pulls the boom out further as
 * the death animation plays - 0 for every other caller (there's no
 * multiplayer equivalent of that zoom yet).
 */
export function thirdPersonCameraPosition(
  eye: THREE.Vector3,
  yaw: number,
  pitch: number,
  front: boolean,
  isSolidAt: (x: number, y: number, z: number) => boolean,
  extraDistance = 0,
): THREE.Vector3 {
  const desiredOffset = new THREE.Vector3(0, 0, THIRD_PERSON_DISTANCE)
    .applyAxisAngle(RIGHT, (front ? 1 : -1) * -pitch)
    .applyAxisAngle(UP, yaw + (front ? Math.PI : 0));

  const maxDist = desiredOffset.length() + extraDistance;
  const dir = desiredOffset.normalize();
  const dist = cameraCollisionDistance(eye, dir, maxDist, isSolidAt);
  return dir.multiplyScalar(dist).add(eye);
}

/** Walks from `eye` toward `dir` and stops just short of the first solid block, so the boom rests flush against a wall instead of clipping into it. */
function cameraCollisionDistance(
  eye: THREE.Vector3, dir: THREE.Vector3, maxDist: number,
  isSolidAt: (x: number, y: number, z: number) => boolean,
): number {
  const step = 0.1;
  for (let dist = step; dist <= maxDist; dist += step) {
    const x = eye.x + dir.x * dist, y = eye.y + dir.y * dist, z = eye.z + dir.z * dist;
    if (isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z))) return Math.max(dist - step, 0.2);
  }
  return maxDist;
}

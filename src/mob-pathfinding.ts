/**
 * Minimal A* over a local (x,z) grid, loosely modelled on LCE's own ground
 * path navigator: nodes are walkable footprint cells (solid block below, two
 * clear blocks above), steps are limited to +-1 block of ground height (no
 * falling off cliffs or hopping ledges), and diagonal moves require both
 * orthogonal neighbours to also be walkable so a path can't cut through the
 * corner of a wall. Bounded by `maxNodes` so a call from the main thread
 * during a single AI decision (never per-frame) stays cheap.
 */

export type PathPoint = { x: number; y: number; z: number }; // y = feet height (block index + 0.5)

type Node = { x: number; z: number; groundBlock: number; g: number; f: number; parent: Node | null };

const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * Ground block index near `refGroundBlock` at (x,z), or null if there's no
 * walkable column within the search window (a solid floor with 2 clear
 * blocks of headroom above). Search radius follows `maxStepDelta` (+1 above,
 * since a step up is checked the same way as a step down) so a wider step
 * budget (zombies) can actually find ledges that far away, not just accept
 * ones within the default +1/-2 animal window.
 */
function findGroundBlock(isSolid: (x: number, y: number, z: number) => boolean, x: number, z: number, refGroundBlock: number, maxStepDelta = 1): number | null {
  for (let dy = 1; dy >= -(maxStepDelta + 1); dy--) {
    const groundBlock = refGroundBlock + dy;
    if (isSolid(x, groundBlock, z) && !isSolid(x, groundBlock + 1, z) && !isSolid(x, groundBlock + 2, z)) {
      return groundBlock;
    }
  }
  return null;
}

/**
 * Path from `startFeet` (world position, feet height) to (goalX,goalZ), or
 * null if the goal (or anything closer than the start) isn't reachable
 * within `maxNodes` expansions. On a partial search, returns the path to the
 * node that got closest - useful for "just head roughly that way" AI (wander/
 * flee) that doesn't need to reach an exact tile.
 */
export function findPath(
  isSolid: (x: number, y: number, z: number) => boolean,
  startFeet: PathPoint,
  goalX: number,
  goalZ: number,
  maxNodes = 150,
  /** Largest ground-height change a single step may take (1 for animals; a zombie passes 3 to also climb/drop ledges up to 3 blocks). */
  maxStepDelta = 1,
): PathPoint[] | null {
  const startX = Math.round(startFeet.x);
  const startZ = Math.round(startFeet.z);
  const startGround = Math.round(startFeet.y - 0.5);
  const gx = Math.round(goalX);
  const gz = Math.round(goalZ);
  if (startX === gx && startZ === gz) return null;

  const key = (x: number, z: number) => `${x},${z}`;
  const open = new Map<string, Node>();
  const closed = new Set<string>();
  const start: Node = { x: startX, z: startZ, groundBlock: startGround, g: 0, f: 0, parent: null };
  open.set(key(startX, startZ), start);

  let best = start;
  let bestH = Math.hypot(startX - gx, startZ - gz);
  let expanded = 0;

  while (open.size > 0 && expanded < maxNodes) {
    let current: Node | null = null;
    for (const n of open.values()) if (!current || n.f < current.f) current = n;
    if (!current) break;
    open.delete(key(current.x, current.z));
    closed.add(key(current.x, current.z));
    expanded++;

    const h = Math.hypot(current.x - gx, current.z - gz);
    if (h < bestH) { bestH = h; best = current; }
    if (current.x === gx && current.z === gz) { best = current; break; }

    for (const [dx, dz] of DIRS) {
      const nx = current.x + dx;
      const nz = current.z + dz;
      const nk = key(nx, nz);
      if (closed.has(nk)) continue;

      const groundBlock = findGroundBlock(isSolid, nx, nz, current.groundBlock, maxStepDelta);
      if (groundBlock === null || Math.abs(groundBlock - current.groundBlock) > maxStepDelta) continue;

      if (dx !== 0 && dz !== 0) {
        // No corner-cutting: both orthogonal neighbours must be walkable too.
        if (findGroundBlock(isSolid, current.x + dx, current.z, current.groundBlock, maxStepDelta) === null) continue;
        if (findGroundBlock(isSolid, current.x, current.z + dz, current.groundBlock, maxStepDelta) === null) continue;
      }

      const stepCost = dx !== 0 && dz !== 0 ? Math.SQRT2 : 1;
      const g = current.g + stepCost;
      const existing = open.get(nk);
      if (existing && existing.g <= g) continue;
      open.set(nk, { x: nx, z: nz, groundBlock, g, f: g + Math.hypot(nx - gx, nz - gz), parent: current });
    }
  }

  const path: PathPoint[] = [];
  for (let n: Node | null = best; n; n = n.parent) path.unshift({ x: n.x, y: n.groundBlock + 0.5, z: n.z });
  return path.length > 1 ? path : null;
}

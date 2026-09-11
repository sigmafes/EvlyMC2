/**
 * Minimal A* over a local (x,z) grid, loosely modelled on LCE's own ground
 * path navigator: nodes are walkable footprint cells (solid block below, two
 * clear blocks above), diagonal moves require both orthogonal neighbours to
 * also be walkable so a path can't cut through the corner of a wall, and
 * step size is asymmetric - `maxStepUp` (default 1) matches what a mob can
 * actually clear with a single jump impulse (see mob-manager.ts's
 * JUMP_FORCE/GRAVITY - about 1.3 blocks), while `maxStepDown` (default 2, a
 * zombie passes more) is generous since dropping off a ledge just needs
 * gravity, not a jump. Bounded by `maxNodes` so a call from the main thread
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
 * walkable column within [refGroundBlock - maxStepDown, refGroundBlock +
 * maxStepUp] (a solid floor with 2 clear blocks of headroom above).
 */
function findGroundBlock(
  isSolid: (x: number, y: number, z: number) => boolean,
  x: number,
  z: number,
  refGroundBlock: number,
  maxStepUp: number,
  maxStepDown: number,
): number | null {
  for (let dy = maxStepUp; dy >= -maxStepDown; dy--) {
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
  maxStepUp = 1,
  maxStepDown = 2,
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

      const groundBlock = findGroundBlock(isSolid, nx, nz, current.groundBlock, maxStepUp, maxStepDown);
      if (groundBlock === null) continue;

      if (dx !== 0 && dz !== 0) {
        // No corner-cutting: both orthogonal neighbours must be walkable too.
        if (findGroundBlock(isSolid, current.x + dx, current.z, current.groundBlock, maxStepUp, maxStepDown) === null) continue;
        if (findGroundBlock(isSolid, current.x, current.z + dz, current.groundBlock, maxStepUp, maxStepDown) === null) continue;
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

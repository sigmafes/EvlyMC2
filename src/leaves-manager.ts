import { BlockId } from './block';

type GetBlock = (x: number, y: number, z: number) => BlockId;

/**
 * Oak leaves decay, ported from Minecraft LCE / classic `BlockLeaves`.
 *
 * A leaf survives only while a log is reachable within 4 steps travelling
 * through leaf blocks (6-neighbour flood fill). Break the trunk and the canopy
 * that is now more than 4 blocks from any remaining log rots away. Leaves that
 * still touch the tree never decay.
 *
 * "Suspect" leaves (player-placed, or near a log that was just removed) are the
 * only ones checked each tick; once a leaf is confirmed connected it stops being
 * watched until something disturbs it again.
 */
export class LeavesManager {
  /** Leaves pending a decay check. */
  private readonly watched = new Set<string>();

  /** LCE `PRESERVE_RANGE`: max flood-fill distance from a log. */
  private static readonly RANGE = 4;
  /**
   * Orphaned-leaf decay probability per second (not per call): `update()` used
   * to roll a flat 0.06 once per game-loop frame, so decay speed scaled with
   * framerate (~0.28s mean life at 60fps, near-instant) instead of real time.
   * Tuned so a felled tree's canopy fully clears in roughly 10-20s.
   */
  private static readonly DECAY_RATE_PER_SECOND = 0.35;

  addLeaf(x: number, y: number, z: number) {
    this.watched.add(key(x, y, z));
  }

  removeLeaf(x: number, y: number, z: number) {
    this.watched.delete(key(x, y, z));
  }

  /** A log was removed: every leaf that could now be orphaned needs re-checking. */
  onLogRemoved(x: number, y: number, z: number, getBlock: GetBlock) {
    const r = LeavesManager.RANGE + 1;
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          if (getBlock(x + dx, y + dy, z + dz) === BlockId.OAK_LEAVES) {
            this.watched.add(key(x + dx, y + dy, z + dz));
          }
        }
      }
    }
  }

  /** Returns the leaves that should be removed this tick. */
  update(getBlock: GetBlock, delta: number): Array<[number, number, number]> {
    const remove: Array<[number, number, number]> = [];
    const decayChance = LeavesManager.DECAY_RATE_PER_SECOND * delta;

    for (const posKey of this.watched) {
      const [x, y, z] = posKey.split(',').map(Number) as [number, number, number];

      if (getBlock(x, y, z) !== BlockId.OAK_LEAVES) {
        this.watched.delete(posKey);
        continue;
      }

      if (this.connectedToLog(x, y, z, getBlock)) {
        this.watched.delete(posKey); // stable — stop watching until disturbed
        continue;
      }

      // Orphaned: pop with a chance so the whole canopy doesn't vanish at once.
      if (Math.random() < decayChance) {
        remove.push([x, y, z]);
        this.watched.delete(posKey);
      }
    }

    return remove;
  }

  /**
   * Classic `BlockLeaves` flood fill over the [-4..4] cube around the leaf:
   * logs seed at distance 0, leaves propagate the distance outward up to 4,
   * anything else blocks. The leaf lives if its own cell got a distance >= 0.
   */
  private connectedToLog(x: number, y: number, z: number, getBlock: GetBlock): boolean {
    const R = LeavesManager.RANGE;         // 4
    const S = R * 2 + 1;                    // 9
    const SS = S * S;
    const at = (i: number, j: number, k: number) => (i + R) * SS + (j + R) * S + (k + R);

    // -1 = barrier, -2 = leaf (unvisited), 0 = log (source)
    const grid = new Int8Array(S * S * S);
    for (let i = -R; i <= R; i += 1) {
      for (let j = -R; j <= R; j += 1) {
        for (let k = -R; k <= R; k += 1) {
          const b = getBlock(x + i, y + j, z + k);
          grid[at(i, j, k)] = b === BlockId.OAK_LOG ? 0 : b === BlockId.OAK_LEAVES ? -2 : -1;
        }
      }
    }

    // Propagate the log distance outward, R passes.
    for (let dist = 1; dist <= R; dist += 1) {
      for (let i = -R; i <= R; i += 1) {
        for (let j = -R; j <= R; j += 1) {
          for (let k = -R; k <= R; k += 1) {
            if (grid[at(i, j, k)] !== dist - 1) continue;
            if (i > -R && grid[at(i - 1, j, k)] === -2) grid[at(i - 1, j, k)] = dist;
            if (i < R && grid[at(i + 1, j, k)] === -2) grid[at(i + 1, j, k)] = dist;
            if (j > -R && grid[at(i, j - 1, k)] === -2) grid[at(i, j - 1, k)] = dist;
            if (j < R && grid[at(i, j + 1, k)] === -2) grid[at(i, j + 1, k)] = dist;
            if (k > -R && grid[at(i, j, k - 1)] === -2) grid[at(i, j, k - 1)] = dist;
            if (k < R && grid[at(i, j, k + 1)] === -2) grid[at(i, j, k + 1)] = dist;
          }
        }
      }
    }

    return grid[at(0, 0, 0)] >= 0;
  }
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

import * as THREE from 'three';
import { BlockId, isOrientable } from './block';
import { facingTowardPlayer } from './block-data';
import { isSlab, isStairs } from './block-shapes';
import { ItemId } from './item';
import { getBlockSound } from './block-sounds';
import type { RaycastHit } from './raycast';
import type { World } from './world';
import type { PlayerController } from './player';
import type { SoundManager } from './sound-manager';

// --- Right-click "use" handlers: item-specific behaviour tried BEFORE the
// generic interact/toggle/place flow in interaction.ts's useHeld(). Add an
// entry here for the next "holding X and right-clicking does something
// unusual" item instead of growing another `if (this.selectedItemId === ...)`
// branch inline.

export type UseContext = {
  world: World;
  hit: RaycastHit;
  onSwing?: () => void;
  onToolUse?: (amount: number) => void;
  soundManager?: SoundManager;
};

/** Returns true if it consumed the click (caller should stop, no placement fallback). */
export type UseHandler = (ctx: UseContext) => boolean;

export const USE_HANDLERS: Partial<Record<number, UseHandler>> = {
  // Flint and Steel: ignite the air cell in front of the clicked face instead
  // of placing a block - LCE FlintAndSteelItem::useOn. Always consumes the
  // click, even if the target cell wasn't air (matches the original: an
  // unconditional `return` either way, no placement fallback).
  [ItemId.FLINT_AND_STEEL]: (ctx) => {
    const normal = ctx.hit.intersection.face!.normal;
    const firePos = ctx.hit.blockPosition.clone().add(normal).round();
    if (ctx.world.getBlock(firePos.x, firePos.y, firePos.z) === BlockId.AIR) {
      ctx.world.add(firePos.x, firePos.y, firePos.z, BlockId.FIRE);
      ctx.onSwing?.();
      ctx.onToolUse?.(1);
      const sound = getBlockSound(BlockId.FIRE, 'place') ?? getBlockSound(BlockId.FIRE, 'dig');
      if (sound && ctx.soundManager) ctx.soundManager.playSound(sound);
    }
    return true;
  },
};

// --- Placement setup rules: data a freshly-placed block needs beyond its
// bare id (facing, half, axis, ...), keyed by predicate rather than a single
// BlockId since e.g. "orientable" or "stairs-or-slab" cover more than one
// block. Evaluated in order, first match applies (the categories below are
// mutually exclusive today, so order doesn't matter in practice - kept
// explicit anyway since a future block might not be).

export type PlacementContext = {
  world: World;
  player: PlayerController;
  hit: RaycastHit;
  placedPos: THREE.Vector3;
};

type PlacementSetupRule = {
  matches: (id: BlockId) => boolean;
  apply: (ctx: PlacementContext, id: BlockId) => void;
};

/** top/bottom half a stair/slab should occupy, from where on the target face the player clicked. */
function placedHalfIsTop(hit: RaycastHit): 'top' | 'bottom' {
  const n = hit.intersection.face?.normal;
  if (n && n.y > 0.5) return 'bottom';
  if (n && n.y < -0.5) return 'top';
  const clickY = hit.intersection.point.y - (hit.blockPosition.y - 0.5);
  return clickY > 0.5 ? 'top' : 'bottom';
}

const PLACEMENT_SETUP_RULES: PlacementSetupRule[] = [
  {
    // Orientable block (furnace): its front (off) face looks at the player.
    matches: isOrientable,
    apply: (ctx) => {
      const p = ctx.placedPos;
      ctx.world.setBlockData(p.x, p.y, p.z, { facing: facingTowardPlayer(ctx.player.state.yaw) });
    },
  },
  {
    matches: (id) => isStairs(id) || isSlab(id),
    apply: (ctx, id) => {
      const p = ctx.placedPos;
      const half = placedHalfIsTop(ctx.hit);
      if (isStairs(id)) {
        // LCE StairTile::setPlacedBy - stairs ascend the way the player is
        // looking, so you walk up them going forward.
        const away = facingTowardPlayer(ctx.player.state.yaw);
        ctx.world.setBlockData(p.x, p.y, p.z, { facing: ((away + 2) & 3) as 0 | 1 | 2 | 3, half });
      } else {
        ctx.world.setBlockData(p.x, p.y, p.z, { half });
      }
    },
  },
  {
    // LCE RotatedPillarTile::setPlacedOnFaceDataValue - a log's bark rings
    // run along whichever axis the clicked face points on, so a log placed
    // against a side face lies on its side instead of always standing up.
    matches: (id) => id === BlockId.OAK_LOG,
    apply: (ctx) => {
      const p = ctx.placedPos;
      const n = ctx.hit.intersection.face!.normal;
      const axis = Math.abs(n.x) > 0.5 ? 'x' : Math.abs(n.z) > 0.5 ? 'z' : 'y';
      ctx.world.setBlockData(p.x, p.y, p.z, { axis });
    },
  },
  {
    // Side face -> wall torch leaning along the face normal; top face -> floor torch.
    matches: (id) => id === BlockId.TORCH,
    apply: (ctx) => {
      const p = ctx.placedPos;
      const n = ctx.hit.intersection.face!.normal;
      if (Math.abs(n.y) < 0.5) {
        const facing = n.x > 0.5 ? 1 : n.x < -0.5 ? 3 : n.z > 0.5 ? 0 : 2;
        ctx.world.setBlockData(p.x, p.y, p.z, { facing });
      }
    },
  },
];

/** Applies the matching placement-setup rule (if any) for a block that was just placed. */
export function applyPlacementSetup(ctx: PlacementContext, placedBlockId: BlockId): void {
  for (const rule of PLACEMENT_SETUP_RULES) {
    if (rule.matches(placedBlockId)) {
      rule.apply(ctx, placedBlockId);
      return;
    }
  }
}

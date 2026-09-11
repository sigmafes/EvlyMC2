import { BlockId } from './block';
import { toolSpec, type ToolKind } from './tools';

/**
 * Block hardness = MCPE 0.6.1 / LCE `Tile::destroySpeed` (`setDestroyTime`).
 * -1 = unbreakable. Obsidian is MCPE's 10 (LCE uses 50).
 */
const HARDNESS: Record<BlockId, number> = {
  [BlockId.AIR]: 0,
  [BlockId.BEDROCK]: -1,
  [BlockId.OAK_PLANKS]: 2,
  [BlockId.STONE]: 1.5,
  [BlockId.DIRT]: 0.5,
  [BlockId.GRASS]: 0.6,
  [BlockId.GLOWSTONE]: 0.3,
  [BlockId.OAK_LOG]: 2,
  [BlockId.WATER]: 0,
  [BlockId.OAK_LEAVES]: 0.2,
  [BlockId.SAND]: 0.5,
  [BlockId.FIRE]: 0,
  [BlockId.LAVA]: 0,
  [BlockId.COBBLESTONE]: 2,
  [BlockId.OBSIDIAN]: 10,
  [BlockId.ICE]: 0.5,
  [BlockId.COAL_ORE]: 3,
  [BlockId.IRON_ORE]: 3,
  [BlockId.GOLD_ORE]: 3,
  [BlockId.DIAMOND_ORE]: 3,
  [BlockId.EMERALD_ORE]: 3,
  [BlockId.LAPIS_ORE]: 3,
  [BlockId.REDSTONE_ORE]: 3,
  [BlockId.CRAFTING_TABLE]: 2.5,
  [BlockId.GLASS]: 0.3,
  [BlockId.FURNACE]: 3.5,
  [BlockId.TORCH]: 0,
};

type BlockTool = {
  kind: ToolKind;
  /** Minimum tier level to harvest (LCE PickaxeItem::canDestroySpecial). */
  harvest: number;
  /** True when NO drop and the slow rate applies without this tool. */
  required: boolean;
};

const BLOCK_TOOL: Partial<Record<BlockId, BlockTool>> = {
  [BlockId.STONE]: { kind: 'pickaxe', harvest: 0, required: true },
  [BlockId.COBBLESTONE]: { kind: 'pickaxe', harvest: 0, required: true },
  [BlockId.OBSIDIAN]: { kind: 'pickaxe', harvest: 3, required: true },
  [BlockId.COAL_ORE]: { kind: 'pickaxe', harvest: 0, required: true },
  [BlockId.IRON_ORE]: { kind: 'pickaxe', harvest: 1, required: true },
  [BlockId.LAPIS_ORE]: { kind: 'pickaxe', harvest: 1, required: true },
  [BlockId.GOLD_ORE]: { kind: 'pickaxe', harvest: 2, required: true },
  [BlockId.DIAMOND_ORE]: { kind: 'pickaxe', harvest: 2, required: true },
  [BlockId.EMERALD_ORE]: { kind: 'pickaxe', harvest: 2, required: true },
  [BlockId.REDSTONE_ORE]: { kind: 'pickaxe', harvest: 2, required: true },
  // Ice breaks by hand but drops nothing (Fase D); a pickaxe just speeds it.
  [BlockId.ICE]: { kind: 'pickaxe', harvest: 0, required: false },
  [BlockId.OAK_PLANKS]: { kind: 'axe', harvest: 0, required: false },
  [BlockId.OAK_LOG]: { kind: 'axe', harvest: 0, required: false },
  [BlockId.CRAFTING_TABLE]: { kind: 'axe', harvest: 0, required: false },
  [BlockId.DIRT]: { kind: 'shovel', harvest: 0, required: false },
  [BlockId.GRASS]: { kind: 'shovel', harvest: 0, required: false },
  [BlockId.SAND]: { kind: 'shovel', harvest: 0, required: false },
  [BlockId.FURNACE]: { kind: 'pickaxe', harvest: 0, required: true },
};

export type BreakInfo = {
  /** Seconds to break; `Infinity` = unbreakable. */
  time: number;
  /** False -> block breaks (slow) but drops nothing (LCE `!canDestroy`). */
  canHarvest: boolean;
};

/**
 * LCE `Tile::getDestroyProgress`:
 *   - `!canDestroy` -> `1/h/100` (5*h seconds, no drop)
 *   - else          -> `(toolSpeed/h)/30` (1.5*h/toolSpeed seconds)
 * `held` is the selected hotbar item id (block or tool).
 */
export function breakTime(id: BlockId, held: number | null | undefined): BreakInfo {
  const h = HARDNESS[id] ?? 0;
  if (h < 0) return { time: Infinity, canHarvest: false };

  const bt = BLOCK_TOOL[id];
  const tool = toolSpec(held);
  const toolMatches = !!bt && !!tool && tool.kind === bt.kind;
  const canHarvest = !bt?.required || (toolMatches && tool!.tier.level >= bt!.harvest);

  if (!canHarvest) return { time: h * 5, canHarvest: false };

  const speed = toolMatches ? tool!.tier.speed : 1;
  return { time: (h * 1.5) / speed, canHarvest: true };
}

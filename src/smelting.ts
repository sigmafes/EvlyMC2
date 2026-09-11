import { BlockId } from './block';
import { ItemId } from './item';

/** Seconds to smelt one item (LCE: 200 ticks @ 20 tps). */
export const COOK_SECONDS = 10;

type SmeltOut = { id: number; count: number };

/** input id -> output stack. */
const SMELT: Record<number, SmeltOut> = {
  [BlockId.OAK_LOG]: { id: ItemId.CHARCOAL, count: 1 },
  [BlockId.SAND]: { id: BlockId.GLASS, count: 1 },
  [BlockId.COBBLESTONE]: { id: BlockId.STONE, count: 1 },
  [ItemId.RAW_IRON]: { id: ItemId.IRON_INGOT, count: 1 },
  [ItemId.RAW_GOLD]: { id: ItemId.GOLD_INGOT, count: 1 },
  [ItemId.RAW_BEEF]: { id: ItemId.COOKED_BEEF, count: 1 },
  [ItemId.RAW_PORKCHOP]: { id: ItemId.COOKED_PORKCHOP, count: 1 },
  [ItemId.RAW_MUTTON]: { id: ItemId.COOKED_MUTTON, count: 1 },
};

/** How long one unit of a fuel burns, in seconds (LCE getBurnDuration / 20). */
const FUEL: Record<number, number> = {
  [ItemId.STICK]: 5,
  [BlockId.OAK_PLANKS]: 15,
  [BlockId.OAK_LOG]: 15,
  [BlockId.CRAFTING_TABLE]: 15,
  [ItemId.COAL]: 80,
  [ItemId.CHARCOAL]: 80,
};

export function smeltResult(id: number | null | undefined): SmeltOut | null {
  return id != null ? SMELT[id] ?? null : null;
}

export function isSmeltable(id: number | null | undefined): boolean {
  return smeltResult(id) !== null;
}

/** Burn seconds for one unit of `id`, or 0 if it isn't a fuel. */
export function fuelSeconds(id: number | null | undefined): number {
  return (id != null && FUEL[id]) || 0;
}

export function isFuel(id: number | null | undefined): boolean {
  return fuelSeconds(id) > 0;
}

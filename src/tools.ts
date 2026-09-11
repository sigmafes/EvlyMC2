import { ItemId } from './item';

export type ToolKind = 'pickaxe' | 'axe' | 'shovel';

/** LCE `Item::Tier(level, uses, speed, damage, enchantmentValue)`. */
export type Tier = { level: number; uses: number; speed: number };

// Straight from LCE Item.cpp:
//   WOOD(0, 59, 2, ...)  STONE(1, 131, 4, ...)  IRON(2, 250, 6, ...)
//   DIAMOND(3, 1561, 8, ...)  GOLD(0, 32, 12, ...)
export const TIER_WOOD: Tier = { level: 0, uses: 59, speed: 2 };
export const TIER_STONE: Tier = { level: 1, uses: 131, speed: 4 };
export const TIER_IRON: Tier = { level: 2, uses: 250, speed: 6 };
export const TIER_DIAMOND: Tier = { level: 3, uses: 1561, speed: 8 };
export const TIER_GOLD: Tier = { level: 0, uses: 32, speed: 12 };

export type ToolSpec = { kind: ToolKind; tier: Tier };

const SPECS: Record<number, ToolSpec> = {
  [ItemId.WOODEN_PICKAXE]: { kind: 'pickaxe', tier: TIER_WOOD },
  [ItemId.STONE_PICKAXE]: { kind: 'pickaxe', tier: TIER_STONE },
  [ItemId.IRON_PICKAXE]: { kind: 'pickaxe', tier: TIER_IRON },
  [ItemId.GOLDEN_PICKAXE]: { kind: 'pickaxe', tier: TIER_GOLD },
  [ItemId.DIAMOND_PICKAXE]: { kind: 'pickaxe', tier: TIER_DIAMOND },

  [ItemId.WOODEN_AXE]: { kind: 'axe', tier: TIER_WOOD },
  [ItemId.STONE_AXE]: { kind: 'axe', tier: TIER_STONE },
  [ItemId.IRON_AXE]: { kind: 'axe', tier: TIER_IRON },
  [ItemId.GOLDEN_AXE]: { kind: 'axe', tier: TIER_GOLD },
  [ItemId.DIAMOND_AXE]: { kind: 'axe', tier: TIER_DIAMOND },

  [ItemId.WOODEN_SHOVEL]: { kind: 'shovel', tier: TIER_WOOD },
  [ItemId.STONE_SHOVEL]: { kind: 'shovel', tier: TIER_STONE },
  [ItemId.IRON_SHOVEL]: { kind: 'shovel', tier: TIER_IRON },
  [ItemId.GOLDEN_SHOVEL]: { kind: 'shovel', tier: TIER_GOLD },
  [ItemId.DIAMOND_SHOVEL]: { kind: 'shovel', tier: TIER_DIAMOND },
};

export function toolSpec(itemId: number | null | undefined): ToolSpec | null {
  return itemId != null ? SPECS[itemId] ?? null : null;
}

export function isTool(itemId: number | null | undefined): boolean {
  return toolSpec(itemId) !== null;
}

/** How many uses this tool has before it breaks (LCE DiggerItem: setMaxDamage(tier->getUses())), or 0 if it isn't a tool. */
export function maxDurability(itemId: number | null | undefined): number {
  return toolSpec(itemId)?.tier.uses ?? 0;
}

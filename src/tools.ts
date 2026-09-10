import { ItemId } from './item';

export type ToolKind = 'pickaxe' | 'axe' | 'shovel';

/** LCE `Item::Tier(level, uses, speed, damage)` — we only need level + speed. */
export type Tier = { level: number; speed: number };

export const TIER_WOOD: Tier = { level: 0, speed: 2 };
export const TIER_STONE: Tier = { level: 1, speed: 4 };
export const TIER_IRON: Tier = { level: 2, speed: 6 };
export const TIER_DIAMOND: Tier = { level: 3, speed: 8 };
export const TIER_GOLD: Tier = { level: 0, speed: 12 };

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

import { ItemId } from './item';

export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'flintAndSteel';

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
// Flint and Steel uses (LCE FlintAndSteelItem: setMaxDamage(64)) - not a
// digger tool, so `speed`/`level` are irrelevant and left at 0.
const TIER_FLINT_AND_STEEL: Tier = { level: 0, uses: 64, speed: 0 };

export type ToolSpec = { kind: ToolKind; tier: Tier };

/** LCE SwordItem attack damage per material (Item.cpp damageVs* constants): wood/gold 4, stone 5, iron 6, diamond 7. */
const SWORD_DAMAGE: Record<number, number> = {
  [ItemId.WOODEN_SWORD]: 4,
  [ItemId.GOLDEN_SWORD]: 4,
  [ItemId.STONE_SWORD]: 5,
  [ItemId.IRON_SWORD]: 6,
  [ItemId.DIAMOND_SWORD]: 7,
};
/** Bare-hand attack damage (LCE Item::BASE_ATTACK_DAMAGE-equivalent). */
const BARE_HAND_DAMAGE = 1;

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

  [ItemId.WOODEN_SWORD]: { kind: 'sword', tier: TIER_WOOD },
  [ItemId.STONE_SWORD]: { kind: 'sword', tier: TIER_STONE },
  [ItemId.IRON_SWORD]: { kind: 'sword', tier: TIER_IRON },
  [ItemId.GOLDEN_SWORD]: { kind: 'sword', tier: TIER_GOLD },
  [ItemId.DIAMOND_SWORD]: { kind: 'sword', tier: TIER_DIAMOND },

  [ItemId.FLINT_AND_STEEL]: { kind: 'flintAndSteel', tier: TIER_FLINT_AND_STEEL },
};

/** Attack damage dealt to a mob by the currently held item - a sword's tier damage, or the bare-hand default. */
export function attackDamage(itemId: number | null | undefined): number {
  if (itemId != null && itemId in SWORD_DAMAGE) return SWORD_DAMAGE[itemId];
  return BARE_HAND_DAMAGE;
}

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

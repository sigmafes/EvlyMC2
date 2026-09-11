import { BlockId } from './block';
import type { InventorySlot } from './inventory';

/**
 * Item ids. Blocks keep their BlockId numeric values (1..MAX_BLOCK_ID); non-block
 * items start at 100. `InventorySlot.id` is a plain number that holds either.
 */
// Highest BlockId value; auto-tracks the enum so new blocks don't get
// mis-classified as items by isBlock().
export const MAX_BLOCK_ID = Math.max(
  ...Object.values(BlockId).filter((v): v is number => typeof v === 'number'),
);

export const ItemId = {
  STICK: 100,
  APPLE: 101,
  COAL: 102,
  RAW_IRON: 103,
  RAW_GOLD: 104,
  DIAMOND: 105,
  EMERALD: 106,
  LAPIS: 107,
  REDSTONE: 108,
  GLOWSTONE_DUST: 109,
  IRON_INGOT: 110,
  GOLD_INGOT: 111,
  CHARCOAL: 112,
  RAW_BEEF: 113,
  COOKED_BEEF: 114,
  RAW_PORKCHOP: 115,
  COOKED_PORKCHOP: 116,
  RAW_MUTTON: 117,
  COOKED_MUTTON: 118,
  LEATHER: 119,

  WOODEN_PICKAXE: 120,
  STONE_PICKAXE: 121,
  IRON_PICKAXE: 122,
  GOLDEN_PICKAXE: 123,
  DIAMOND_PICKAXE: 124,
  WOODEN_AXE: 125,
  STONE_AXE: 126,
  IRON_AXE: 127,
  GOLDEN_AXE: 128,
  DIAMOND_AXE: 129,
  WOODEN_SHOVEL: 130,
  STONE_SHOVEL: 131,
  IRON_SHOVEL: 132,
  GOLDEN_SHOVEL: 133,
  DIAMOND_SHOVEL: 134,

  WOODEN_SWORD: 135,
  STONE_SWORD: 136,
  IRON_SWORD: 137,
  GOLDEN_SWORD: 138,
  DIAMOND_SWORD: 139,
  FLINT_AND_STEEL: 140,

  ROTTEN_FLESH: 141,
  FLINT: 142,
  FEATHER: 143,
  POTATO: 144,
  CARROT: 145,
  ARROW: 146,
} as const;
export type ItemId = (typeof ItemId)[keyof typeof ItemId];

export type ItemDef = {
  name: string;
  texture: string;
  maxStack: number;
  /** Health points restored when eaten (no hunger system yet). */
  food?: number;
};

const TOOL = (name: string, texture: string): ItemDef => ({ name, texture, maxStack: 1 });
const MAT = (name: string, texture: string): ItemDef => ({ name, texture, maxStack: 64 });

export const ITEMS: Record<number, ItemDef> = {
  [ItemId.STICK]: MAT('Stick', 'items/stick.png'),
  [ItemId.APPLE]: { name: 'Apple', texture: 'items/apple.png', maxStack: 64, food: 2 },
  [ItemId.COAL]: MAT('Coal', 'items/coal.png'),
  [ItemId.CHARCOAL]: MAT('Charcoal', 'items/charcoal.png'),
  [ItemId.RAW_IRON]: MAT('Raw Iron', 'items/raw_iron.png'),
  [ItemId.RAW_GOLD]: MAT('Raw Gold', 'items/raw_gold.png'),
  [ItemId.DIAMOND]: MAT('Diamond', 'items/diamond.png'),
  [ItemId.EMERALD]: MAT('Emerald', 'items/emerald.png'),
  [ItemId.LAPIS]: MAT('Lapis Lazuli', 'items/lapis.png'),
  [ItemId.REDSTONE]: MAT('Redstone', 'items/redstone.png'),
  [ItemId.GLOWSTONE_DUST]: MAT('Glowstone Dust', 'items/glowstone_dust.png'),
  [ItemId.IRON_INGOT]: MAT('Iron Ingot', 'items/iron_ingot.png'),
  [ItemId.GOLD_INGOT]: MAT('Gold Ingot', 'items/gold_ingot.png'),
  [ItemId.RAW_BEEF]: { name: 'Raw Beef', texture: 'items/raw_beef.png', maxStack: 64, food: 1 },
  [ItemId.COOKED_BEEF]: { name: 'Steak', texture: 'items/cooked_beef.png', maxStack: 64, food: 5 },
  [ItemId.RAW_PORKCHOP]: { name: 'Raw Porkchop', texture: 'items/raw_pork.png', maxStack: 64, food: 1 },
  [ItemId.COOKED_PORKCHOP]: { name: 'Cooked Porkchop', texture: 'items/cooked_pork.png', maxStack: 64, food: 3 },
  [ItemId.RAW_MUTTON]: { name: 'Raw Mutton', texture: 'items/raw_sheep.png', maxStack: 64, food: 1 },
  [ItemId.COOKED_MUTTON]: { name: 'Cooked Mutton', texture: 'items/cooked_sheep.png', maxStack: 64, food: 4 },
  [ItemId.LEATHER]: MAT('Leather', 'items/leather.png'),

  [ItemId.WOODEN_PICKAXE]: TOOL('Wooden Pickaxe', 'items/wooden_pickaxe.png'),
  [ItemId.STONE_PICKAXE]: TOOL('Stone Pickaxe', 'items/stone_pickaxe.png'),
  [ItemId.IRON_PICKAXE]: TOOL('Iron Pickaxe', 'items/iron_pickaxe.png'),
  [ItemId.GOLDEN_PICKAXE]: TOOL('Golden Pickaxe', 'items/golden_pickaxe.png'),
  [ItemId.DIAMOND_PICKAXE]: TOOL('Diamond Pickaxe', 'items/diamond_pickaxe.png'),
  [ItemId.WOODEN_AXE]: TOOL('Wooden Axe', 'items/wooden_axe.png'),
  [ItemId.STONE_AXE]: TOOL('Stone Axe', 'items/stone_axe.png'),
  [ItemId.IRON_AXE]: TOOL('Iron Axe', 'items/iron_axe.png'),
  [ItemId.GOLDEN_AXE]: TOOL('Golden Axe', 'items/golden_axe.png'),
  [ItemId.DIAMOND_AXE]: TOOL('Diamond Axe', 'items/diamond_axe.png'),
  [ItemId.WOODEN_SHOVEL]: TOOL('Wooden Shovel', 'items/wooden_shovel.png'),
  [ItemId.STONE_SHOVEL]: TOOL('Stone Shovel', 'items/stone_shovel.png'),
  [ItemId.IRON_SHOVEL]: TOOL('Iron Shovel', 'items/iron_shovel.png'),
  [ItemId.GOLDEN_SHOVEL]: TOOL('Golden Shovel', 'items/golden_shovel.png'),
  [ItemId.DIAMOND_SHOVEL]: TOOL('Diamond Shovel', 'items/diamond_shovel.png'),

  [ItemId.WOODEN_SWORD]: TOOL('Wooden Sword', 'items/wooden_sword.png'),
  [ItemId.STONE_SWORD]: TOOL('Stone Sword', 'items/stone_sword.png'),
  [ItemId.IRON_SWORD]: TOOL('Iron Sword', 'items/iron_sword.png'),
  [ItemId.GOLDEN_SWORD]: TOOL('Golden Sword', 'items/gold_sword.png'),
  [ItemId.DIAMOND_SWORD]: TOOL('Diamond Sword', 'items/diamond_sword.png'),
  [ItemId.FLINT_AND_STEEL]: TOOL('Flint and Steel', 'items/flint_and_steel.png'),

  [ItemId.ROTTEN_FLESH]: { name: 'Rotten Flesh', texture: 'items/rotten_flesh.png', maxStack: 64, food: 1 },
  [ItemId.FLINT]: MAT('Flint', 'items/flint.png'),
  [ItemId.FEATHER]: MAT('Feather', 'items/feather.png'),
  [ItemId.POTATO]: { name: 'Potato', texture: 'items/potato.png', maxStack: 64, food: 1 },
  [ItemId.CARROT]: { name: 'Carrot', texture: 'items/carrot.png', maxStack: 64, food: 2 },
  [ItemId.ARROW]: MAT('Arrow', 'items/arrow.png'),
};

/** A slot id is a "block" (renders as a 3D cube) when it's in the BlockId range. */
export function isBlock(id: number | null | undefined): boolean {
  return id != null && id >= 1 && id <= MAX_BLOCK_ID;
}

export function maxStackOf(id: number | null | undefined): number {
  if (id == null) return 64;
  return ITEMS[id]?.maxStack ?? 64;
}

/** Health restored by eating this item, or 0 if it isn't food. */
export function foodValue(id: number | null | undefined): number {
  return (id != null && ITEMS[id]?.food) || 0;
}

/** Build an InventorySlot for a non-block item. */
export function itemSlot(id: number, count = 1): InventorySlot {
  const def = ITEMS[id];
  return { id, name: def?.name ?? 'Item', sideTexture: def?.texture, count };
}

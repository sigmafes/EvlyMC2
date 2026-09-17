import { ItemId } from './item';

/** 0=helmet, 1=chestplate, 2=leggings, 3=boots - LCE's own ArmorItem `slot` order, matching Inventory.cpp's armor[4] layout. */
export type ArmorSlotIndex = 0 | 1 | 2 | 3;
export type ArmorMaterial = 'iron' | 'gold' | 'diamond';

const SLOT_IDS: Record<ArmorMaterial, [number, number, number, number]> = {
  iron: [ItemId.IRON_HELMET, ItemId.IRON_CHESTPLATE, ItemId.IRON_LEGGINGS, ItemId.IRON_BOOTS],
  gold: [ItemId.GOLDEN_HELMET, ItemId.GOLDEN_CHESTPLATE, ItemId.GOLDEN_LEGGINGS, ItemId.GOLDEN_BOOTS],
  diamond: [ItemId.DIAMOND_HELMET, ItemId.DIAMOND_CHESTPLATE, ItemId.DIAMOND_LEGGINGS, ItemId.DIAMOND_BOOTS],
};

/** LCE ArmorItem::ArmorMaterial::slotProtections - defense points per [helmet,chest,legs,boots]. */
const DEFENSE: Record<ArmorMaterial, [number, number, number, number]> = {
  iron: [2, 6, 5, 2],
  gold: [2, 5, 3, 1],
  diamond: [3, 8, 6, 3],
};

/** LCE ArmorItem::healthPerSlot[] * ArmorMaterial::durabilityMultiplier. */
const HEALTH_PER_SLOT: [number, number, number, number] = [11, 16, 15, 13];
const DURABILITY_MULTIPLIER: Record<ArmorMaterial, number> = { iron: 15, gold: 7, diamond: 33 };

type ArmorSpec = { material: ArmorMaterial; slot: ArmorSlotIndex; defense: number; maxDamage: number };

const SPECS: Partial<Record<number, ArmorSpec>> = {};
for (const material of ['iron', 'gold', 'diamond'] as const) {
  for (let slot = 0; slot < 4; slot++) {
    const id = SLOT_IDS[material][slot];
    SPECS[id] = {
      material,
      slot: slot as ArmorSlotIndex,
      defense: DEFENSE[material][slot],
      maxDamage: HEALTH_PER_SLOT[slot] * DURABILITY_MULTIPLIER[material],
    };
  }
}

export function armorSpec(itemId: number | null | undefined): ArmorSpec | null {
  return itemId != null ? SPECS[itemId] ?? null : null;
}

export function isArmor(itemId: number | null | undefined): boolean {
  return armorSpec(itemId) !== null;
}

/** Which of the 4 slots (helmet/chest/legs/boots) an armor item belongs in, or null if it isn't armor. */
export function armorSlotFor(itemId: number | null | undefined): ArmorSlotIndex | null {
  return armorSpec(itemId)?.slot ?? null;
}

export function armorDurability(itemId: number | null | undefined): number {
  return armorSpec(itemId)?.maxDamage ?? 0;
}

/** Sum of defense across whatever's actually equipped (nulls/non-armor ignored) - LCE Inventory::getArmorValue(). Max is 20 (a full diamond set). */
export function totalArmorValue(equipped: (number | null | undefined)[]): number {
  let total = 0;
  for (const id of equipped) total += armorSpec(id)?.defense ?? 0;
  return total;
}

/**
 * LCE Mob::getDamageAfterArmorAbsorb: `damage * (25 - armorValue) / 25`, with
 * the fractional remainder (`dmgSpill`) carried into the NEXT hit instead of
 * being dropped - otherwise small, frequent hits (e.g. an arrow every tick)
 * would round their reduction down to 0 forever. Returns the reduced damage
 * (rounded down) and the new spill to pass into the next call.
 */
export function reduceDamageByArmor(damage: number, armorValue: number, spill: number): { damage: number; spill: number } {
  const v = damage * (25 - armorValue) + spill;
  return { damage: Math.floor(v / 25), spill: v % 25 };
}

/** LCE Inventory::hurtArmor: durability lost per equipped piece, from the RAW damage (before armor's own reduction) - at least 1. */
export function armorHurtAmount(rawDamage: number): number {
  return Math.max(1, Math.floor(rawDamage / 4));
}

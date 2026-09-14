// Minimal server-side inventory helpers - NOT a copy of src/inventory.ts
// (840 lines, almost all of it DOM: drag/drop click handlers, the backpack
// panel, tooltips, crafting grid UI). Importing that whole module here would
// risk the exact same "eager DOM code crashes the Worker" class of bug that
// mob-manager.ts's real render chain caused before world-server/src/game/
// existed (see that folder's README.md) - for one array of plain slot data,
// it's simpler and safer to just write the couple of pure helpers actually
// needed than to chase down every transitive import for safety.
//
// InventorySlot itself IS imported (type-only, so it's fully erased at
// build time - zero runtime risk) from the real src/inventory.ts, so the
// wire format matches exactly what the client's own Inventory class expects.

import type { InventorySlot } from '../../../src/inventory';
import { isBlock, maxStackOf, ITEMS } from '../../../src/item';

export const HOTBAR_SIZE = 9;
export const BACKPACK_SIZE = 27;
export const TOTAL_SLOTS = HOTBAR_SIZE + BACKPACK_SIZE;

export function createEmptySlot(): InventorySlot {
  return { id: null, name: 'Empty', count: 0 };
}

export function createEmptyInventory(): InventorySlot[] {
  return Array.from({ length: TOTAL_SLOTS }, createEmptySlot);
}

/**
 * Display name/texture for a slot. Blocks: the client's own BLOCK_CATALOG
 * renders the icon by id alone (block-preview.ts's renderBlockPreview), so
 * the name here is cosmetic-only filler. Items: renderItemIcon() actually
 * needs the real texture path, so this looks it up from the same ITEMS
 * table item.ts already exports (pure data, safe to import - see this
 * file's header comment) rather than inventing one.
 */
function describeSlot(id: number): { name: string; sideTexture?: string } {
  if (isBlock(id)) return { name: `Block ${id}` };
  const def = ITEMS[id];
  return { name: def?.name ?? 'Item', sideTexture: def?.texture };
}

/**
 * Adds `count` of item/block `id` into the first slot(s) with room (an
 * existing same-id stack under its max, then the first empty slot),
 * splitting across multiple slots if one stack can't hold it all. Returns
 * how many actually fit - the rest is lost (no world item entity to drop
 * the overflow into yet, see protocol.ts's dropItem doc comment for the
 * matching limitation on the other end).
 */
export function addToInventory(slots: InventorySlot[], id: number, count: number): number {
  const max = maxStackOf(id);
  let remaining = count;

  for (const slot of slots) {
    if (remaining <= 0) break;
    if (slot.id !== id) continue;
    const room = max - (slot.count ?? 0);
    if (room <= 0) continue;
    const add = Math.min(room, remaining);
    slot.count = (slot.count ?? 0) + add;
    remaining -= add;
  }

  for (const slot of slots) {
    if (remaining <= 0) break;
    if (slot.id !== null) continue;
    const add = Math.min(max, remaining);
    const desc = describeSlot(id);
    slot.id = id;
    slot.name = desc.name;
    slot.sideTexture = desc.sideTexture;
    slot.count = add;
    remaining -= add;
  }

  return count - remaining;
}

/** Total count of item/block `id` across every slot - used to check a recipe's ingredients are actually affordable before crafting. */
export function countInInventory(slots: InventorySlot[], id: number): number {
  let total = 0;
  for (const slot of slots) if (slot.id === id) total += slot.count ?? 0;
  return total;
}

/** Removes up to `count` of item/block `id` from wherever it's stacked across the inventory (not a single known slot - crafting can pull the same ingredient from several stacks). Returns how many were actually removed. */
export function removeItemsAnywhere(slots: InventorySlot[], id: number, count: number): number {
  let remaining = count;
  for (const slot of slots) {
    if (remaining <= 0) break;
    if (slot.id !== id) continue;
    remaining -= removeFromSlot(slot, remaining);
  }
  return count - remaining;
}

/** Removes up to `count` from `slot` in place, clearing it back to empty if that empties the stack. Returns how many were actually removed. */
export function removeFromSlot(slot: InventorySlot, count: number): number {
  if (slot.id === null) return 0;
  const removed = Math.min(slot.count ?? 0, count);
  const left = (slot.count ?? 0) - removed;
  if (left <= 0) {
    slot.id = null;
    slot.name = 'Empty';
    slot.sideTexture = undefined;
    slot.count = 0;
  } else {
    slot.count = left;
  }
  return removed;
}

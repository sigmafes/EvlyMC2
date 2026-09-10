import { BLOCK_CATALOG } from './creative-palette';
import { ITEMS, isBlock } from './item';
import { createEmptySlot, type InventorySlot } from './inventory';

/** Build a rendered InventorySlot for any block or item id + count. */
export function makeStack(id: number | null, count = 1): InventorySlot {
  if (id == null) return createEmptySlot();
  if (isBlock(id)) {
    const cat = BLOCK_CATALOG.find((b) => b.id === id);
    return {
      id,
      name: cat?.name ?? 'Block',
      sideTexture: cat?.sideTexture,
      topTexture: cat?.topTexture,
      previewColor: cat?.previewColor,
      count,
    };
  }
  const def = ITEMS[id];
  return { id, name: def?.name ?? 'Item', sideTexture: def?.texture, count };
}

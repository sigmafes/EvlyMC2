import { BlockId } from './block';
import { ItemId } from './item';

export type DropStack = { id: number; count: number };

const ri = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * What breaking a block yields (LCE `Tile::spawnResources` / `getResource` /
 * `getResourceCount`). `canHarvest` false (wrong / missing tool) -> nothing.
 */
export function getDrops(id: BlockId, canHarvest: boolean, isDouble = false): DropStack[] {
  if (!canHarvest) return [];

  switch (id) {
    // Plain self-drops.
    case BlockId.DIRT:
    case BlockId.SAND:
    case BlockId.OAK_PLANKS:
    case BlockId.OAK_LOG:
    case BlockId.COBBLESTONE:
    case BlockId.OBSIDIAN:
    case BlockId.CRAFTING_TABLE:
    case BlockId.FURNACE:
    case BlockId.TORCH:
    case BlockId.WOOL:
    case BlockId.OAK_STAIRS:
    case BlockId.COBBLESTONE_STAIRS:
      return [{ id, count: 1 }];

    // Slabs: a doubled one gives both halves back (LCE fullSize HalfSlabTile).
    case BlockId.OAK_SLAB:
    case BlockId.COBBLESTONE_SLAB:
      return [{ id, count: isDouble ? 2 : 1 }];

    // Special block drops.
    case BlockId.GRAVEL:
      // LCE GravelTile::getResource - 10% chance of flint instead of gravel itself.
      return Math.random() < 0.1 ? [{ id: ItemId.FLINT, count: 1 }] : [{ id, count: 1 }];
    case BlockId.STONE:
      return [{ id: BlockId.COBBLESTONE, count: 1 }];
    case BlockId.GRASS:
      return [{ id: BlockId.DIRT, count: 1 }];
    case BlockId.GLOWSTONE:
      return [{ id: ItemId.GLOWSTONE_DUST, count: ri(2, 4) }];

    // Ores.
    case BlockId.COAL_ORE:
      return [{ id: ItemId.COAL, count: 1 }];
    case BlockId.IRON_ORE:
      return [{ id: ItemId.RAW_IRON, count: 1 }];
    case BlockId.GOLD_ORE:
      return [{ id: ItemId.RAW_GOLD, count: 1 }];
    case BlockId.DIAMOND_ORE:
      return [{ id: ItemId.DIAMOND, count: 1 }];
    case BlockId.EMERALD_ORE:
      return [{ id: ItemId.EMERALD, count: 1 }];
    case BlockId.LAPIS_ORE:
      return [{ id: ItemId.LAPIS, count: ri(4, 8) }];
    case BlockId.REDSTONE_ORE:
      return [{ id: ItemId.REDSTONE, count: ri(4, 5) }];

    // Leaves: no sapling item yet — just the occasional stick / apple.
    case BlockId.OAK_LEAVES: {
      const out: DropStack[] = [];
      if (Math.random() < 0.05) out.push({ id: ItemId.STICK, count: ri(1, 2) });
      if (Math.random() < 0.02) out.push({ id: ItemId.APPLE, count: 1 });
      return out;
    }

    // Glass / ice / bedrock / fire / water / lava -> nothing (no silk touch).
    default:
      return [];
  }
}

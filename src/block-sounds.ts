import { BlockId } from './block';

export type BlockSoundType = 'hit' | 'dig' | 'mine' | 'place';

type BlockSoundSet = { hit?: string; dig?: string; mine?: string; place?: string };

export const blockSounds: Record<BlockId, BlockSoundSet> = {
  [BlockId.AIR]: {},
  [BlockId.BEDROCK]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.OAK_PLANKS]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.STONE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.DIRT]: { hit: 'grass_hit', dig: 'grass_dig', mine: 'grass_mining' },
  [BlockId.GRASS]: { hit: 'grass_hit', dig: 'grass_dig', mine: 'grass_mining' },
  [BlockId.GLOWSTONE]: { hit: 'stone_hit', dig: 'glass_dig', mine: 'stone_mining', place: 'stone_dig' },
  [BlockId.OAK_LOG]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.WATER]: { dig: 'water_place' },
  [BlockId.OAK_LEAVES]: { hit: 'grass_hit', dig: 'leaves_break', mine: 'grass_mining' },
  [BlockId.SAND]: { hit: 'sand_hit', dig: 'sand_dig', mine: 'sand_mining' },
  [BlockId.GRAVEL]: { hit: 'gravel_hit', dig: 'gravel_dig', mine: 'gravel_mining' },
  [BlockId.FIRE]: {},
  [BlockId.LAVA]: { dig: 'lava_place' },
  [BlockId.COBBLESTONE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.OBSIDIAN]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.ICE]: { hit: 'stone_hit', dig: 'glass_dig', mine: 'stone_mining', place: 'stone_dig' },
  [BlockId.COAL_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.IRON_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.GOLD_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.DIAMOND_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.EMERALD_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.LAPIS_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.REDSTONE_ORE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.CRAFTING_TABLE]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.GLASS]: { hit: 'stone_hit', dig: 'glass_dig', mine: 'stone_mining', place: 'stone_dig' },
  [BlockId.FURNACE]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.TORCH]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.WOOL]: { hit: 'wool_dig', dig: 'wool_dig', mine: 'wool_dig', place: 'wool_dig' },
  [BlockId.OAK_STAIRS]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.OAK_SLAB]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.COBBLESTONE_STAIRS]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.COBBLESTONE_SLAB]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
  [BlockId.OAK_FENCE]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.OAK_FENCE_GATE]: { hit: 'wood_hit', dig: 'wood_dig', mine: 'wood_mining' },
  [BlockId.COBBLESTONE_WALL]: { hit: 'stone_hit', dig: 'stone_dig', mine: 'stone_mining' },
};

export function getBlockSound(blockId: BlockId, soundType: BlockSoundType): string | undefined {
  return blockSounds[blockId]?.[soundType];
}

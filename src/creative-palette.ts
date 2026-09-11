import { BlockId } from './block';
import type { InventorySlot } from './inventory';

/**
 * Every placeable block, used to build the 3D preview meshes for the hotbar,
 * the first-person hand and dropped-item entities. (There is no in-game creative
 * browser any more - items and blocks are obtained with the /give command.)
 */
export const BLOCK_CATALOG: InventorySlot[] = [
  { id: BlockId.BEDROCK, name: 'Bedrock', sideTexture: 'blocks/bedrock.png', topTexture: 'blocks/bedrock.png' },
  { id: BlockId.OAK_PLANKS, name: 'Oak Planks', sideTexture: 'blocks/oak_planks.png', topTexture: 'blocks/oak_planks.png' },
  { id: BlockId.STONE, name: 'Stone', sideTexture: 'blocks/stone.png', topTexture: 'blocks/stone.png' },
  { id: BlockId.DIRT, name: 'Dirt', sideTexture: 'blocks/dirt.png', topTexture: 'blocks/dirt.png' },
  { id: BlockId.GRASS, name: 'Grass', sideTexture: 'blocks/grass.png', topTexture: 'blocks/grass_top.png' },
  { id: BlockId.GLOWSTONE, name: 'Glowstone', sideTexture: 'blocks/glowstone.png', topTexture: 'blocks/glowstone.png' },
  { id: BlockId.OAK_LOG, name: 'Oak Log', sideTexture: 'blocks/oak_log.png', topTexture: 'blocks/oak_log_top.png' },
  { id: BlockId.CRAFTING_TABLE, name: 'Crafting Table', sideTexture: 'blocks/crafting_table_side1.png', topTexture: 'blocks/crafting_table_top.png' },
  { id: BlockId.OAK_LEAVES, name: 'Oak Leaves', sideTexture: 'blocks/oak_leaves.png', topTexture: 'blocks/oak_leaves.png', previewColor: 0x4a8a2e },
  { id: BlockId.SAND, name: 'Sand', sideTexture: 'blocks/sand.png', topTexture: 'blocks/sand.png' },
  { id: BlockId.COBBLESTONE, name: 'Cobblestone', sideTexture: 'blocks/cobblestone.png', topTexture: 'blocks/cobblestone.png' },
  { id: BlockId.OBSIDIAN, name: 'Obsidian', sideTexture: 'blocks/obsidian.png', topTexture: 'blocks/obsidian.png' },
  { id: BlockId.COAL_ORE, name: 'Coal Ore', sideTexture: 'blocks/coal_ore.png', topTexture: 'blocks/coal_ore.png' },
  { id: BlockId.IRON_ORE, name: 'Iron Ore', sideTexture: 'blocks/iron_ore.png', topTexture: 'blocks/iron_ore.png' },
  { id: BlockId.GOLD_ORE, name: 'Gold Ore', sideTexture: 'blocks/gold_ore.png', topTexture: 'blocks/gold_ore.png' },
  { id: BlockId.DIAMOND_ORE, name: 'Diamond Ore', sideTexture: 'blocks/diamond_ore.png', topTexture: 'blocks/diamond_ore.png' },
  { id: BlockId.EMERALD_ORE, name: 'Emerald Ore', sideTexture: 'blocks/emerald_ore.png', topTexture: 'blocks/emerald_ore.png' },
  { id: BlockId.LAPIS_ORE, name: 'Lapis Ore', sideTexture: 'blocks/lapis_ore.png', topTexture: 'blocks/lapis_ore.png' },
  { id: BlockId.REDSTONE_ORE, name: 'Redstone Ore', sideTexture: 'blocks/redstone_ore.png', topTexture: 'blocks/redstone_ore.png' },
  { id: BlockId.ICE, name: 'Ice', sideTexture: 'blocks/ice.png', topTexture: 'blocks/ice.png' },
  { id: BlockId.GLASS, name: 'Glass', sideTexture: 'blocks/glass.png', topTexture: 'blocks/glass.png' },
  { id: BlockId.FURNACE, name: 'Furnace', sideTexture: 'blocks/furnace_off.png', topTexture: 'blocks/furnace_top.png' },
  { id: BlockId.TORCH, name: 'Torch', sideTexture: 'blocks/torch.png', topTexture: 'blocks/torch.png', previewColor: 0xffcc55 },
  { id: BlockId.WATER, name: 'Water', sideTexture: 'atlas/water_flow.png', topTexture: 'atlas/water_still.png', previewColor: 0x3f76e4 },
  { id: BlockId.LAVA, name: 'Lava', sideTexture: 'atlas/lava_flow.png', topTexture: 'atlas/lava_still.png', previewColor: 0xff6a00 },
  { id: BlockId.FIRE, name: 'Fire', sideTexture: 'atlas/fire_atlas.png', topTexture: 'atlas/fire_atlas.png' },
];

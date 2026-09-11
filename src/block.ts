import * as THREE from 'three';
import { buildAtlas, type Atlas } from './texture-atlas';

export enum BlockId {
  AIR = 0,
  BEDROCK = 1,
  OAK_PLANKS = 2,
  STONE = 3,
  DIRT = 4,
  GRASS = 5,
  GLOWSTONE = 6,
  OAK_LOG = 7,
  WATER = 8,
  OAK_LEAVES = 9,
  SAND = 10,
  FIRE = 11,
  LAVA = 12,
  COBBLESTONE = 13,
  OBSIDIAN = 14,
  ICE = 15,
  COAL_ORE = 16,
  IRON_ORE = 17,
  GOLD_ORE = 18,
  DIAMOND_ORE = 19,
  EMERALD_ORE = 20,
  LAPIS_ORE = 21,
  REDSTONE_ORE = 22,
  CRAFTING_TABLE = 23,
  GLASS = 24,
  FURNACE = 25,
  TORCH = 26,
  WOOL = 27,
  OAK_STAIRS = 28,
  COBBLESTONE_STAIRS = 29,
  OAK_SLAB = 30,
  COBBLESTONE_SLAB = 31,
  GRAVEL = 32,
  OAK_FENCE = 33,
  OAK_FENCE_GATE = 34,
  COBBLESTONE_WALL = 35,
}

export type VoxelBlock = {
  id: BlockId;
  mesh: THREE.Mesh;
  collider: THREE.Box3;
};

/**
 * Fire behaviour for a block, mirroring Minecraft LCE's two odds (FireTile):
 * - `catchOdds`: how readily fire ignites in air next to this block
 *   (LCE FLAME_INSTANT 60 / EASY 30 / MEDIUM 15 / HARD 5).
 * - `burnOdds`: how readily this block itself is consumed by adjacent fire
 *   (LCE BURN_INSTANT 100 / EASY 60 / MEDIUM 20 / HARD 5).
 */
export type FlammableProps = { catchOdds: number; burnOdds: number };

export type BlockLightProperties = {
  opacity: number;
  emission: number;
  liquid: boolean;
  cull: boolean;
  /** null = not flammable. */
  flammable: FlammableProps | null;
};

export const blockLightProperties: Record<BlockId, BlockLightProperties> = {
  [BlockId.AIR]: { opacity: 0, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.BEDROCK]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.OAK_PLANKS]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: { catchOdds: 5, burnOdds: 20 } },
  [BlockId.STONE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.DIRT]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.GRASS]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.GLOWSTONE]: { opacity: 15, emission: 15, liquid: false, cull: true, flammable: null },
  [BlockId.OAK_LOG]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: { catchOdds: 5, burnOdds: 5 } },
  [BlockId.WATER]: { opacity: 0, emission: 0, liquid: true, cull: true, flammable: null },
  [BlockId.OAK_LEAVES]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: { catchOdds: 30, burnOdds: 60 } },
  [BlockId.SAND]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.FIRE]: { opacity: 0, emission: 15, liquid: false, cull: false, flammable: null },
  [BlockId.LAVA]: { opacity: 0, emission: 15, liquid: true, cull: true, flammable: null },
  [BlockId.COBBLESTONE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.OBSIDIAN]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.ICE]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: null },
  [BlockId.COAL_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.IRON_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.GOLD_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.DIAMOND_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.EMERALD_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.LAPIS_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.REDSTONE_ORE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.CRAFTING_TABLE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: { catchOdds: 5, burnOdds: 20 } },
  // Glass is fully transparent to light, not just to the eye: opacity 0 is
  // what LightEngine.hasSkyAccess() requires to keep a column daylit (any
  // value above 0 anywhere overhead cuts the whole column off from the sky),
  // and it's also what makes block light cross it at the same 1-per-cell
  // falloff as air instead of paying an extra level.
  [BlockId.GLASS]: { opacity: 0, emission: 0, liquid: false, cull: false, flammable: null },
  [BlockId.FURNACE]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  [BlockId.TORCH]: { opacity: 0, emission: 15, liquid: false, cull: false, flammable: null },
  // Same odds as real Minecraft wool (as flammable as leaves): catches easily
  // and burns away fast once it does.
  [BlockId.WOOL]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: { catchOdds: 30, burnOdds: 60 } },
  // Stairs/slabs don't fill their cell, so `cull: false` keeps their
  // neighbours drawing the faces a full cube would have hidden. Their opacity
  // is 1, not 15, for the same reason: light is stored per cell, and 15 makes
  // LightEngine.processIncrease() pin the whole cell to 0, which blacked out
  // the half of it that is actually open air. 1 keeps the cell lit (one level
  // down from its brightest neighbour, like leaves and ice) while still
  // casting shade on what's underneath.
  [BlockId.OAK_STAIRS]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: { catchOdds: 5, burnOdds: 20 } },
  [BlockId.COBBLESTONE_STAIRS]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: null },
  [BlockId.OAK_SLAB]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: { catchOdds: 5, burnOdds: 20 } },
  [BlockId.COBBLESTONE_SLAB]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: null },
  [BlockId.GRAVEL]: { opacity: 15, emission: 0, liquid: false, cull: true, flammable: null },
  // Fence/gate/wall don't fill their cell - opacity 1 (not 15) for the same
  // reason stairs/slabs use 1: light shouldn't get pinned to 0 by something
  // that's mostly open air (see the OAK_STAIRS comment above), and cull:
  // false keeps a full block behind them drawing its own face instead of
  // being hidden by a partial neighbour.
  [BlockId.OAK_FENCE]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: { catchOdds: 5, burnOdds: 20 } },
  [BlockId.OAK_FENCE_GATE]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: { catchOdds: 5, burnOdds: 20 } },
  [BlockId.COBBLESTONE_WALL]: { opacity: 1, emission: 0, liquid: false, cull: false, flammable: null },
};

/** True if a block can catch fire / be consumed by it (wood, log, leaves). */
export function isFlammable(id: BlockId): boolean {
  return blockLightProperties[id].flammable !== null;
}

/**
 * Blocks with no physical collision box: nothing to stand on / bump into.
 * Shared by the physics collider list and anything else that needs to know
 * "can a player/camera pass through this" (e.g. the 3rd-person camera boom).
 */
const NON_SOLID_BLOCKS = new Set<BlockId>([BlockId.AIR, BlockId.WATER, BlockId.LAVA, BlockId.FIRE, BlockId.TORCH]);
export function isSolidBlock(id: BlockId): boolean {
  return !NON_SOLID_BLOCKS.has(id);
}

/** Blocks that respond to right-click (open a GUI) instead of being placed against. */
export const INTERACTIVE_BLOCKS = new Set<BlockId>([BlockId.CRAFTING_TABLE, BlockId.FURNACE]);

/** Blocks that carry side-table state (facing / lit / half / axis / open) the mesher must read. */
export const STATEFUL_BLOCKS = new Set<BlockId>([
  BlockId.FURNACE, BlockId.TORCH,
  BlockId.OAK_STAIRS, BlockId.COBBLESTONE_STAIRS, BlockId.OAK_SLAB, BlockId.COBBLESTONE_SLAB,
  BlockId.OAK_LOG, BlockId.OAK_FENCE_GATE,
]);

/** Blocks whose `facing` is set from the player's yaw when placed. */
export const ORIENTABLE_BLOCKS = new Set<BlockId>([BlockId.FURNACE, BlockId.OAK_FENCE_GATE]);

/** Blocks that toggle open/closed on right-click instead of placing/opening a GUI. */
export const TOGGLEABLE_BLOCKS = new Set<BlockId>([BlockId.OAK_FENCE_GATE]);
export function isToggleable(id: BlockId): boolean {
  return TOGGLEABLE_BLOCKS.has(id);
}

/** Block light a furnace gives off while it is lit (LCE: like a torch, 14-15). */
export const FURNACE_LIT_LIGHT = 15;
export function isOrientable(id: BlockId): boolean {
  return ORIENTABLE_BLOCKS.has(id);
}
export function isInteractive(id: BlockId): boolean {
  return INTERACTIVE_BLOCKS.has(id);
}

export const blockGeometry = new THREE.BoxGeometry(1, 1, 1);

/** Every plain (non-animated) 16x16 block texture, packed into one shared atlas. */
export const BLOCK_ATLAS_TILES = [
  'bedrock', 'oak_planks', 'stone', 'dirt', 'grass_top', 'grass', 'glowstone',
  'oak_log', 'oak_log_top', 'oak_leaves', 'sand', 'gravel', 'cobblestone',
  'obsidian', 'ice', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
  'emerald_ore', 'lapis_ore', 'redstone_ore', 'crafting_table_side1',
  'crafting_table_side2', 'crafting_table_top', 'glass', 'furnace_side',
  'furnace_off', 'furnace_on', 'furnace_top', 'torch', 'wool',
] as const;
export type BlockAtlasKey = (typeof BLOCK_ATLAS_TILES)[number];
const BLOCK_ATLAS_COLS = 32;
const BLOCK_ATLAS_ROWS = 32; // 1024 tiles of headroom - 32 used today

export type BlockMaterials = {
  /** Shared source of pixel rects for every static block texture (opaque and special alike) - see BlockAtlasKey. */
  atlas: Atlas;
  /** One shared material for the (large majority) of blocks with no special transparency/tint. */
  opaque: THREE.MeshBasicMaterial;
  /** These need their own render state (transparency/tint/culling), so they can't share `opaque` - but still sample the same atlas texture+rects. */
  leaves: THREE.MeshBasicMaterial;
  glass: THREE.MeshBasicMaterial;
  ice: THREE.MeshBasicMaterial;
  torch: THREE.MeshBasicMaterial;
  /** Animated scrolling-frame strips - can't fit a static atlas tile, stay as their own dedicated textures. */
  waterStill: THREE.MeshBasicMaterial;
  waterFlow: THREE.MeshBasicMaterial;
  lavaStill: THREE.MeshBasicMaterial;
  lavaFlow: THREE.MeshBasicMaterial;
  fire: THREE.MeshBasicMaterial;
  updateWaterAnimation: (time: number) => void;
};

export async function createBlockMaterials(): Promise<BlockMaterials> {
  const atlas = await buildAtlas(
    BLOCK_ATLAS_TILES.map((name) => ({ key: name, url: new URL(`../textures/blocks/${name}.png`, import.meta.url).href })),
    BLOCK_ATLAS_COLS, BLOCK_ATLAS_ROWS,
  );

  const opaque = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true });
  const leaves = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, transparent: true, alphaTest: 0.5, color: 0x4a8a2e });
  const glass = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
  const ice = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const torch = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, transparent: true, alphaTest: 0.1, depthWrite: true, side: THREE.DoubleSide });

  // Animated liquids/fire: unchanged from before the atlas - the
  // scrolling-frame technique (repeat/offset scrolled across the whole
  // strip) doesn't fit a shared static atlas tile, so these keep their own
  // dedicated textures exactly as they worked previously.
  const loader = new THREE.TextureLoader();
  const waterStillTex = loader.load(new URL('../textures/atlas/water_still.png', import.meta.url).href);
  const waterFlowTex = loader.load(new URL('../textures/atlas/water_flow.png', import.meta.url).href);
  const fireTex = loader.load(new URL('../textures/atlas/fire_atlas.png', import.meta.url).href);
  const lavaStillTex = loader.load(new URL('../textures/atlas/lava_still.png', import.meta.url).href);
  const lavaFlowTex = loader.load(new URL('../textures/atlas/lava_flow.png', import.meta.url).href);

  for (const texture of [fireTex]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
  }

  fireTex.wrapT = THREE.RepeatWrapping;
  fireTex.repeat.set(1, 1 / 32);
  fireTex.offset.set(0, 31 / 32);

  waterStillTex.colorSpace = THREE.SRGBColorSpace;
  waterStillTex.magFilter = THREE.NearestFilter;
  waterStillTex.minFilter = THREE.NearestFilter;
  waterStillTex.wrapS = THREE.RepeatWrapping;
  waterStillTex.wrapT = THREE.RepeatWrapping;
  waterStillTex.repeat.set(1, 1 / 32);
  waterStillTex.offset.set(0, 31 / 32);

  waterFlowTex.colorSpace = THREE.SRGBColorSpace;
  waterFlowTex.magFilter = THREE.NearestFilter;
  waterFlowTex.minFilter = THREE.NearestFilter;
  waterFlowTex.wrapS = THREE.RepeatWrapping;
  waterFlowTex.wrapT = THREE.RepeatWrapping;
  waterFlowTex.repeat.set(0.5, 1 / 64);
  waterFlowTex.offset.set(0, 63 / 64);

  for (const texture of [lavaStillTex, lavaFlowTex]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  lavaStillTex.repeat.set(1, 1 / 20);
  lavaStillTex.offset.set(0, 19 / 20);
  lavaFlowTex.repeat.set(0.5, 1 / 32);
  lavaFlowTex.offset.set(0, 31 / 32);

  const waterStill = new THREE.MeshBasicMaterial({ map: waterStillTex, color: 0x3f76e4, transparent: true, opacity: 0.82, side: THREE.DoubleSide, vertexColors: true });
  const waterFlow = new THREE.MeshBasicMaterial({ map: waterFlowTex, color: 0x3f76e4, transparent: true, opacity: 0.82, side: THREE.DoubleSide, vertexColors: true });
  const lavaStill = new THREE.MeshBasicMaterial({ map: lavaStillTex, transparent: true, opacity: 0.9, side: THREE.DoubleSide, vertexColors: true });
  const lavaFlow = new THREE.MeshBasicMaterial({ map: lavaFlowTex, transparent: true, opacity: 0.9, side: THREE.DoubleSide, vertexColors: true });
  const fire = new THREE.MeshBasicMaterial({ map: fireTex, transparent: true, alphaTest: 0.05, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });

  const updateWaterAnimation = (time: number) => {
    const stillFrame = Math.floor(time * 16) % 32;
    waterStillTex.offset.y = (31 - stillFrame) / 32;

    const flowFrame = Math.floor(time * 16) % 64;
    waterFlowTex.offset.y = (63 - flowFrame) / 64;
    const fireFrame = Math.floor(time * 20) % 32;
    fireTex.offset.y = (31 - fireFrame) / 32;
    const lavaStillFrame = Math.floor(time * 8) % 20;
    lavaStillTex.offset.y = (19 - lavaStillFrame) / 20;
    const lavaFlowFrame = Math.floor(time * 8) % 32;
    lavaFlowTex.offset.y = (31 - lavaFlowFrame) / 32;
  };

  return { atlas, opaque, leaves, glass, ice, torch, waterStill, waterFlow, lavaStill, lavaFlow, fire, updateWaterAnimation };
}

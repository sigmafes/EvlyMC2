import * as THREE from 'three';

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

export type RenderableBlockId = Exclude<BlockId, BlockId.AIR>;
export type BlockMaterials = Record<RenderableBlockId, THREE.Material | THREE.Material[]> & {
  updateWaterAnimation?: (time: number) => void;
};

export const blockGeometry = new THREE.BoxGeometry(1, 1, 1);

export function createBlockMaterials(): BlockMaterials {
  const loader = new THREE.TextureLoader();
  const bedrock = loader.load(new URL('../textures/blocks/bedrock.png', import.meta.url).href);
  const oakPlanks = loader.load(new URL('../textures/blocks/oak_planks.png', import.meta.url).href);
  const stone = loader.load(new URL('../textures/blocks/stone.png', import.meta.url).href);
  const dirt = loader.load(new URL('../textures/blocks/dirt.png', import.meta.url).href);
  const grassTop = loader.load(new URL('../textures/blocks/grass_top.png', import.meta.url).href);
  const grassSide = loader.load(new URL('../textures/blocks/grass.png', import.meta.url).href);
  const glowstone = loader.load(new URL('../textures/blocks/glowstone.png', import.meta.url).href);
  const oakLog = loader.load(new URL('../textures/blocks/oak_log.png', import.meta.url).href);
  const oakLogTop = loader.load(new URL('../textures/blocks/oak_log_top.png', import.meta.url).href);
  const oakLeaves = loader.load(new URL('../textures/blocks/oak_leaves.png', import.meta.url).href);
  const sand = loader.load(new URL('../textures/blocks/sand.png', import.meta.url).href);
  const gravel = loader.load(new URL('../textures/blocks/gravel.png', import.meta.url).href);
  const waterStill = loader.load(new URL('../textures/atlas/water_still.png', import.meta.url).href);
  const waterFlow = loader.load(new URL('../textures/atlas/water_flow.png', import.meta.url).href);
  const fireAtlas = loader.load(new URL('../textures/atlas/fire_atlas.png', import.meta.url).href);
  const lavaStill = loader.load(new URL('../textures/atlas/lava_still.png', import.meta.url).href);
  const lavaFlow = loader.load(new URL('../textures/atlas/lava_flow.png', import.meta.url).href);
  const cobblestone = loader.load(new URL('../textures/blocks/cobblestone.png', import.meta.url).href);
  const obsidian = loader.load(new URL('../textures/blocks/obsidian.png', import.meta.url).href);
  const ice = loader.load(new URL('../textures/blocks/ice.png', import.meta.url).href);
  const coalOre = loader.load(new URL('../textures/blocks/coal_ore.png', import.meta.url).href);
  const ironOre = loader.load(new URL('../textures/blocks/iron_ore.png', import.meta.url).href);
  const goldOre = loader.load(new URL('../textures/blocks/gold_ore.png', import.meta.url).href);
  const diamondOre = loader.load(new URL('../textures/blocks/diamond_ore.png', import.meta.url).href);
  const emeraldOre = loader.load(new URL('../textures/blocks/emerald_ore.png', import.meta.url).href);
  const lapisOre = loader.load(new URL('../textures/blocks/lapis_ore.png', import.meta.url).href);
  const redstoneOre = loader.load(new URL('../textures/blocks/redstone_ore.png', import.meta.url).href);
  const craftingTableSide1 = loader.load(new URL('../textures/blocks/crafting_table_side1.png', import.meta.url).href);
  const craftingTableSide2 = loader.load(new URL('../textures/blocks/crafting_table_side2.png', import.meta.url).href);
  const craftingTableTop = loader.load(new URL('../textures/blocks/crafting_table_top.png', import.meta.url).href);
  const glass = loader.load(new URL('../textures/blocks/glass.png', import.meta.url).href);
  const furnaceSide = loader.load(new URL('../textures/blocks/furnace_side.png', import.meta.url).href);
  const furnaceOff = loader.load(new URL('../textures/blocks/furnace_off.png', import.meta.url).href);
  const furnaceOn = loader.load(new URL('../textures/blocks/furnace_on.png', import.meta.url).href);
  const furnaceTop = loader.load(new URL('../textures/blocks/furnace_top.png', import.meta.url).href);
  const torch = loader.load(new URL('../textures/blocks/torch.png', import.meta.url).href);
  const wool = loader.load(new URL('../textures/blocks/wool.png', import.meta.url).href);

  for (const texture of [bedrock, oakPlanks, stone, dirt, grassTop, grassSide, glowstone, oakLog, oakLogTop, oakLeaves, sand, gravel, fireAtlas, cobblestone, obsidian, ice, coalOre, ironOre, goldOre, diamondOre, emeraldOre, lapisOre, redstoneOre, craftingTableSide1, craftingTableSide2, craftingTableTop, glass, furnaceSide, furnaceOff, furnaceOn, furnaceTop, torch, wool]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
  }

  fireAtlas.wrapS = THREE.ClampToEdgeWrapping;
  fireAtlas.wrapT = THREE.RepeatWrapping;
  fireAtlas.repeat.set(1, 1 / 32);
  fireAtlas.offset.set(0, 31 / 32);

  waterStill.colorSpace = THREE.SRGBColorSpace;
  waterStill.magFilter = THREE.NearestFilter;
  waterStill.minFilter = THREE.NearestFilter;
  waterStill.wrapS = THREE.RepeatWrapping;
  waterStill.wrapT = THREE.RepeatWrapping;
  waterStill.repeat.set(1, 1 / 32);
  waterStill.offset.set(0, 31 / 32);

  waterFlow.colorSpace = THREE.SRGBColorSpace;
  waterFlow.magFilter = THREE.NearestFilter;
  waterFlow.minFilter = THREE.NearestFilter;
  waterFlow.wrapS = THREE.RepeatWrapping;
  waterFlow.wrapT = THREE.RepeatWrapping;
  waterFlow.repeat.set(0.5, 1 / 64);
  waterFlow.offset.set(0, 63 / 64);

  for (const texture of [lavaStill, lavaFlow]) {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
  }
  lavaStill.repeat.set(1, 1 / 20);
  lavaStill.offset.set(0, 19 / 20);
  lavaFlow.repeat.set(0.5, 1 / 32);
  lavaFlow.offset.set(0, 31 / 32);

  const grass = [
    new THREE.MeshBasicMaterial({ map: grassSide, vertexColors: true }),
    new THREE.MeshBasicMaterial({ map: grassTop, vertexColors: true }),
    new THREE.MeshBasicMaterial({ map: dirt, vertexColors: true }),
  ];

  const materials: BlockMaterials = {
    [BlockId.BEDROCK]: new THREE.MeshBasicMaterial({ map: bedrock, vertexColors: true }),
    [BlockId.OAK_PLANKS]: new THREE.MeshBasicMaterial({ map: oakPlanks, vertexColors: true }),
    [BlockId.STONE]: new THREE.MeshBasicMaterial({ map: stone, vertexColors: true }),
    [BlockId.DIRT]: new THREE.MeshBasicMaterial({ map: dirt, vertexColors: true }),
    [BlockId.GRASS]: grass,
    [BlockId.GLOWSTONE]: new THREE.MeshBasicMaterial({ map: glowstone, vertexColors: true }),
    [BlockId.OAK_LOG]: [
      new THREE.MeshBasicMaterial({ map: oakLog, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: oakLogTop, vertexColors: true }),
    ],
    [BlockId.OAK_LEAVES]: new THREE.MeshBasicMaterial({ map: oakLeaves, vertexColors: true, transparent: true, alphaTest: 0.5, color: 0x4a8a2e }),
    [BlockId.SAND]: new THREE.MeshBasicMaterial({ map: sand, vertexColors: true }),
    [BlockId.GRAVEL]: new THREE.MeshBasicMaterial({ map: gravel, vertexColors: true }),
    [BlockId.WATER]: [
      new THREE.MeshBasicMaterial({
        map: waterStill,
        color: 0x3f76e4,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        vertexColors: true,
      }),
      new THREE.MeshBasicMaterial({
        map: waterFlow,
        color: 0x3f76e4,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        vertexColors: true,
      }),
    ],
    [BlockId.FIRE]: new THREE.MeshBasicMaterial({
      map: fireAtlas,
      transparent: true,
      alphaTest: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    [BlockId.LAVA]: [
      new THREE.MeshBasicMaterial({ map: lavaStill, transparent: true, opacity: 0.9, side: THREE.DoubleSide, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: lavaFlow, transparent: true, opacity: 0.9, side: THREE.DoubleSide, vertexColors: true }),
    ],
    [BlockId.COBBLESTONE]: new THREE.MeshBasicMaterial({ map: cobblestone, vertexColors: true }),
    [BlockId.OBSIDIAN]: new THREE.MeshBasicMaterial({ map: obsidian, vertexColors: true }),
    [BlockId.COAL_ORE]: new THREE.MeshBasicMaterial({ map: coalOre, vertexColors: true }),
    [BlockId.IRON_ORE]: new THREE.MeshBasicMaterial({ map: ironOre, vertexColors: true }),
    [BlockId.GOLD_ORE]: new THREE.MeshBasicMaterial({ map: goldOre, vertexColors: true }),
    [BlockId.DIAMOND_ORE]: new THREE.MeshBasicMaterial({ map: diamondOre, vertexColors: true }),
    [BlockId.EMERALD_ORE]: new THREE.MeshBasicMaterial({ map: emeraldOre, vertexColors: true }),
    [BlockId.LAPIS_ORE]: new THREE.MeshBasicMaterial({ map: lapisOre, vertexColors: true }),
    [BlockId.REDSTONE_ORE]: new THREE.MeshBasicMaterial({ map: redstoneOre, vertexColors: true }),
    [BlockId.CRAFTING_TABLE]: [
      new THREE.MeshBasicMaterial({ map: craftingTableSide1, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: craftingTableSide2, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: craftingTableTop, vertexColors: true }),
    ],
    [BlockId.ICE]: new THREE.MeshBasicMaterial({
      map: ice,
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    [BlockId.GLASS]: new THREE.MeshBasicMaterial({
      map: glass,
      transparent: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    // Order matters: [side, front-off, front-on, top] must match MATERIAL_FURNACE_* in mesher.ts.
    [BlockId.FURNACE]: [
      new THREE.MeshBasicMaterial({ map: furnaceSide, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: furnaceOff, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: furnaceOn, vertexColors: true }),
      new THREE.MeshBasicMaterial({ map: furnaceTop, vertexColors: true }),
    ],
    [BlockId.TORCH]: new THREE.MeshBasicMaterial({
      map: torch,
      transparent: true,
      alphaTest: 0.1,
      depthWrite: true,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    [BlockId.WOOL]: new THREE.MeshBasicMaterial({ map: wool, vertexColors: true }),
    // Stairs/slabs are cut from their parent block and share its texture.
    [BlockId.OAK_STAIRS]: new THREE.MeshBasicMaterial({ map: oakPlanks, vertexColors: true }),
    [BlockId.OAK_SLAB]: new THREE.MeshBasicMaterial({ map: oakPlanks, vertexColors: true }),
    [BlockId.COBBLESTONE_STAIRS]: new THREE.MeshBasicMaterial({ map: cobblestone, vertexColors: true }),
    [BlockId.COBBLESTONE_SLAB]: new THREE.MeshBasicMaterial({ map: cobblestone, vertexColors: true }),
    // Fence/gate/wall are cut from their parent block too (same as stairs/slabs above).
    [BlockId.OAK_FENCE]: new THREE.MeshBasicMaterial({ map: oakPlanks, vertexColors: true }),
    [BlockId.OAK_FENCE_GATE]: new THREE.MeshBasicMaterial({ map: oakPlanks, vertexColors: true }),
    [BlockId.COBBLESTONE_WALL]: new THREE.MeshBasicMaterial({ map: cobblestone, vertexColors: true }),
  };

  materials.updateWaterAnimation = (time: number) => {
    const stillFrame = Math.floor(time * 16) % 32;
    waterStill.offset.y = (31 - stillFrame) / 32;

    const flowFrame = Math.floor(time * 16) % 64;
    waterFlow.offset.y = (63 - flowFrame) / 64;
    const fireFrame = Math.floor(time * 20) % 32;
    fireAtlas.offset.y = (31 - fireFrame) / 32;
    const lavaStillFrame = Math.floor(time * 8) % 20;
    lavaStill.offset.y = (19 - lavaStillFrame) / 20;
    const lavaFlowFrame = Math.floor(time * 8) % 32;
    lavaFlow.offset.y = (31 - lavaFlowFrame) / 32;
  };

  return materials;
}

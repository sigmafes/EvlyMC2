import { BlockId } from './block';
import { ItemId } from './item';

export type RecipeOutput = { id: number; count: number };

type ShapelessRecipe = { kind: 'shapeless'; input: number[]; out: RecipeOutput };
type ShapedRecipe = { kind: 'shaped'; pattern: (number | null)[][]; out: RecipeOutput };
export type Recipe = ShapelessRecipe | ShapedRecipe;

const P = BlockId.OAK_PLANKS;
const S = ItemId.STICK;
const C = BlockId.COBBLESTONE;
const _ = null;

/** Pickaxe / axe (both mirrors) / shovel from a single material `m`. */
function toolSet(m: number, pick: number, axe: number, shovel: number): Recipe[] {
  return [
    { kind: 'shaped', pattern: [[m, m, m], [_, S, _], [_, S, _]], out: { id: pick, count: 1 } },
    { kind: 'shaped', pattern: [[m, m], [m, S], [_, S]], out: { id: axe, count: 1 } },
    { kind: 'shaped', pattern: [[m, m], [S, m], [S, _]], out: { id: axe, count: 1 } },
    { kind: 'shaped', pattern: [[m], [S], [S]], out: { id: shovel, count: 1 } },
  ];
}

/** Sword from a single material `m`, 2 material + 1 stick in a column. */
function swordRecipe(m: number, sword: number): Recipe {
  return { kind: 'shaped', pattern: [[m], [m], [S]], out: { id: sword, count: 1 } };
}

export const RECIPES: Recipe[] = [
  { kind: 'shapeless', input: [BlockId.OAK_LOG], out: { id: BlockId.OAK_PLANKS, count: 4 } },
  { kind: 'shaped', pattern: [[P, P], [P, P]], out: { id: BlockId.CRAFTING_TABLE, count: 1 } },
  { kind: 'shaped', pattern: [[P], [P]], out: { id: ItemId.STICK, count: 4 } },

  // Furnace: a ring of 8 cobblestone (3x3 only, like the tool recipes).
  { kind: 'shaped', pattern: [[C, C, C], [C, _, C], [C, C, C]], out: { id: BlockId.FURNACE, count: 1 } },
  // Torch: coal (or charcoal) over a stick.
  { kind: 'shaped', pattern: [[ItemId.COAL], [S]], out: { id: BlockId.TORCH, count: 4 } },
  { kind: 'shaped', pattern: [[ItemId.CHARCOAL], [S]], out: { id: BlockId.TORCH, count: 4 } },

  // Stairs: 6 in a staircase pattern -> 4, both mirrors (like the axe recipes).
  { kind: 'shaped', pattern: [[P, _, _], [P, P, _], [P, P, P]], out: { id: BlockId.OAK_STAIRS, count: 4 } },
  { kind: 'shaped', pattern: [[_, _, P], [_, P, P], [P, P, P]], out: { id: BlockId.OAK_STAIRS, count: 4 } },
  { kind: 'shaped', pattern: [[C, _, _], [C, C, _], [C, C, C]], out: { id: BlockId.COBBLESTONE_STAIRS, count: 4 } },
  { kind: 'shaped', pattern: [[_, _, C], [_, C, C], [C, C, C]], out: { id: BlockId.COBBLESTONE_STAIRS, count: 4 } },
  // Slabs: 3 in a row -> 6.
  { kind: 'shaped', pattern: [[P, P, P]], out: { id: BlockId.OAK_SLAB, count: 6 } },
  { kind: 'shaped', pattern: [[C, C, C]], out: { id: BlockId.COBBLESTONE_SLAB, count: 6 } },

  ...toolSet(P, ItemId.WOODEN_PICKAXE, ItemId.WOODEN_AXE, ItemId.WOODEN_SHOVEL),
  ...toolSet(BlockId.COBBLESTONE, ItemId.STONE_PICKAXE, ItemId.STONE_AXE, ItemId.STONE_SHOVEL),
  ...toolSet(ItemId.IRON_INGOT, ItemId.IRON_PICKAXE, ItemId.IRON_AXE, ItemId.IRON_SHOVEL),
  ...toolSet(ItemId.GOLD_INGOT, ItemId.GOLDEN_PICKAXE, ItemId.GOLDEN_AXE, ItemId.GOLDEN_SHOVEL),
  ...toolSet(ItemId.DIAMOND, ItemId.DIAMOND_PICKAXE, ItemId.DIAMOND_AXE, ItemId.DIAMOND_SHOVEL),

  swordRecipe(P, ItemId.WOODEN_SWORD),
  swordRecipe(BlockId.COBBLESTONE, ItemId.STONE_SWORD),
  swordRecipe(ItemId.IRON_INGOT, ItemId.IRON_SWORD),
  swordRecipe(ItemId.GOLD_INGOT, ItemId.GOLDEN_SWORD),
  swordRecipe(ItemId.DIAMOND, ItemId.DIAMOND_SWORD),

  // Arrow: flint head, stick shaft, feather fletching -> 4 (vanilla recipe).
  { kind: 'shaped', pattern: [[ItemId.FLINT], [S], [ItemId.FEATHER]], out: { id: ItemId.ARROW, count: 4 } },
  // Flint and Steel: iron ingot + flint on the opposite diagonal (vanilla recipe).
  { kind: 'shaped', pattern: [[ItemId.IRON_INGOT, _], [_, ItemId.FLINT]], out: { id: ItemId.FLINT_AND_STEEL, count: 1 } },
];

/**
 * Match a crafting grid (row-major, `w`×`h`, `null` = empty slot; counts are
 * ignored) against the recipe list. Shaped recipes match anywhere in the grid
 * (empty rows/columns are trimmed off both sides), so the same list serves the
 * 2×2 inventory grid and the 3×3 crafting-table grid.
 */
export function matchRecipe(grid: (number | null)[], w: number, h: number): RecipeOutput | null {
  const items = grid.filter((c): c is number => c != null);
  if (items.length === 0) return null;

  for (const recipe of RECIPES) {
    if (recipe.kind === 'shapeless') {
      if (sameMultiset(items, recipe.input)) return recipe.out;
    } else if (matchShaped(grid, w, h, recipe.pattern)) {
      return recipe.out;
    }
  }
  return null;
}

function sameMultiset(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const count = new Map<number, number>();
  for (const x of a) count.set(x, (count.get(x) ?? 0) + 1);
  for (const x of b) {
    const n = (count.get(x) ?? 0) - 1;
    if (n < 0) return false;
    count.set(x, n);
  }
  return true;
}

type Trimmed = { rows: (number | null)[][]; w: number; h: number };

function boundingBox(get: (x: number, y: number) => number | null, w: number, h: number): Trimmed | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (get(x, y) != null) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) return null;
  const rows: (number | null)[][] = [];
  for (let y = minY; y <= maxY; y++) {
    const row: (number | null)[] = [];
    for (let x = minX; x <= maxX; x++) row.push(get(x, y));
    rows.push(row);
  }
  return { rows, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function matchShaped(grid: (number | null)[], w: number, h: number, pattern: (number | null)[][]): boolean {
  const g = boundingBox((x, y) => grid[y * w + x] ?? null, w, h);
  const p = boundingBox((x, y) => pattern[y]?.[x] ?? null, Math.max(...pattern.map((r) => r.length)), pattern.length);
  if (!g || !p || g.w !== p.w || g.h !== p.h) return false;

  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (g.rows[y][x] !== p.rows[y][x]) return false;
    }
  }
  return true;
}

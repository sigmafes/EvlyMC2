import { maxStackOf } from './item';
import { COOK_SECONDS, smeltResult, fuelSeconds } from './smelting';
import type { FurnaceState, SlotRef } from './block-data';

/**
 * Runs every lit / loaded furnace: burns fuel, advances the cook timer, moves
 * finished items to the output. State lives in the world's block-data side
 * table (persisted); this just steps it each frame.
 *
 * The furnace GUI (phase 5) writes into the same FurnaceState and reads
 * `cookTime / COOK_SECONDS` and `litTime / litDuration` for its gauges.
 */
export class FurnaceManager {
  constructor(
    private readonly world: {
      eachFurnace: (cb: (x: number, y: number, z: number, s: FurnaceState) => void) => void;
      setFurnaceState: (x: number, y: number, z: number, s: FurnaceState | undefined) => void;
      setBlockData: (x: number, y: number, z: number, patch: { lit: boolean }) => void;
    },
  ) {}

  tick(delta: number): void {
    if (delta <= 0) return;
    this.world.eachFurnace((x, y, z, s) => {
      const wasLit = s.litTime > 0;
      this.step(s, Math.min(delta, 0.25));
      const nowLit = s.litTime > 0;

      if (wasLit !== nowLit) this.world.setBlockData(x, y, z, { lit: nowLit });

      // A cold, empty furnace can drop out of the active set entirely.
      const idle = !s.input && !s.fuel && !s.output && s.litTime <= 0 && s.cookTime <= 0;
      this.world.setFurnaceState(x, y, z, idle ? undefined : s);
    });
  }

  private step(s: FurnaceState, delta: number): void {
    const recipe = smeltResult(s.input?.id);
    const outputHasRoom =
      recipe != null &&
      (s.output == null ||
        (s.output.id === recipe.id && s.output.count + recipe.count <= maxStackOf(recipe.id)));
    const canCook = s.input != null && recipe != null && outputHasRoom;

    // Light the furnace: consume one fuel unit when there's something to cook.
    if (s.litTime <= 0 && canCook && s.fuel != null && fuelSeconds(s.fuel.id) > 0) {
      const secs = fuelSeconds(s.fuel.id);
      s.litDuration = secs;
      s.litTime = secs;
      s.fuel = decrement(s.fuel);
    }

    if (s.litTime > 0) {
      s.litTime = Math.max(0, s.litTime - delta);
      if (canCook) {
        s.cookTime += delta;
        if (s.cookTime >= COOK_SECONDS) {
          s.cookTime = 0;
          s.input = decrement(s.input!);
          s.output = s.output
            ? { id: s.output.id, count: s.output.count + recipe!.count }
            : { id: recipe!.id, count: recipe!.count };
        }
      } else {
        // No valid recipe right now: progress bleeds off (LCE).
        s.cookTime = Math.max(0, s.cookTime - delta * 2);
      }
    } else {
      s.cookTime = Math.max(0, s.cookTime - delta * 2);
    }
  }
}

function decrement(slot: NonNullable<SlotRef>): SlotRef {
  return slot.count > 1 ? { id: slot.id, count: slot.count - 1 } : null;
}

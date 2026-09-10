import { matchRecipe } from './crafting';
import { makeStack } from './item-stack';
import { createEmptySlot, normalizeSlot, renderSlot, type InventorySlot } from './inventory';

/**
 * A square crafting grid (2x2 or 3x3) plus its result slot. Holds its own slot
 * state and re-derives the output from the recipe list on every change. The
 * owner (Inventory / CraftingTableUI) routes clicks and the held-item cursor.
 */
export class CraftingGrid {
  readonly inputs: InventorySlot[];
  output: InventorySlot = createEmptySlot();

  private inputEls: HTMLElement[] = [];
  private outputEl: HTMLElement | null = null;

  constructor(readonly side: 2 | 3) {
    this.inputs = Array.from({ length: side * side }, createEmptySlot);
  }

  bind(inputEls: HTMLElement[], outputEl: HTMLElement) {
    this.inputEls = inputEls;
    this.outputEl = outputEl;
    this.renderAll();
  }

  get(i: number): InventorySlot {
    return this.inputs[i];
  }

  set(i: number, slot: InventorySlot | null) {
    this.inputs[i] = normalizeSlot(slot);
    if (this.inputEls[i]) renderSlot(this.inputEls[i], this.inputs[i]);
    this.recompute();
  }

  recompute() {
    const result = matchRecipe(this.inputs.map((s) => s.id), this.side, this.side);
    this.output = result ? makeStack(result.id, result.count) : createEmptySlot();
    if (this.outputEl) renderSlot(this.outputEl, this.output);
  }

  /** Taking the result removes one item from each occupied input slot. */
  consumeCraft() {
    for (let i = 0; i < this.inputs.length; i++) {
      const s = this.inputs[i];
      if (s.id === null) continue;
      const n = (s.count ?? 1) - 1;
      this.inputs[i] = n > 0 ? normalizeSlot({ ...s, count: n }) : createEmptySlot();
      if (this.inputEls[i]) renderSlot(this.inputEls[i], this.inputs[i]);
    }
    this.recompute();
  }

  /** Empty the grid, handing every non-empty stack to `sink`. */
  returnAll(sink: (s: InventorySlot) => void) {
    for (let i = 0; i < this.inputs.length; i++) {
      if (this.inputs[i].id !== null) sink({ ...this.inputs[i] });
      this.inputs[i] = createEmptySlot();
      if (this.inputEls[i]) renderSlot(this.inputEls[i], this.inputs[i]);
    }
    this.recompute();
  }

  /** Re-render every cell (e.g. after the WebGL context warms up, or on GUI open). */
  refresh() {
    this.inputs.forEach((s, i) => this.inputEls[i] && renderSlot(this.inputEls[i], s));
    if (this.outputEl) renderSlot(this.outputEl, this.output);
  }

  private renderAll() {
    this.refresh();
  }
}

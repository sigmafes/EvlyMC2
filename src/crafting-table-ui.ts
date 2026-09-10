import { CraftingGrid } from './crafting-grid';
import { lockPointer } from './is-touch';
import type { Inventory } from './inventory';

/**
 * The 3x3 crafting-table screen (Crafting_table_gui.png): a 9-slot grid + result
 * plus a mirror of the player's 36 inventory slots. Shares the Inventory's
 * held-item cursor via `bindCraftGrid` / `attachExtraSlots`.
 */
export class CraftingTableUI {
  private readonly root = document.querySelector<HTMLElement>('#crafting-table')!;
  private readonly grid = new CraftingGrid(3);
  private isOpen = false;

  constructor(
    private readonly inventory: Inventory,
    private readonly onToggle: (open: boolean) => void,
  ) {
    const panel = this.root.querySelector<HTMLElement>('#crafting-table-panel')!;

    const craftRoot = panel.querySelector<HTMLElement>('#ct-craft')!;
    const craftEls = Array.from({ length: 9 }, () => this.makeSlot(craftRoot));
    const resultEl = panel.querySelector<HTMLButtonElement>('.ct-result')!;
    this.inventory.bindCraftGrid(this.grid, craftEls, resultEl);

    // Slot elements indexed by inventory slot: hotbar 0..8, backpack 9..35.
    const bpRoot = panel.querySelector<HTMLElement>('#ct-backpack')!;
    const hbRoot = panel.querySelector<HTMLElement>('#ct-hotbar')!;
    const slotEls: (HTMLElement | null)[] = new Array(36).fill(null);
    for (let i = 9; i < 36; i++) slotEls[i] = this.makeSlot(bpRoot);
    for (let i = 0; i < 9; i++) slotEls[i] = this.makeSlot(hbRoot);
    this.inventory.attachExtraSlots(slotEls);
  }

  private makeSlot(parent: HTMLElement): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'inventory-slot ct-slot';
    parent.appendChild(el);
    return el;
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.inventory.refreshAll();
    this.inventory.setExternalUiOpen(true, () => this.close());
    document.exitPointerLock();
    this.onToggle(true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.inventory.setExternalUiOpen(false); // puts any held stack back first
    this.grid.returnAll((s) => this.inventory.addItem(s));
    this.root.hidden = true;
    this.onToggle(false);
    lockPointer(document.querySelector<HTMLCanvasElement>('#game-canvas'));
  }
}

import { renderBlockPreview, renderItemIcon } from './block-preview';
import { isBlock, maxStackOf } from './item';
import { showTooltip, hideTooltip } from './tooltip';
import { CraftingGrid } from './crafting-grid';

export type InventorySlot = {
  /** BlockId value (1..23) for blocks, ItemId value (100+) for items, null when empty. */
  id: number | null;
  name: string;
  /** Block: side texture. Item: the icon texture path. */
  sideTexture?: string;
  topTexture?: string;
  previewColor?: number;
  /** Stack size (1..maxStack). Absent on catalog entries; 0 on empty slots. */
  count?: number;
};

/** 9 hotbar slots + 27 backpack slots, like Minecraft's survival/creative inventory. */
export const HOTBAR_SIZE = 9;
export const BACKPACK_SIZE = 27;
export const TOTAL_SLOTS = HOTBAR_SIZE + BACKPACK_SIZE;
export const MAX_STACK = 64;

export function createEmptySlot(): InventorySlot {
  return { id: null, name: 'Empty', count: 0 };
}

/** Normalise any slot-like object into a stored slot (clamped count, empty when id null). */
export function normalizeSlot(slot: InventorySlot | null): InventorySlot {
  if (!slot || slot.id === null) return createEmptySlot();
  const count = Math.max(1, Math.min(maxStackOf(slot.id), Math.floor(slot.count ?? 1)));
  return { ...slot, count };
}

/** Draw a slot's item (preview + stack count) into a slot/ghost element. */
export function renderSlot(element: HTMLElement, slot: InventorySlot) {
  element.innerHTML = '';
  element.setAttribute('aria-label', slot.name);
  if (slot.id === null) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'inventory-block';
  canvas.setAttribute('aria-hidden', 'true');
  element.appendChild(canvas);
  if (isBlock(slot.id)) renderBlockPreview(canvas, slot);
  else renderItemIcon(canvas, slot.sideTexture ?? '');

  const count = slot.count ?? 1;
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'slot-count';
    badge.textContent = String(count);
    element.appendChild(badge);
  }
}

/** Where a picked-up stack came from (so it can be put back / swapped). */
type SlotSource =
  | { kind: 'stored'; index: number }
  | { kind: 'craft'; grid: CraftingGrid; index: number }
  | null;

function sameSource(a: SlotSource, b: SlotSource): boolean {
  if (!a || !b || a.kind !== b.kind || a.index !== b.index) return false;
  return a.kind === 'stored' || a.grid === (b as { grid: CraftingGrid }).grid;
}

const slots: InventorySlot[] = Array.from({ length: TOTAL_SLOTS }, createEmptySlot);

export class Inventory {
  /** Elements sharing the same slot index (hotbar slots are mirrored in the backpack view). */
  private readonly elementsByIndex: HTMLButtonElement[][] = [];
  private readonly backpackPanel: HTMLElement;
  private selectedIndex = 0;
  private backpackOpen = false;

  /** 2x2 crafting grid drawn on the survival inventory panel. */
  private readonly craftGrid = new CraftingGrid(2);

  private heldItem: InventorySlot | null = null;
  private heldFrom: SlotSource = null;
  private ghostElement: HTMLElement | null = null;

  /** True while an external GUI (crafting table) owns the screen; suppresses the E toggle. */
  private externalUiOpen = false;
  private externalUiCloser: (() => void) | null = null;

  /** DOM element -> the slot it represents, for the swipe-to-deposit gesture. */
  private readonly slotSourceByEl = new Map<HTMLElement, NonNullable<SlotSource>>();
  /** Drag-across-slots state (mobile: deposit 1 of the held stack per slot). */
  private paint: { down: boolean; committed: boolean; startEl: HTMLElement | null; seen: Set<HTMLElement> } =
    { down: false, committed: false, startEl: null, seen: new Set() };
  /** Set right after a paint drag so the trailing click doesn't also place the stack. */
  private suppressNextSlotClick = false;

  constructor(
    private readonly onSelect: (id: number | null) => void,
    private readonly onToggle?: (open: boolean) => void,
  ) {
    const hotbarRoot = document.querySelector<HTMLElement>('#inventory')!;
    const backpackGrid = document.querySelector<HTMLElement>('#backpack-grid')!;
    const backpackHotbar = document.querySelector<HTMLElement>('#backpack-hotbar')!;
    this.backpackPanel = document.querySelector<HTMLElement>('#backpack')!;

    slots.forEach((slot, index) => {
      const isHotbar = index < HOTBAR_SIZE;
      const element = this.createSlotElement(slot, index);
      this.elementsByIndex[index] = [element];
      if (isHotbar) {
        hotbarRoot.appendChild(element);
        // Hotbar is mirrored at the bottom of the backpack panel, like Minecraft.
        const mirror = this.createSlotElement(slot, index);
        backpackHotbar.appendChild(mirror);
        this.elementsByIndex[index].push(mirror);
      } else {
        backpackGrid.appendChild(element);
      }
    });

    this.setupCraftGrid();

    // Listen on the document, not the hotbar element: while the pointer is
    // locked during gameplay the wheel event's target stays wherever the
    // cursor was when it locked (the canvas), not the fixed hotbar overlay.
    document.addEventListener('wheel', this.onWheel, { passive: false });
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('pointerdown', this.onPaintDown);
    document.addEventListener('pointermove', this.onPaintMove);
    document.addEventListener('pointerup', this.onPaintUp);
    document.addEventListener('pointercancel', this.onPaintUp);
    this.select(0);
  }

  private setupCraftGrid() {
    const inputEls = Array.from(
      this.backpackPanel.querySelectorAll<HTMLButtonElement>('#backpack-panel .craft-slot'),
    );
    const outputEl = this.backpackPanel.querySelector<HTMLButtonElement>('#backpack-panel .craft-result');
    if (inputEls.length >= 4 && outputEl) this.bindCraftGrid(this.craftGrid, inputEls, outputEl);
  }

  /** Wire a crafting grid's DOM (inputs + result) into the shared held-item flow. */
  bindCraftGrid(grid: CraftingGrid, inputEls: HTMLElement[], outputEl: HTMLElement) {
    grid.bind(inputEls, outputEl);
    inputEls.forEach((el, i) => {
      this.slotSourceByEl.set(el, { kind: 'craft', grid, index: i });
      el.addEventListener('click', () => this.onSlotClick({ kind: 'craft', grid, index: i }));
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onSlotRightClick({ kind: 'craft', grid, index: i });
      });
    });
    outputEl.addEventListener('click', () => this.takeCraftResult(grid));
  }

  /**
   * Register extra DOM elements that mirror the stored hotbar/backpack slots
   * (used by the crafting-table GUI's inventory rows).
   */
  attachExtraSlots(elements: (HTMLElement | null)[]) {
    elements.forEach((el, index) => {
      if (!el || index >= TOTAL_SLOTS) return;
      renderSlot(el, slots[index]);
      this.slotSourceByEl.set(el as HTMLElement, { kind: 'stored', index });
      el.addEventListener('click', () => this.handleStoredClick(index));
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onSlotRightClick({ kind: 'stored', index });
      });
      (this.elementsByIndex[index] ??= []).push(el as HTMLButtonElement);
    });
  }

  /** Re-render every registered slot element + the 2x2 grid (WebGL-context warm-up / GUI open). */
  refreshAll() {
    for (let i = 0; i < this.elementsByIndex.length; i++) {
      for (const el of this.elementsByIndex[i] ?? []) renderSlot(el, slots[i]);
    }
    this.craftGrid.refresh();
  }

  /**
   * Merge a stack into the inventory. Public wrapper of tryAdd for external GUIs
   * and world pickups. Returns how many items did not fit (0 = all stored).
   */
  addItem(item: InventorySlot): number {
    return this.tryAdd(item);
  }

  /**
   * Remove the selected hotbar stack (or just one from it) so it can be thrown
   * into the world. Returns what was removed, or null if the slot was empty.
   */
  dropSelected(all: boolean): InventorySlot | null {
    const slot = slots[this.selectedIndex];
    if (slot.id === null) return null;
    const have = slot.count ?? 1;
    const take = all ? have : 1;
    const next = have - take;
    this.setSlot(this.selectedIndex, next > 0 ? { ...slot, count: next } : null);
    return { ...slot, count: take };
  }

  closeBackpack() {
    if (this.backpackOpen) this.toggleBackpack(false);
  }

  /** Open/close the backpack (on-screen Inventory button). */
  toggleInventory() {
    if (this.externalUiOpen) { this.externalUiCloser?.(); return; }
    this.toggleBackpack();
  }

  get isBackpackOpen() { return this.backpackOpen; }

  setExternalUiOpen(open: boolean, closer?: () => void) {
    this.externalUiOpen = open;
    this.externalUiCloser = open ? closer ?? null : null;
    if (open) {
      if (this.backpackOpen) this.toggleBackpack(false);
    } else {
      this.restoreHeld();
      this.clearHeldVisuals();
    }
  }

  private createSlotElement(slot: InventorySlot, index: number): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'inventory-slot';
    element.dataset.slot = String(index + 1);
    renderSlot(element, slot);
    element.addEventListener('click', () => this.handleStoredClick(index));
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onSlotRightClick({ kind: 'stored', index });
    });

    // Hover tooltip with the block's name (Grass, Dirt, ...).
    element.addEventListener('mousemove', (event) => {
      const current = slots[index];
      if (current.id !== null && !this.heldItem) {
        showTooltip(current.name, event.clientX, event.clientY);
      } else {
        hideTooltip();
      }
    });
    element.addEventListener('mouseleave', hideTooltip);
    this.slotSourceByEl.set(element, { kind: 'stored', index });

    return element;
  }

  // --- Slot access via a SlotSource -------------------------------------------

  private readSlot(src: NonNullable<SlotSource>): InventorySlot {
    return src.kind === 'stored' ? slots[src.index] : src.grid.get(src.index);
  }

  private writeSlot(src: NonNullable<SlotSource>, slot: InventorySlot | null) {
    if (src.kind === 'stored') this.setSlot(src.index, slot);
    else src.grid.set(src.index, slot);
  }

  /**
   * Place a block definition into a stored hotbar/backpack slot. Re-renders both
   * the main and mirrored elements for that slot.
   */
  setSlot(index: number, block: InventorySlot | null) {
    if (index < 0 || index >= TOTAL_SLOTS) return;
    slots[index] = normalizeSlot(block);
    for (const element of this.elementsByIndex[index] ?? []) {
      renderSlot(element, slots[index]);
    }
    if (index === this.selectedIndex) this.onSelect(slots[index].id);
  }

  /** Read-only view of a stored slot. */
  getSlot(index: number): InventorySlot {
    return slots[index];
  }

  /** Remove one item from the selected hotbar slot (called after placing a block). */
  consumeSelected() {
    const slot = slots[this.selectedIndex];
    if (slot.id === null) return;
    const next = (slot.count ?? 1) - 1;
    this.setSlot(this.selectedIndex, next > 0 ? { ...slot, count: next } : null);
  }

  /**
   * Merge a stack into the inventory (existing stacks first, then a free slot).
   * Returns the count that did not fit.
   */
  private tryAdd(item: InventorySlot): number {
    let left = item.count ?? 1;
    for (let i = 0; i < TOTAL_SLOTS && left > 0; i++) {
      const s = slots[i];
      if (s.id !== item.id) continue;
      const moved = Math.min(maxStackOf(s.id) - (s.count ?? 1), left);
      if (moved > 0) {
        this.setSlot(i, { ...s, count: (s.count ?? 1) + moved });
        left -= moved;
      }
    }
    for (let i = 0; i < TOTAL_SLOTS && left > 0; i++) {
      if (slots[i].id === null) {
        this.setSlot(i, { ...item, count: left });
        left = 0;
      }
    }
    return left; // > 0 -> no room, caller keeps the overflow
  }

  /** Snapshot of every slot + the selected hotbar index, for world save. */
  serialize(): { slots: InventorySlot[]; selectedIndex: number } {
    return {
      slots: slots.map((s) => ({ ...s })),
      selectedIndex: this.selectedIndex,
    };
  }

  /** Restore a snapshot from serialize() (used when a world is loaded). */
  load(data: { slots: InventorySlot[]; selectedIndex?: number }) {
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      slots[i] = normalizeSlot(data.slots[i] ?? null);
      for (const element of this.elementsByIndex[i] ?? []) {
        renderSlot(element, slots[i]);
      }
    }
    this.select(Math.min(Math.max(data.selectedIndex ?? 0, 0), HOTBAR_SIZE - 1));
  }

  /** Pick up a full stack from the creative palette (infinite supply). */
  pickUp(block: InventorySlot) {
    this.restoreHeld();
    this.clearHeldVisuals();
    this.heldItem = { ...block, count: block.count ?? maxStackOf(block.id) };
    this.heldFrom = null;
    this.spawnGhost();
    document.addEventListener('pointermove', this.onGhostMove);
    document.addEventListener('contextmenu', this.cancelHeld);
  }

  private pickUpFrom(src: NonNullable<SlotSource>, count?: number) {
    const slot = this.readSlot(src);
    if (slot.id === null) return;
    const total = slot.count ?? 1;
    const take = count ?? total;

    this.restoreHeld();
    this.clearHeldVisuals();
    this.heldItem = { ...slot, count: take };
    this.heldFrom = src;
    this.writeSlot(src, take >= total ? null : { ...slot, count: total - take });
    this.spawnGhost();
    document.addEventListener('pointermove', this.onGhostMove);
    document.addEventListener('contextmenu', this.cancelHeld);
  }

  private spawnGhost() {
    if (!this.heldItem) return;
    this.ghostElement?.remove();
    const ghost = document.createElement('div');
    ghost.className = 'inventory-ghost';
    const canvas = document.createElement('canvas');
    canvas.className = 'inventory-block';
    ghost.appendChild(canvas);
    document.body.appendChild(ghost);
    if (isBlock(this.heldItem.id)) renderBlockPreview(canvas, this.heldItem);
    else renderItemIcon(canvas, this.heldItem.sideTexture ?? '');
    this.ghostElement = ghost;
    this.updateGhostCount();
  }

  private updateGhostCount() {
    if (!this.ghostElement || !this.heldItem) return;
    let badge = this.ghostElement.querySelector<HTMLElement>('.slot-count');
    const count = this.heldItem.count ?? 1;
    if (count > 1) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'slot-count';
        this.ghostElement.appendChild(badge);
      }
      badge.textContent = String(count);
    } else {
      badge?.remove();
    }
  }

  private onGhostMove = (event: PointerEvent | MouseEvent) => {
    if (!this.ghostElement) return;
    this.ghostElement.style.left = `${event.clientX}px`;
    this.ghostElement.style.top = `${event.clientY}px`;
  };

  /** Puts a held stack back where it came from, merging if the slot filled back in. */
  private restoreHeld() {
    if (!this.heldFrom || !this.heldItem) return;
    const dest = this.readSlot(this.heldFrom);
    const held = this.heldItem;
    if (dest.id === null) {
      this.writeSlot(this.heldFrom, held);
    } else if (dest.id === held.id) {
      const moved = Math.min(maxStackOf(dest.id) - (dest.count ?? 1), held.count ?? 1);
      this.writeSlot(this.heldFrom, { ...dest, count: (dest.count ?? 1) + moved });
    }
    // A different block sitting there, or overflow, is dropped (creative-infinite world).
  }

  private cancelHeld = (event?: Event) => {
    event?.preventDefault();
    this.restoreHeld();
    this.clearHeldVisuals();
  };

  private clearHeldVisuals() {
    this.heldItem = null;
    this.heldFrom = null;
    this.ghostElement?.remove();
    this.ghostElement = null;
    document.removeEventListener('pointermove', this.onGhostMove);
    document.removeEventListener('contextmenu', this.cancelHeld);
  }

  // --- Click handling (shared by stored slots + craft grid) -----------------

  private handleStoredClick(index: number) {
    if (this.consumeClickSuppression()) return;
    const src: SlotSource = { kind: 'stored', index };
    if (this.heldItem) {
      this.placeHeld(src);
    } else if (slots[index].id !== null) {
      this.pickUpFrom(src);
    } else if (index < HOTBAR_SIZE) {
      this.select(index);
    }
  }

  private onSlotClick(src: NonNullable<SlotSource>) {
    if (this.consumeClickSuppression()) return;
    if (this.heldItem) this.placeHeld(src);
    else this.pickUpFrom(src);
  }

  private onSlotRightClick(src: NonNullable<SlotSource>) {
    if (this.heldItem) { this.depositOne(src); return; }
    const slot = this.readSlot(src);
    if (slot.id === null) return;
    this.pickUpFrom(src, Math.ceil((slot.count ?? 1) / 2));
  }

  /** Drop exactly one of the held stack into `src` (right-click / swipe deposit). */
  private depositOne(src: NonNullable<SlotSource>): boolean {
    if (!this.heldItem) return false;
    const held = this.heldItem;
    const slot = this.readSlot(src);
    if (slot.id === null) {
      this.writeSlot(src, { ...held, count: 1 });
    } else if (slot.id === held.id && (slot.count ?? 1) < maxStackOf(slot.id)) {
      this.writeSlot(src, { ...slot, count: (slot.count ?? 1) + 1 });
    } else {
      return false;
    }
    held.count = (held.count ?? 1) - 1;
    if ((held.count ?? 0) <= 0) this.clearHeldVisuals();
    else this.updateGhostCount();
    return true;
  }

  private consumeClickSuppression(): boolean {
    if (!this.suppressNextSlotClick) return false;
    this.suppressNextSlotClick = false;
    return true;
  }

  // --- Swipe-to-deposit (mobile) --------------------------------------------
  // With a stack on the cursor, dragging a finger across several slots drops one
  // item in each - fast filling of a crafting pattern. Touch only; the mouse
  // keeps click = place-stack, right-click = place-one.

  private slotElAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const slotEl = el?.closest<HTMLElement>('.inventory-slot, .craft-slot, .ct-slot');
    return slotEl && this.slotSourceByEl.has(slotEl) ? slotEl : null;
  }

  private onPaintDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' || !this.heldItem) return;
    const slotEl = this.slotElAt(event.clientX, event.clientY);
    if (!slotEl) return;
    this.paint = { down: true, committed: false, startEl: slotEl, seen: new Set() };
  };

  private onPaintMove = (event: PointerEvent) => {
    if (!this.paint.down || !this.heldItem) return;
    const slotEl = this.slotElAt(event.clientX, event.clientY);
    if (!slotEl) return;

    // First move onto a different slot commits the gesture: the start slot also
    // gets one, and every click that would follow this drag is swallowed.
    if (!this.paint.committed && slotEl !== this.paint.startEl) {
      this.paint.committed = true;
      const startSrc = this.paint.startEl && this.slotSourceByEl.get(this.paint.startEl);
      if (startSrc && this.depositOne(startSrc)) this.paint.seen.add(this.paint.startEl!);
    }
    if (!this.paint.committed || this.paint.seen.has(slotEl) || !this.heldItem) return;
    const src = this.slotSourceByEl.get(slotEl);
    if (src && this.depositOne(src)) this.paint.seen.add(slotEl);
  };

  private onPaintUp = () => {
    if (this.paint.committed) this.suppressNextSlotClick = true;
    this.paint = { down: false, committed: false, startEl: null, seen: new Set() };
  };

  private placeHeld(target: NonNullable<SlotSource>) {
    const held = this.heldItem!;
    const from = this.heldFrom;
    const tgt = this.readSlot(target);

    if (tgt.id === held.id && maxStackOf(tgt.id) > 1) {
      const moved = Math.min(maxStackOf(tgt.id) - (tgt.count ?? 1), held.count ?? 1);
      if (moved > 0) this.writeSlot(target, { ...tgt, count: (tgt.count ?? 1) + moved });
      held.count = (held.count ?? 1) - moved;
      if ((held.count ?? 0) <= 0) this.clearHeldVisuals();
      else this.updateGhostCount();
      return;
    }

    if (tgt.id === null) {
      this.writeSlot(target, held);
      this.clearHeldVisuals();
      return;
    }

    // Different block: swap. Displaced stack goes back to its source, or onto the
    // cursor when the held stack came from the (infinite) palette.
    const previous = { ...tgt };
    this.writeSlot(target, held);
    if (from && !sameSource(from, target)) {
      this.writeSlot(from, previous);
      this.clearHeldVisuals();
    } else if (!from) {
      this.heldItem = previous;
      this.heldFrom = null;
      this.spawnGhost();
    } else {
      this.clearHeldVisuals();
    }
  }

  /** Take the crafting result onto the cursor and consume one of each ingredient. */
  private takeCraftResult(grid: CraftingGrid) {
    const out = grid.output;
    if (out.id === null) return;

    if (this.heldItem) {
      if (this.heldItem.id !== out.id) return;
      if ((this.heldItem.count ?? 1) + (out.count ?? 1) > maxStackOf(out.id)) return;
      this.heldItem.count = (this.heldItem.count ?? 1) + (out.count ?? 1);
      this.updateGhostCount();
    } else {
      this.heldItem = { ...out };
      this.heldFrom = null;
      this.spawnGhost();
      document.addEventListener('pointermove', this.onGhostMove);
      document.addEventListener('contextmenu', this.cancelHeld);
    }
    grid.consumeCraft();
  }

  private select(index: number) {
    if (index < 0 || index >= HOTBAR_SIZE) return;
    const slot = slots[index];
    this.selectedIndex = index;
    this.elementsByIndex.forEach((elements, elementIndex) => {
      elements.forEach((element) => element.classList.toggle('selected', elementIndex === index));
    });
    this.onSelect(slot.id);
  }

  private toggleBackpack(forceOpen?: boolean) {
    this.backpackOpen = forceOpen ?? !this.backpackOpen;
    this.backpackPanel.hidden = !this.backpackOpen;
    if (!this.backpackOpen) {
      this.restoreHeld();
      this.clearHeldVisuals();
      this.craftGrid.returnAll((s) => this.tryAdd(s));
      hideTooltip();
    }
    const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
    if (this.backpackOpen) document.exitPointerLock();
    else canvas?.requestPointerLock();
    this.onToggle?.(this.backpackOpen);
  }

  private onWheel = (event: WheelEvent) => {
    // Don't hijack scrolling while the backpack/creative panel is open - let
    // the creative block list scroll normally instead.
    if (this.backpackOpen) return;
    event.preventDefault();
    const direction = event.deltaY > 0 ? 1 : -1;
    const next = (this.selectedIndex + direction + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.select(next);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    const digit = event.code.match(/^(?:Digit|Numpad)([1-9])$/)?.[1];
    if (digit) this.select(Number(digit) - 1);
    if ((event.code === 'KeyE' || event.code === 'Escape') && !event.repeat && this.externalUiOpen) {
      this.externalUiCloser?.();
      return;
    }
    if (event.code === 'KeyE' && !event.repeat) this.toggleBackpack();
    if (event.code === 'Escape' && !event.repeat && this.backpackOpen) this.toggleBackpack(false);
  };
}

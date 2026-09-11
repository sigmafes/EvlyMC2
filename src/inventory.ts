import { renderBlockPreview, renderItemIcon } from './block-preview';
import { isBlock, maxStackOf } from './item';
import { maxDurability } from './tools';
import { showTooltip, hideTooltip } from './tooltip';
import { showHeldItemName } from './held-item-name';
import { CraftingGrid } from './crafting-grid';
import { lockPointer, unlockPointerForGui } from './is-touch';

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
  /** Uses spent on a tool (MC's "damage value"): 0 is pristine, tier.uses breaks it. */
  damage?: number;
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

  // Durability bar, only once a tool has actually been used.
  const uses = maxDurability(slot.id);
  const damage = slot.damage ?? 0;
  if (uses > 0 && damage > 0) {
    const left = Math.max(0, 1 - damage / uses);
    const bar = document.createElement('span');
    bar.className = 'slot-durability';
    const fill = document.createElement('span');
    fill.style.width = `${left * 100}%`;
    // Green -> red as it wears out, same read as Minecraft's bar.
    fill.style.background = `hsl(${Math.round(left * 120)}, 90%, 45%)`;
    bar.appendChild(fill);
    element.appendChild(bar);
  }
}

/** Where a picked-up stack came from (so it can be put back / swapped). */
/** A single slot owned by an external GUI (furnace), backed by live state. */
export type ExtSlot = {
  id: string;                                  // unique, for sameSource
  read: () => InventorySlot;
  write: (slot: InventorySlot | null) => void;
  takeOnly?: boolean;                          // e.g. a furnace output slot
};

type SlotSource =
  | { kind: 'stored'; index: number }
  | { kind: 'craft'; grid: CraftingGrid; index: number }
  | { kind: 'ext'; ext: ExtSlot }
  | null;

function sameSource(a: SlotSource, b: SlotSource): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'ext') return a.ext.id === (b as { ext: ExtSlot }).ext.id;
  if (a.index !== (b as { index: number }).index) return false;
  return a.kind === 'stored' || a.grid === (b as { grid: CraftingGrid }).grid;
}

const slots: InventorySlot[] = Array.from({ length: TOTAL_SLOTS }, createEmptySlot);

export class Inventory {
  /** Elements sharing the same slot index (hotbar slots are mirrored in the backpack view). */
  private readonly elementsByIndex: HTMLButtonElement[][] = [];
  private readonly backpackPanel: HTMLElement;
  private selectedIndex = 0;
  private backpackOpen = false;
  /** Slot+item last announced over the HUD, so a count change doesn't re-flash it. */
  private lastHeldKey: string | null = null;

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

  /** Last seen pointer position, so a freshly-spawned cursor ghost appears under
   *  the finger instead of at the top-left corner (touch has no mousemove). */
  private pointerX = 0;
  private pointerY = 0;

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
      const element = this.createSlotElement(slot, index, isHotbar);
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
    document.addEventListener('pointerdown', this.trackPointer, true);
    document.addEventListener('pointermove', this.trackPointer, true);
    document.addEventListener('pointerdown', this.onPaintDown);
    document.addEventListener('pointermove', this.onPaintMove);
    document.addEventListener('pointerup', this.onPaintUp);
    document.addEventListener('pointercancel', this.onPaintUp);
    // Right-click-drag paint (see onPaintDown) can end over a gap between slots,
    // which has no per-slot contextmenu listener to swallow the browser's menu.
    document.addEventListener('contextmenu', (event) => { if (this.paint.down) event.preventDefault(); });
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
        if (this.consumeClickSuppression()) return;
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
        if (this.consumeClickSuppression()) return;
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

  private createSlotElement(slot: InventorySlot, index: number, hudHotbar = false): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'inventory-slot';
    element.dataset.slot = String(index + 1);
    renderSlot(element, slot);
    if (hudHotbar) {
      // The bottom hotbar bar is a selector only - a tap just changes the
      // active slot, it never picks the block up (that is the backpack's job).
      element.addEventListener('click', () => this.select(index));
    } else {
      element.addEventListener('click', () => this.handleStoredClick(index));
      element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.consumeClickSuppression()) return;
        this.onSlotRightClick({ kind: 'stored', index });
      });
    }

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
    if (src.kind === 'stored') return slots[src.index];
    if (src.kind === 'craft') return src.grid.get(src.index);
    return src.ext.read();
  }

  private writeSlot(src: NonNullable<SlotSource>, slot: InventorySlot | null) {
    if (src.kind === 'stored') this.setSlot(src.index, slot);
    else if (src.kind === 'craft') src.grid.set(src.index, slot);
    else src.ext.write(slot);
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
    if (index === this.selectedIndex) {
      this.announceHeld(slots[index]);
      this.onSelect(slots[index].id);
    }
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
   * Spend `amount` uses on the held tool. Returns true if that broke it (the
   * slot is emptied), so the caller can play the snap. No-op for anything
   * that isn't a tool.
   */
  damageSelected(amount = 1): boolean {
    const slot = slots[this.selectedIndex];
    const uses = maxDurability(slot.id);
    if (uses <= 0) return false;
    const damage = (slot.damage ?? 0) + amount;
    if (damage >= uses) {
      this.setSlot(this.selectedIndex, null);
      return true;
    }
    this.setSlot(this.selectedIndex, { ...slot, damage });
    return false;
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

  private trackPointer = (e: PointerEvent) => {
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
  };

  private spawnGhost() {
    if (!this.heldItem) return;
    this.ghostElement?.remove();
    const ghost = document.createElement('div');
    ghost.className = 'inventory-ghost';
    ghost.style.left = `${this.pointerX}px`;
    ghost.style.top = `${this.pointerY}px`;
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
    if (src.kind === 'ext' && src.ext.takeOnly) return false;
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

  // --- Swipe/drag-to-deposit -------------------------------------------------
  // With a stack on the cursor, dragging across several slots drops one item in
  // each - fast filling of a crafting pattern. Touch: any drag. Mouse: holding
  // the RIGHT button and dragging (left-click stays place-stack, a plain
  // right-click without moving stays place-one via the per-slot contextmenu
  // handlers - see the consumeClickSuppression() calls there).
  //
  // Touch gets one extra trick mouse doesn't: pressing on a full slot with
  // NOTHING held yet also arms this gesture (mouse still requires a stack
  // already picked up, unchanged - a bare right-drag on a full slot stays a
  // no-op, matching its existing half-stack-via-contextmenu behaviour). If
  // that first press turns into a drag, onPaintMove grabs the whole stack
  // right then so the ghost starts following the finger immediately, instead
  // of the pickup only happening once the finger lifts (a synthesized click
  // firing after the drag already moved the finger away from the slot reads
  // as the icon "teleporting" to wherever it lifted, instead of a natural
  // press-and-drag-out-of-the-slot gesture).

  private slotElAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const slotEl = el?.closest<HTMLElement>('.inventory-slot, .craft-slot, .ct-slot, .furnace-slot');
    return slotEl && this.slotSourceByEl.has(slotEl) ? slotEl : null;
  }

  private onPaintDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 2) return;
    const slotEl = this.slotElAt(event.clientX, event.clientY);
    if (!slotEl) return;
    if (!this.heldItem) {
      if (event.pointerType === 'mouse') return; // mouse: unchanged, needs a stack already held
      const src = this.slotSourceByEl.get(slotEl)!;
      if (this.readSlot(src).id === null) return; // touch, but nothing here to grab
    }
    this.paint = { down: true, committed: false, startEl: slotEl, seen: new Set() };
  };

  private onPaintMove = (event: PointerEvent) => {
    if (!this.paint.down) return;
    const slotEl = this.slotElAt(event.clientX, event.clientY);
    if (!slotEl) return;

    // First move onto a different slot commits the gesture: the start slot
    // either gets one deposited back (already had a stack held) or gets
    // eagerly picked up whole (touch grab-and-drag straight out of it, see
    // above) - either way every click that would follow this drag is swallowed.
    if (!this.paint.committed && slotEl !== this.paint.startEl) {
      this.paint.committed = true;
      const startSrc = this.paint.startEl && this.slotSourceByEl.get(this.paint.startEl);
      if (startSrc) {
        if (!this.heldItem) this.pickUpFrom(startSrc);
        else if (this.depositOne(startSrc)) this.paint.seen.add(this.paint.startEl!);
      }
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
    this.announceHeld(slot);
    this.onSelect(slot.id);
  }

  /**
   * Flash the held item's name over the HUD, MC-style. Skipped while the
   * backpack is open (its own tooltips cover that), on the very first
   * selection at world load, and when only the stack COUNT changed - mining
   * or placing shouldn't re-announce what you're already holding.
   */
  private announceHeld(slot: InventorySlot) {
    const key = `${this.selectedIndex}:${slot.id ?? ''}`;
    const first = this.lastHeldKey === null;
    const changed = key !== this.lastHeldKey;
    this.lastHeldKey = key;
    if (first || !changed || this.backpackOpen) return;
    showHeldItemName(slot.id === null ? null : slot.name);
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
    if (this.backpackOpen) unlockPointerForGui();
    else lockPointer(canvas);
    this.onToggle?.(this.backpackOpen);
  }

  /** Wire a single external-GUI slot (furnace input/fuel/output) into the cursor flow. */
  bindExternalSlot(el: HTMLElement, ext: ExtSlot) {
    this.slotSourceByEl.set(el, { kind: 'ext', ext });
    el.addEventListener('click', () => {
      if (this.consumeClickSuppression()) return;
      if (ext.takeOnly) { this.takeFromExternal(ext); return; }
      if (this.heldItem) this.placeHeld({ kind: 'ext', ext });
      else this.pickUpFrom({ kind: 'ext', ext });
    });
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.consumeClickSuppression()) return;
      if (ext.takeOnly) { this.takeFromExternal(ext); return; }
      this.onSlotRightClick({ kind: 'ext', ext });
    });
  }

  /** Output-style slot: whole stack onto the cursor, or merged if it fits. */
  private takeFromExternal(ext: ExtSlot) {
    const slot = ext.read();
    if (slot.id == null) return;
    if (this.heldItem) {
      if (this.heldItem.id !== slot.id) return;
      if ((this.heldItem.count ?? 1) + (slot.count ?? 1) > maxStackOf(slot.id)) return;
      this.heldItem.count = (this.heldItem.count ?? 1) + (slot.count ?? 1);
      ext.write(null);
      this.updateGhostCount();
      return;
    }
    this.restoreHeld();
    this.clearHeldVisuals();
    this.heldItem = { ...slot };
    this.heldFrom = { kind: 'ext', ext }; // closing the GUI puts it back here
    ext.write(null);
    this.spawnGhost();
    document.addEventListener('pointermove', this.onGhostMove);
    document.addEventListener('contextmenu', this.cancelHeld);
  }

  private onWheel = (event: WheelEvent) => {
    // Don't hijack scrolling while the backpack/creative panel is open - let
    // the creative block list scroll normally instead.
    if (this.backpackOpen) return;
    // Only swap hotbar slots while actually playing. This listener is on
    // `document` with passive:false, so preventing every wheel event also ate
    // the scroll of any menu layered over the game (the pause menu's Options
    // list, which is taller than the screen), leaving its lower rows
    // unreachable. Gameplay always holds the pointer lock, so that's the test.
    if (!document.pointerLockElement) return;
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

import { lockPointer } from './is-touch';
import { createEmptySlot, renderSlot, type Inventory, type InventorySlot } from './inventory';
import { makeStack } from './item-stack';
import { emptyFurnace, type FurnaceState, type SlotRef } from './block-data';
import { COOK_SECONDS } from './smelting';
import type { World } from './world';

type Pos = { x: number; y: number; z: number };
type SlotKey = 'input' | 'fuel' | 'output';

const refToSlot = (r: SlotRef): InventorySlot => (r ? makeStack(r.id, r.count) : createEmptySlot());
const slotToRef = (s: InventorySlot | null): SlotRef =>
  s && s.id != null && (s.count ?? 0) > 0 ? { id: s.id, count: s.count ?? 1 } : null;

/**
 * The furnace screen (furnace_gui.png): input / fuel / output slots wired into
 * the shared cursor, a mirror of the player's 36 slots, and the flame + arrow
 * gauges driven by the live FurnaceState. The furnace keeps smelting while this
 * is open (it does not pause the game).
 */
export class FurnaceUI {
  private readonly root = document.querySelector<HTMLElement>('#furnace')!;
  private readonly inputEl = this.root.querySelector<HTMLElement>('#furnace-input')!;
  private readonly fuelEl = this.root.querySelector<HTMLElement>('#furnace-fuel')!;
  private readonly outputEl = this.root.querySelector<HTMLElement>('#furnace-output')!;
  private readonly flameEl = this.root.querySelector<HTMLElement>('#furnace-flame')!;
  private readonly arrowEl = this.root.querySelector<HTMLElement>('#furnace-arrow')!;

  private isOpen = false;
  private pos: Pos = { x: 0, y: 0, z: 0 };
  private lastSig: Record<SlotKey, string> = { input: '', fuel: '', output: '' };

  constructor(
    private readonly inventory: Inventory,
    private readonly world: World,
    private readonly onToggle: (open: boolean) => void,
  ) {
    const panel = this.root.querySelector<HTMLElement>('#furnace-panel')!;
    const bpRoot = panel.querySelector<HTMLElement>('#furnace-backpack')!;
    const hbRoot = panel.querySelector<HTMLElement>('#furnace-hotbar')!;
    const slotEls: (HTMLElement | null)[] = new Array(36).fill(null);
    for (let i = 9; i < 36; i++) slotEls[i] = this.makeSlot(bpRoot);
    for (let i = 0; i < 9; i++) slotEls[i] = this.makeSlot(hbRoot);
    this.inventory.attachExtraSlots(slotEls);

    this.inventory.bindExternalSlot(this.inputEl, {
      id: 'furnace:input',
      read: () => refToSlot(this.state()?.input ?? null),
      write: (s) => this.mutate((st) => { st.input = slotToRef(s); }),
    });
    this.inventory.bindExternalSlot(this.fuelEl, {
      id: 'furnace:fuel',
      read: () => refToSlot(this.state()?.fuel ?? null),
      write: (s) => this.mutate((st) => { st.fuel = slotToRef(s); }),
    });
    this.inventory.bindExternalSlot(this.outputEl, {
      id: 'furnace:output',
      takeOnly: true,
      read: () => refToSlot(this.state()?.output ?? null),
      write: (s) => this.mutate((st) => { st.output = slotToRef(s); }),
    });
  }

  open(pos: Pos): void {
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
    this.isOpen = true;
    this.root.hidden = false;
    this.lastSig = { input: '', fuel: '', output: '' };
    this.inventory.refreshAll();
    this.refresh();
    this.inventory.setExternalUiOpen(true, () => this.close());
    document.exitPointerLock();
    this.onToggle(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.inventory.setExternalUiOpen(false); // puts any held stack back first
    this.root.hidden = true;
    this.onToggle(false);
    lockPointer(document.querySelector<HTMLCanvasElement>('#game-canvas'));
  }

  /** Per-frame while open: keep the slots and gauges in step with smelting. */
  update(): void {
    if (this.isOpen) this.refresh();
  }

  private makeSlot(parent: HTMLElement): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'inventory-slot furnace-slot';
    parent.appendChild(el);
    return el;
  }

  private state(): FurnaceState | undefined {
    return this.world.getFurnaceState(this.pos.x, this.pos.y, this.pos.z);
  }

  private mutate(fn: (st: FurnaceState) => void): void {
    const st = this.state() ?? emptyFurnace();
    fn(st);
    this.world.setFurnaceState(this.pos.x, this.pos.y, this.pos.z, st);
    this.refresh();
  }

  private refresh(): void {
    const st = this.state();
    this.paintSlot('input', this.inputEl, st?.input ?? null);
    this.paintSlot('fuel', this.fuelEl, st?.fuel ?? null);
    this.paintSlot('output', this.outputEl, st?.output ?? null);

    const cook = st ? Math.min(1, Math.max(0, st.cookTime / COOK_SECONDS)) : 0;
    const lit = st && st.litDuration > 0 ? Math.min(1, Math.max(0, st.litTime / st.litDuration)) : 0;
    this.flameEl.style.clipPath = `inset(${(1 - lit) * 100}% 0 0 0)`;
    this.arrowEl.style.clipPath = `inset(0 ${(1 - cook) * 100}% 0 0)`;
  }

  /** Re-render a furnace slot only when its stack actually changed (renderSlot
   *  does an offscreen WebGL draw for blocks — too costly every frame). */
  private paintSlot(key: SlotKey, el: HTMLElement, ref: SlotRef): void {
    const sig = ref ? `${ref.id}:${ref.count}` : '';
    if (this.lastSig[key] === sig) return;
    this.lastSig[key] = sig;
    renderSlot(el, refToSlot(ref));
  }
}

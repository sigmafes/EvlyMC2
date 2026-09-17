import { lockPointer, unlockPointerForGui } from './is-touch';
import { createEmptySlot, renderSlot, type Inventory, type InventorySlot } from './inventory';
import { makeStack } from './item-stack';
import { emptyChest, CHEST_SLOT_COUNT, type ChestState, type SlotRef } from './block-data';
import type { World } from './world';
import type { SoundManager } from './sound-manager';

type Pos = { x: number; y: number; z: number };

const refToSlot = (r: SlotRef): InventorySlot => (r ? makeStack(r.id, r.count) : createEmptySlot());
const slotToRef = (s: InventorySlot | null): SlotRef =>
  s && s.id != null && (s.count ?? 0) > 0 ? { id: s.id, count: s.count ?? 1 } : null;

/**
 * The chest screen (chest_gui.png): 27 generic slots (no named/special ones,
 * unlike the furnace) wired into the shared cursor, plus a mirror of the
 * player's 36 slots - same structure as FurnaceUI, just simpler since there's
 * no cook/burn gauge to animate.
 */
export class ChestUI {
  private readonly root = document.querySelector<HTMLElement>('#chest')!;
  private readonly slotEls: HTMLElement[];

  private isOpen = false;
  private pos: Pos = { x: 0, y: 0, z: 0 };
  /** One entry per chest slot, `null` = "unknown, force a repaint" - same trick FurnaceUI's lastSig uses. */
  private lastSig: (string | null)[] = new Array(CHEST_SLOT_COUNT).fill(null);

  constructor(
    private readonly inventory: Inventory,
    private readonly world: World,
    private readonly onToggle: (open: boolean) => void,
    /** Drives the in-world lid animation (ChestRenderer) - kept separate from `world` since the renderer isn't part of World's own state. */
    private readonly setLidOpen: (x: number, y: number, z: number, open: boolean) => void,
    private readonly soundManager: SoundManager,
  ) {
    const panel = this.root.querySelector<HTMLElement>('#chest-panel')!;
    const slotsRoot = panel.querySelector<HTMLElement>('#chest-slots')!;
    this.slotEls = Array.from({ length: CHEST_SLOT_COUNT }, () => this.makeSlot(slotsRoot));

    const bpRoot = panel.querySelector<HTMLElement>('#chest-backpack')!;
    const hbRoot = panel.querySelector<HTMLElement>('#chest-hotbar')!;
    const slotElsIdx: (HTMLElement | null)[] = new Array(36).fill(null);
    for (let i = 9; i < 36; i++) slotElsIdx[i] = this.makeSlot(bpRoot);
    for (let i = 0; i < 9; i++) slotElsIdx[i] = this.makeSlot(hbRoot);
    this.inventory.attachExtraSlots(slotElsIdx);

    this.slotEls.forEach((el, i) => {
      this.inventory.bindExternalSlot(el, {
        id: `chest:${i}`,
        read: () => refToSlot(this.state()?.items[i] ?? null),
        write: (s) => this.mutate((st) => { st.items[i] = slotToRef(s); }),
      });
    });
  }

  open(pos: Pos): void {
    this.pos = { x: pos.x, y: pos.y, z: pos.z };
    this.isOpen = true;
    this.root.hidden = false;
    this.lastSig.fill(null);
    this.inventory.refreshAll();
    this.refresh();
    this.inventory.setExternalUiOpen(true, () => this.close());
    unlockPointerForGui();
    this.setLidOpen(this.pos.x, this.pos.y, this.pos.z, true);
    // Only one variant (Chest_open.ogg) - playSingleSound, not the
    // auto-numbered playSound() the 3-variant close sound below uses.
    this.soundManager.playSingleSound('blocks/Chest_open', 0.5);
    this.onToggle(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.inventory.setExternalUiOpen(false); // puts any held stack back first
    this.root.hidden = true;
    this.onToggle(false);
    this.setLidOpen(this.pos.x, this.pos.y, this.pos.z, false);
    this.soundManager.playSound('chest_close', 0.5);
    lockPointer(document.querySelector<HTMLCanvasElement>('#game-canvas'));
    this.lastSig.fill(null);
  }

  private makeSlot(parent: HTMLElement): HTMLElement {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'inventory-slot chest-slot';
    parent.appendChild(el);
    return el;
  }

  private state(): ChestState | undefined {
    return this.world.getChestState(this.pos.x, this.pos.y, this.pos.z);
  }

  private mutate(fn: (st: ChestState) => void): void {
    const st = this.state() ?? emptyChest();
    fn(st);
    this.world.setChestState(this.pos.x, this.pos.y, this.pos.z, st);
    this.refresh();
  }

  private refresh(): void {
    const st = this.state();
    for (let i = 0; i < CHEST_SLOT_COUNT; i++) this.paintSlot(i, st?.items[i] ?? null);
  }

  private paintSlot(i: number, ref: SlotRef): void {
    const sig = ref ? `${ref.id}:${ref.count}` : '';
    if (this.lastSig[i] === sig) return;
    this.lastSig[i] = sig;
    renderSlot(this.slotEls[i], refToSlot(ref));
  }
}

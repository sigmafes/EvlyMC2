/**
 * On-screen touch controls for phones/tablets (mirrors the Minecraft LCE Android
 * layout): a movement d-pad + jump/sneak on the right, three square HUD buttons
 * in the top corners, and a full-screen gesture layer for looking around,
 * tap-to-place and hold-to-break.
 */

import { isTouchDevice } from './is-touch';

export type TouchControlsCallbacks = {
  /** Analog stick from the d-pad: x = strafe (+right), z = forward(-1)/back(+1). */
  onMoveAxis: (x: number, z: number) => void;
  onJump: (held: boolean) => void;
  onSneak: (on: boolean) => void;
  /** Double-tap the forward button. */
  onSprint: (on: boolean) => void;
  /** Drag on the world: pixel deltas since the last move. */
  onLook: (dx: number, dy: number) => void;
  /** Quick tap on the world: place / use the held item. */
  onTapPlace: () => void;
  /** Finger held still on the world: start / stop breaking. */
  onBreakStart: () => void;
  onBreakEnd: () => void;
  onInventory: () => void;
  onThirdPerson: () => void;
  onChat: () => void;
  onPause: () => void;
};

const HOLD_MS = 180;    // finger still this long on the world -> start breaking
const DOUBLE_TAP_MS = 300; // second forward press within this window -> sprint
const MOVE_TOL = 12;    // px of drift still counted as "held", not a drag

export class TouchControls {
  /** Coarse pointer (finger) as the primary input. */
  static isTouchDevice(): boolean {
    return isTouchDevice();
  }

  private readonly root: HTMLElement;
  private readonly gameplay: HTMLElement;
  private readonly lookLayer: HTMLElement;
  private readonly dirs = new Set<string>();
  private sneakOn = false;
  private sneakButton: HTMLButtonElement | null = null;

  // World gesture state (one finger at a time on the look layer).
  private lookPointer: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private holdTimer = 0;
  private breaking = false;
  private lastForwardPress = 0;

  /** Sync the on-screen sneak button's pressed-visual without re-firing onSneak (used when sprint cancels sneak programmatically). */
  setSneakVisual(on: boolean) {
    this.sneakOn = on;
    this.sneakButton?.classList.toggle('pressed', on);
  }

  constructor(private readonly cb: TouchControlsCallbacks) {
    document.body.classList.add('touch');

    const shell = document.querySelector('#game-shell') ?? document.body;

    // The look layer is a separate root: it must sit BELOW the hotbar (so hotbar
    // taps work) while the buttons sit ABOVE the inventory panel. One container
    // can't be on both sides of that, so they're split.
    this.lookLayer = document.createElement('div');
    this.lookLayer.id = 'touch-look';
    shell.appendChild(this.lookLayer);

    this.root = document.createElement('div');
    this.root.id = 'touch-ui';
    this.root.innerHTML = [
      '<div id="touch-hud-left">',
      '  <button class="touch-btn" data-act="inv" aria-label="Inventory">&#9638;</button>',
      '  <button class="touch-btn" data-act="pov" aria-label="Camera">&#9673;</button>',
      '  <button class="touch-btn" data-act="chat" aria-label="Chat">&#128172;</button>',
      '</div>',
      '<div id="touch-hud-right">',
      '  <button class="touch-btn" data-act="pause" aria-label="Pause">&#10074;&#10074;</button>',
      '</div>',
      '<div id="touch-gameplay">',
      '  <div id="touch-dpad">',
      '    <button class="touch-btn dpad-up"    data-dir="up"    aria-label="Forward">&#9650;</button>',
      '    <button class="touch-btn dpad-left"  data-dir="left"  aria-label="Left">&#9664;</button>',
      '    <button class="touch-btn dpad-right" data-dir="right" aria-label="Right">&#9654;</button>',
      '    <button class="touch-btn dpad-down"  data-dir="down"  aria-label="Back">&#9660;</button>',
      '  </div>',
      '  <div id="touch-actions">',
      '    <button class="touch-btn tc-jump"  data-act="jump"  aria-label="Jump">&#10548;</button>',
      '    <button class="touch-btn tc-sneak" data-act="sneak" aria-label="Sneak">&#9207;</button>',
      '  </div>',
      '</div>',
    ].join('\n');
    shell.appendChild(this.root);
    this.gameplay = this.root.querySelector<HTMLElement>('#touch-gameplay')!;

    this.wireHudButtons();
    this.wireDpad();
    this.wireActions();
    this.wireLookLayer();

    // Kill the browser's own long-press context menu over the game surface.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.lookLayer.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Hide the movement/look controls while a full-screen menu is open. */
  setGameplayVisible(visible: boolean): void {
    this.gameplay.hidden = !visible;
    this.lookLayer.hidden = !visible;
    if (!visible) {
      this.dirs.clear();
      this.cb.onMoveAxis(0, 0);
      this.cb.onJump(false);
      if (this.breaking) { this.breaking = false; this.cb.onBreakEnd(); }
      this.lookPointer = null;
      window.clearTimeout(this.holdTimer);
    }
  }

  private wireHudButtons(): void {
    const map: Record<string, () => void> = {
      inv: this.cb.onInventory,
      pov: this.cb.onThirdPerson,
      chat: this.cb.onChat,
      pause: this.cb.onPause,
    };
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('#touch-hud-left .touch-btn, #touch-hud-right .touch-btn')) {
      const act = btn.dataset.act!;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        map[act]?.();
      });
    }
  }

  private wireDpad(): void {
    const recompute = () => {
      const x = (this.dirs.has('right') ? 1 : 0) - (this.dirs.has('left') ? 1 : 0);
      const z = (this.dirs.has('down') ? 1 : 0) - (this.dirs.has('up') ? 1 : 0);
      this.cb.onMoveAxis(x, z);
    };
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('#touch-dpad .touch-btn')) {
      const dir = btn.dataset.dir!;
      const press = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        btn.setPointerCapture(e.pointerId);
        btn.classList.add('pressed');
        this.dirs.add(dir);
        if (dir === 'up') {
          const now = performance.now();
          if (now - this.lastForwardPress < DOUBLE_TAP_MS) this.cb.onSprint(true);
          this.lastForwardPress = now;
        }
        recompute();
      };
      const release = (e: PointerEvent) => {
        e.preventDefault();
        btn.classList.remove('pressed');
        this.dirs.delete(dir);
        recompute();
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
    }
  }

  private wireActions(): void {
    const jump = this.root.querySelector<HTMLButtonElement>('.tc-jump')!;
    const jumpDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      jump.setPointerCapture(e.pointerId);
      jump.classList.add('pressed');
      this.cb.onJump(true);
    };
    const jumpUp = (e: PointerEvent) => {
      e.preventDefault();
      jump.classList.remove('pressed');
      this.cb.onJump(false);
    };
    jump.addEventListener('pointerdown', jumpDown);
    jump.addEventListener('pointerup', jumpUp);
    jump.addEventListener('pointercancel', jumpUp);
    jump.addEventListener('pointerleave', jumpUp);

    const sneak = this.root.querySelector<HTMLButtonElement>('.tc-sneak')!;
    this.sneakButton = sneak;
    sneak.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.sneakOn = !this.sneakOn;
      sneak.classList.toggle('pressed', this.sneakOn);
      this.cb.onSneak(this.sneakOn);
    });
  }

  private wireLookLayer(): void {
    const layer = this.lookLayer;

    layer.addEventListener('pointerdown', (e) => {
      if (this.lookPointer !== null) return;
      e.preventDefault();
      this.lookPointer = e.pointerId;
      layer.setPointerCapture(e.pointerId);
      this.lastX = this.startX = e.clientX;
      this.lastY = this.startY = e.clientY;
      this.startTime = performance.now();
      this.breaking = false;
      window.clearTimeout(this.holdTimer);
      this.holdTimer = window.setTimeout(() => {
        this.breaking = true;
        this.cb.onBreakStart();
      }, HOLD_MS);
    });

    layer.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      e.preventDefault();
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;

      const drift = Math.hypot(e.clientX - this.startX, e.clientY - this.startY);
      // A real drag before the hold fires cancels the break intent.
      if (!this.breaking && drift > MOVE_TOL) window.clearTimeout(this.holdTimer);
      // Always allow looking around, including while breaking.
      if (this.breaking || drift > MOVE_TOL) this.cb.onLook(dx, dy);
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.lookPointer) return;
      e.preventDefault();
      window.clearTimeout(this.holdTimer);
      this.lookPointer = null;
      const drift = Math.hypot(e.clientX - this.startX, e.clientY - this.startY);
      const dt = performance.now() - this.startTime;
      if (this.breaking) {
        this.breaking = false;
        this.cb.onBreakEnd();
      } else if (drift <= MOVE_TOL && dt < HOLD_MS) {
        this.cb.onTapPlace();
      }
    };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
  }
}

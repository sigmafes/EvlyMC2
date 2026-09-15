/**
 * Browsers never let JS warp the real OS cursor (security), so releasing
 * pointer lock always leaves it wherever it physically was when the lock
 * started - anywhere on screen, not necessarily the centre a freshly opened
 * GUI might expect. This draws a small cursor arrow we fully control
 * instead, positioned at the real cursor's actual (frozen) screen position
 * the instant a GUI opens, hidden again once pointer lock (first-person
 * aiming) resumes.
 *
 * Per the Pointer Lock spec, `mousemove` events keep firing while locked -
 * only `movementX/Y` (the look deltas) are meaningful then, but
 * `clientX/clientY` stay pinned at wherever the real cursor was the instant
 * lock engaged, for as long as it stays locked. Tracking those coordinates
 * on EVERY mousemove (not just while this cursor is active) means `show()`
 * always has the real cursor's true current position on hand, instead of
 * guessing screen centre - a real click always lands exactly where this
 * drawn cursor appears to be, never off by whatever offset the real cursor
 * happened to freeze at.
 */
export class CustomCursor {
  private readonly el: HTMLElement;
  private active = false;
  private lastClientX = window.innerWidth / 2;
  private lastClientY = window.innerHeight / 2;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'custom-cursor';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    document.addEventListener('mousemove', (e) => {
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
      if (!this.active) return;
      this.el.style.left = `${e.clientX}px`;
      this.el.style.top = `${e.clientY}px`;
    });
  }

  /** Show it at the real cursor's actual position (call right after a GUI takes over the mouse). */
  show(): void {
    this.active = true;
    this.el.style.left = `${this.lastClientX}px`;
    this.el.style.top = `${this.lastClientY}px`;
    this.el.hidden = false;
    // Hide the real OS cursor everywhere so it doesn't show up twice (once at
    // its real position, once as this fake one drawn at that same spot).
    document.body.classList.add('custom-cursor-active');
  }

  hide(): void {
    this.active = false;
    this.el.hidden = true;
    document.body.classList.remove('custom-cursor-active');
  }
}

// Lazy, not an eager module-scope instance: the old `export const customCursor
// = new CustomCursor()` ran document.createElement() the instant this module
// was ever imported, anywhere - including transitively through mob-ai.ts ->
// arrow-projectiles.ts -> item-stack.ts -> inventory.ts -> is-touch.ts, none
// of which need a cursor element, in world-server's reuse of the mob AI
// (Fase 5+ of the multiplayer migration) where `document` doesn't exist at
// all. Deferring construction to first actual use means importing this file
// is now free of side effects; lockPointer()/unlockPointerForGui() (the only
// callers) are never invoked from any server-reachable code path, so the
// real CustomCursor is simply never constructed there.
let instance: CustomCursor | null = null;
export function getCustomCursor(): CustomCursor {
  if (!instance) instance = new CustomCursor();
  return instance;
}

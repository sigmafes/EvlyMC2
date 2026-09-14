/**
 * Browsers never let JS warp the real OS cursor (security), so releasing
 * pointer lock always leaves it wherever it physically was when the lock
 * started - anywhere on screen, not the centre a freshly opened GUI expects.
 * This draws a small cursor arrow we fully control instead: snapped to the
 * screen centre the instant a GUI opens, hidden again once pointer lock
 * (first-person aiming) resumes.
 */
export class CustomCursor {
  private readonly el: HTMLElement;
  private active = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'custom-cursor';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    document.addEventListener('mousemove', (e) => {
      if (!this.active) return;
      this.el.style.left = `${e.clientX}px`;
      this.el.style.top = `${e.clientY}px`;
    });
  }

  /** Show it centred on screen (call right after a GUI takes over the mouse). */
  show(): void {
    this.active = true;
    this.el.style.left = '50%';
    this.el.style.top = '50%';
    this.el.hidden = false;
    // Hide the real OS cursor everywhere so it doesn't show up twice (once at
    // its real, possibly off-centre position, once as this fake one).
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

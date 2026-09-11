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

export const customCursor = new CustomCursor();

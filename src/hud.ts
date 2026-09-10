import fullHeart from '../gui/heart_full.png';
import halfHeart from '../gui/heart_half.png';
import bubbleFull from '../gui/bubble.png';
import bubblePop from '../gui/bubble_pop.png';
import bubbleEmpty from '../gui/bubble_empty.png';

const MAX_HEARTS = 10; // 20 health points, 2 per heart
const MAX_BUBBLES = 10; // 300 air ticks, 30 per bubble
const POP_MS = 220;

/**
 * In-game HUD stats above the hotbar: air bubbles (only while submerged), the
 * heart row, and the XP bar.
 */
export class Hud {
  private readonly hearts: HTMLElement[] = [];
  private readonly bubbles: HTMLElement[] = [];
  private readonly bubblesRoot: HTMLElement;
  private readonly xpFill: HTMLElement;
  private prevAir = MAX_BUBBLES;
  private popIndex = -1;
  private popUntil = 0;

  constructor() {
    const heartsRoot = document.querySelector<HTMLElement>('#hud-hearts')!;
    for (let i = 0; i < MAX_HEARTS; i++) {
      const heart = document.createElement('div');
      heart.className = 'hud-heart';
      heartsRoot.appendChild(heart);
      this.hearts.push(heart);
    }

    this.bubblesRoot = document.querySelector<HTMLElement>('#hud-bubbles')!;
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const bubble = document.createElement('div');
      bubble.className = 'hud-bubble';
      this.bubblesRoot.appendChild(bubble);
      this.bubbles.push(bubble);
    }

    this.xpFill = document.querySelector<HTMLElement>('#hud-xp-fill')!;
    this.setHealth(20);
    this.setAir(MAX_BUBBLES, true);
    this.setXp(0);
  }

  /** health: 0..20. */
  setHealth(health: number): void {
    for (let i = 0; i < MAX_HEARTS; i++) {
      const v = health - i * 2;
      const img = v >= 2 ? fullHeart : v === 1 ? halfHeart : '';
      this.hearts[i].style.setProperty('--heart-fill', img ? `url(${img})` : 'none');
    }
  }

  /** points: 0..10 bubbles left. `full` hides the bar (not submerged / full air). */
  setAir(points: number, full: boolean): void {
    this.bubblesRoot.hidden = full;
    if (full) {
      this.prevAir = MAX_BUBBLES;
      return;
    }

    const now = performance.now();
    if (points < this.prevAir) {
      // The bubble that just burst plays a one-frame pop before going empty.
      this.popIndex = points;
      this.popUntil = now + POP_MS;
    }
    this.prevAir = points;

    for (let i = 0; i < MAX_BUBBLES; i++) {
      let img = bubbleEmpty;
      if (i < points) img = bubbleFull;
      else if (i === this.popIndex && now < this.popUntil) img = bubblePop;
      this.bubbles[i].style.backgroundImage = `url(${img})`;
    }
  }

  /** progress: 0..1. */
  setXp(progress: number): void {
    this.xpFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }
}

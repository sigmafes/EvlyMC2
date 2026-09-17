import fullHeart from '../gui/heart_full.png';
import halfHeart from '../gui/heart_half.png';
import bubbleFull from '../gui/bubble.png';
import bubblePop from '../gui/bubble_pop.png';
import bubbleEmpty from '../gui/bubble_empty.png';
import armorFull from '../gui/armor_full.png';
import armorHalf from '../gui/armor_half.png';

const MAX_HEARTS = 10; // 20 health points, 2 per heart
const MAX_BUBBLES = 10; // 300 air ticks, 30 per bubble
const MAX_ARMOR_ICONS = 10; // 20 armor points, 2 per icon - same scale as hearts
const POP_MS = 220;

export type HudIds = { hearts: string; bubbles: string; xpFill: string; armor: string };

/** Singleplayer's own DOM ids - the default so `new Hud()` behaves exactly as before. */
const DEFAULT_IDS: HudIds = { hearts: '#hud-hearts', bubbles: '#hud-bubbles', xpFill: '#hud-xp-fill', armor: '#hud-armor' };

/**
 * In-game HUD stats above the hotbar: air bubbles (only while submerged), the
 * heart row, and the XP bar.
 *
 * Takes its container ids as a constructor param (defaulting to
 * singleplayer's own) rather than hardcoding them, so multiplayer-game.ts can
 * point a second instance at its own `#mp-hud-*` elements instead of either
 * fighting over the same DOM or reimplementing this class - same reasoning
 * as third-person-camera.ts's extraction.
 */
export class Hud {
  private readonly hearts: HTMLElement[] = [];
  private readonly bubbles: HTMLElement[] = [];
  private readonly armorIcons: HTMLElement[] = [];
  private readonly bubblesRoot: HTMLElement;
  private readonly armorRoot: HTMLElement;
  private readonly xpFill: HTMLElement;
  private prevAir = MAX_BUBBLES;
  private popIndex = -1;
  private popUntil = 0;

  constructor(ids: HudIds = DEFAULT_IDS) {
    const heartsRoot = document.querySelector<HTMLElement>(ids.hearts)!;
    for (let i = 0; i < MAX_HEARTS; i++) {
      const heart = document.createElement('div');
      heart.className = 'hud-heart';
      heartsRoot.appendChild(heart);
      this.hearts.push(heart);
    }

    this.bubblesRoot = document.querySelector<HTMLElement>(ids.bubbles)!;
    for (let i = 0; i < MAX_BUBBLES; i++) {
      const bubble = document.createElement('div');
      bubble.className = 'hud-bubble';
      this.bubblesRoot.appendChild(bubble);
      this.bubbles.push(bubble);
    }

    this.armorRoot = document.querySelector<HTMLElement>(ids.armor)!;
    for (let i = 0; i < MAX_ARMOR_ICONS; i++) {
      const icon = document.createElement('div');
      icon.className = 'hud-armor-icon';
      this.armorRoot.appendChild(icon);
      this.armorIcons.push(icon);
    }

    this.xpFill = document.querySelector<HTMLElement>(ids.xpFill)!;
    this.setHealth(20);
    this.setAir(MAX_BUBBLES, true);
    this.setArmor(0);
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

  /** points: 0..20. Row hides entirely at 0, same as vanilla (no armor worn -> nothing to show). */
  setArmor(points: number): void {
    this.armorRoot.hidden = points <= 0;
    if (points <= 0) return;
    for (let i = 0; i < MAX_ARMOR_ICONS; i++) {
      const v = points - i * 2;
      const img = v >= 2 ? armorFull : v === 1 ? armorHalf : '';
      this.armorIcons[i].style.setProperty('--armor-fill', img ? `url(${img})` : 'none');
    }
  }

  /** progress: 0..1. */
  setXp(progress: number): void {
    this.xpFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }
}

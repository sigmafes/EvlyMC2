import track1 from '../sounds/music/survival1.mp3';
import track2 from '../sounds/music/survival2.mp3';
import track3 from '../sounds/music/survival3.mp3';
import track4 from '../sounds/music/survival4.mp3';
import track5 from '../sounds/music/survival5.mp3';
import track6 from '../sounds/music/survival6.mp3';
import track7 from '../sounds/music/survival7.mp3';

const TRACKS = [track1, track2, track3, track4, track5, track6, track7];

// Silence between tracks (LCE picks a random gap; keep it long and varied).
const GAP_MIN_MS = 30_000;
const GAP_MAX_MS = 60_000;

/**
 * Background music while the player is in the world: one random track at a time,
 * no consecutive repeats, a 30-60s silence gap between tracks. Pauses/resumes
 * with the game (pause menu, death) and stops when the world is left.
 */
export class WorldMusic {
  private readonly audio = new Audio();
  private lastTrack = -1;
  private gapTimer = 0;
  private paused = false;
  private stopped = false;

  constructor(volume = 0.35) {
    this.audio.volume = volume;
    this.audio.addEventListener('ended', () => this.scheduleNext());
  }

  /** Begin the music loop (call once, after entering the world). */
  start(): void {
    this.stopped = false;
    this.scheduleNext(true);
  }

  /** Temporarily silence the music (pause menu / dead), keeping the schedule. */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.audio.pause();
    } else if (!this.stopped && !this.audio.ended && this.audio.src) {
      void this.audio.play().catch(() => { /* ignore */ });
    }
  }

  /** Stop and detach entirely (call from leaveWorld). */
  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.gapTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
  }

  private scheduleNext(immediate = false): void {
    window.clearTimeout(this.gapTimer);
    if (this.stopped) return;
    const wait = immediate
      ? 3_000 + Math.random() * 7_000
      : GAP_MIN_MS + Math.random() * (GAP_MAX_MS - GAP_MIN_MS);
    this.gapTimer = window.setTimeout(() => this.playNextTrack(), wait);
  }

  private playNextTrack(): void {
    if (this.stopped) return;
    let i = Math.floor(Math.random() * TRACKS.length);
    if (TRACKS.length > 1 && i === this.lastTrack) i = (i + 1) % TRACKS.length;
    this.lastTrack = i;
    this.audio.src = TRACKS[i];
    this.audio.currentTime = 0;
    if (!this.paused) void this.audio.play().catch(() => { /* autoplay blocked */ });
  }
}

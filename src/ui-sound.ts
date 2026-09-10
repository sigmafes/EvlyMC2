import clickUrl from '../gui/click.mp3';

const base = new Audio(clickUrl);

/** UI click, shared by every menu button/toggle. Clones so rapid clicks overlap. */
export function playClick(): void {
  const sfx = base.cloneNode() as HTMLAudioElement;
  sfx.volume = 0.5;
  void sfx.play().catch(() => { /* autoplay not allowed yet */ });
}

/**
 * Android's back gesture/hardware button doesn't send a keyboard event at
 * all - in a fresh page with no browser history to go back to, it just
 * backgrounds/closes the app outright, with nothing for the game to catch.
 * The standard PWA trick: push one throwaway history entry while a menu is
 * open, so the back gesture triggers a `popstate` instead of leaving the
 * page - which this turns into a synthetic Escape keydown, reusing every
 * existing "Escape closes whichever menu is open" handler (inventory.ts,
 * multiplayer-game.ts) instead of wiring per-menu back handlers.
 *
 * `arm()` is cheap to call every frame while any menu is open (main.ts's/
 * multiplayer-game.ts's own per-frame loop) - it only actually pushes state
 * once, not on every call.
 */
let guarding = false;

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    if (!guarding) return;
    guarding = false;
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
  });
}

/** Call every frame (or on open) while at least one menu/GUI is open. */
export function armAndroidBack(): void {
  if (guarding || typeof history === 'undefined') return;
  guarding = true;
  history.pushState({ evlymcBack: true }, '');
}

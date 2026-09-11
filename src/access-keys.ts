/**
 * Closed-beta access list: one name+key pair per invited person, handed out
 * manually. Add/remove entries here and redeploy to manage who can get in.
 *
 * IMPORTANT: this is a soft gate, not real security. EvlyMC is a static site
 * with no backend (GitHub Pages), so this list ships as plain text inside the
 * public JS bundle - anyone who opens devtools or views the source can read
 * every key directly. It stops a leaked link from being casually usable by
 * strangers; it does not stop someone who deliberately goes looking.
 * "Single use" is likewise only approximated per-browser (see access-gate.ts):
 * once accepted, a key unlocks that browser permanently via localStorage.
 * There's no server to enforce that a key can't also be accepted in a second
 * browser, an incognito window, or after clearing site data.
 */
export const ACCESS_KEYS: { name: string; key: string }[] = [
  { name: 'sigmafes', key: 'bMdE3mbd' },
];

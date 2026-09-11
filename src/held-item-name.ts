/**
 * The name of the item you just selected, flashed over the HUD for a couple
 * of seconds and then faded out - Minecraft's hotbar label. One element,
 * reused; the timer restarts on every call so flicking through slots keeps
 * showing the current one instead of queueing fades.
 */
const VISIBLE_MS = 2000;

let el: HTMLElement | null = null;
let hideTimer: number | undefined;

function ensure(): HTMLElement {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'held-item-name';
  document.body.appendChild(el);
  return el;
}

/** Show `name` for VISIBLE_MS, or hide immediately when the hand is empty. */
export function showHeldItemName(name: string | null): void {
  const label = ensure();
  window.clearTimeout(hideTimer);
  if (!name) {
    label.classList.remove('visible');
    return;
  }
  label.textContent = name;
  label.classList.add('visible');
  hideTimer = window.setTimeout(() => label.classList.remove('visible'), VISIBLE_MS);
}

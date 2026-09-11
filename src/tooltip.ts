/**
 * Shared hover tooltip (Minecraft item-name style). One element, reused: call
 * showTooltip on pointer move over a slot, hideTooltip on leave.
 */
let el: HTMLElement | null = null;

function ensure(): HTMLElement {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ui-tooltip';
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

export function showTooltip(text: string, x: number, y: number): void {
  const tip = ensure();
  if (tip.textContent !== text) tip.textContent = text;
  tip.hidden = false;
  moveTooltip(x, y);
}

export function moveTooltip(x: number, y: number): void {
  if (!el || el.hidden) return;
  // Small, because the frame art already carries an 8px transparent ring.
  const pad = 6;
  const r = el.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + r.width > window.innerWidth) left = x - r.width - pad;
  if (top + r.height > window.innerHeight) top = y - r.height - pad;
  el.style.left = `${Math.max(2, left)}px`;
  el.style.top = `${Math.max(2, top)}px`;
}

export function hideTooltip(): void {
  if (el) el.hidden = true;
}

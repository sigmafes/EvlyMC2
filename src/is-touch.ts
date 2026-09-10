/**
 * Touch-device detection, shared so the pointer-lock calls scattered across the
 * UI can all opt out on phones. Pointer Lock on mobile browsers either does
 * nothing or, on Android Chrome, engages and throws up a "press back to show the
 * cursor" overlay that swallows every touch until you leave the page.
 */
export function isTouchDevice(): boolean {
  if (typeof document !== 'undefined' && document.body?.classList.contains('touch')) {
    return true; // set by TouchControls once it mounts
  }
  if (typeof window === 'undefined') return false;
  if ('ontouchstart' in window) return true;
  if ((navigator.maxTouchPoints ?? 0) > 0) return true;
  if (typeof matchMedia === 'function') {
    return matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches;
  }
  return false;
}

/** requestPointerLock() that is a no-op on touch devices. */
export function lockPointer(el: Element | null | undefined): void {
  if (!el || isTouchDevice()) return;
  (el as HTMLElement).requestPointerLock?.();
}

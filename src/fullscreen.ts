import { isTouchDevice } from './is-touch';

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  mozRequestFullScreen?: () => Promise<void> | void;
};

/**
 * Ask the browser to go fullscreen (hides the Android Chrome address bar and
 * system chrome). Must be called from inside a user-gesture handler, so it is
 * a no-op if it isn't allowed right now. Touch devices only - it would just be
 * annoying on desktop.
 */
export function enterFullscreen(): void {
  if (!isTouchDevice()) return;
  if (document.fullscreenElement) return;
  const el = document.documentElement as FsElement;
  const req = el.requestFullscreen ?? el.webkitRequestFullscreen ?? el.mozRequestFullScreen;
  try {
    const r = req?.call(el, { navigationUI: 'hide' } as FullscreenOptions);
    if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
  } catch {
    /* not permitted in this context */
  }
}

/**
 * Re-enter fullscreen on the next tap anywhere in the game, as a fallback for
 * when the user swipes it away (or the first request was blocked). Re-arms
 * itself each time fullscreen ends.
 */
export function keepFullscreenOnGesture(): void {
  if (!isTouchDevice()) return;
  const onTap = () => enterFullscreen();
  const arm = () => window.addEventListener('pointerdown', onTap, { once: true, capture: true });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) arm();
  });
  arm();
}

/**
 * Add the web-app manifest link at runtime. The manifest file is copied into
 * dist/ after `vite build`, so it can't be referenced from index.html at build
 * time. With display:"fullscreen", "Add to Home Screen" then launches EvlyMC
 * with no browser UI at all.
 */
export function linkPwaManifest(): void {
  if (document.querySelector('link[rel="manifest"]')) return;
  const link = document.createElement('link');
  link.rel = 'manifest';
  link.href = `${import.meta.env.BASE_URL}manifest.webmanifest`;
  document.head.appendChild(link);
}

import * as THREE from 'three';
import type { FirstPersonHand } from './first-person-hand';

/** The actually-visible viewport. On mobile innerHeight lags the toolbar
 *  show/hide, so prefer visualViewport when it is available. */
export function viewportSize() {
  const vv = window.visualViewport;
  return {
    w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
    h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
  };
}

export function fitInventoryPanels(): void {
  const scale = Math.min(
    1.18,
    (window.innerWidth - 16) / 352,
    (window.innerHeight - 16) / 332,
  );
  for (const sel of ['#backpack', '#crafting-table', '#furnace']) {
    document.querySelector<HTMLElement>(sel)?.style.setProperty('--inv-scale', String(scale));
  }
}

/**
 * Binds the resize/orientation handling (camera aspect, renderer size, hand
 * FOV, inventory panel scale) to one instance of camera/renderer/hand -
 * returns the listener to register on resize/orientationchange/visualViewport.
 */
export function createApplyViewport(camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer, hand: FirstPersonHand): () => void {
  return function applyViewport() {
    const { w, h } = viewportSize();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    hand.resize(w / h);
    fitInventoryPanels();
  };
}

/** Makes a floating panel (diagnostics/block-inspector) draggable by its header, persisting position in localStorage. */
export function makeFloatingPanelDraggable(panelId: string): void {
  const panel = document.querySelector<HTMLElement>(`#${panelId}`)!;
  const header = panel.querySelector<HTMLElement>('header')!;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const loadPosition = () => {
    const saved = localStorage.getItem(`panel-position-${panelId}`);
    if (saved) {
      const { left, top } = JSON.parse(saved);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    }
  };

  const savePosition = () => {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(`panel-position-${panelId}`, JSON.stringify({
      left: rect.left,
      top: rect.top,
    }));
  };

  header.style.cursor = 'grab';
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    panel.style.left = `${startLeft + deltaX}px`;
    panel.style.top = `${startTop + deltaY}px`;
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      savePosition();
      header.style.cursor = 'grab';
    }
  });

  loadPosition();
}

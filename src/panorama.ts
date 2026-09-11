import * as THREE from 'three';
import { makeZip } from './zip';

/**
 * Six cube faces of a 360° panorama, standard OpenGL cubemap convention
 * (matches the menu's own panorama_0..5 background, just captured live instead
 * of loaded from disk). `up` per face keeps each render right-side up.
 */
const FACES: { name: string; dir: THREE.Vector3; up: THREE.Vector3 }[] = [
  { name: 'panorama_px', dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
  { name: 'panorama_nx', dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, -1, 0) },
  { name: 'panorama_py', dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
  { name: 'panorama_ny', dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, -1) },
  { name: 'panorama_pz', dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, -1, 0) },
  { name: 'panorama_nz', dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, -1, 0) },
];

async function pixelsToPng(pixels: Uint8Array, size: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(size, size);
  // WebGL readPixels rows are bottom-to-top; canvas ImageData rows are top-to-bottom.
  const rowBytes = size * 4;
  for (let y = 0; y < size; y++) {
    const srcStart = (size - 1 - y) * rowBytes;
    imageData.data.set(pixels.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Renders a 6-face cube (like the menu's panorama skybox, but captured live
 * from `position`) and packs the faces into a downloadable zip.
 */
export async function capturePanorama(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  position: THREE.Vector3,
  size = 1024,
): Promise<Blob> {
  const camera = new THREE.PerspectiveCamera(90, 1, 0.05, 2000);
  const target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });

  // Render + read back all 6 faces in one synchronous block, and restore the
  // renderer's state before returning control to the event loop: the game's
  // own requestAnimationFrame loop is still ticking, and if it got to run a
  // frame between faces (e.g. while awaiting PNG encoding) it would render
  // straight into this function's still-bound offscreen target instead of the
  // visible canvas - a dropped/corrupted frame on screen, and a scrambled
  // panorama face. PNG/zip encoding (all async) happens only afterwards.
  const prevTarget = renderer.getRenderTarget();
  const rawFaces: { name: string; pixels: Uint8Array }[] = [];
  try {
    for (const face of FACES) {
      camera.position.copy(position);
      camera.up.copy(face.up);
      camera.lookAt(position.clone().add(face.dir));
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
      rawFaces.push({ name: face.name, pixels });
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    target.dispose();
  }

  const entries = [];
  for (const face of rawFaces) {
    entries.push({ name: `${face.name}.png`, data: await pixelsToPng(face.pixels, size) });
  }
  return makeZip(entries);
}

/** Trigger a browser download of the zip, named with a timestamp. */
export function downloadPanoramaZip(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `evlymc_panorama_${Date.now()}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

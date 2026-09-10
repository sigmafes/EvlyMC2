// Copy the raw asset folders into dist/ after `vite build`.
//
// Most assets reach the bundle through static ESM imports (gui/, music) or the
// import.meta.glob in block-preview.ts, and Vite hashes those into dist/assets.
// But several modules resolve asset URLs at RUNTIME:
//   - block.ts / break-overlay.ts:  new URL('../textures/blocks/x.png', import.meta.url)
//   - sound-manager.ts:             new URL(`${path}${ext}`, import.meta.url)  (fully dynamic)
//   - player-model.ts:              new URL('../textures/player.png', import.meta.url)
// Those URLs land on <base>/textures/... and <base>/sounds/..., which only exist
// if the folders sit next to the bundle. In dev Vite serves them from the project
// root; in production we have to copy them.
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const FOLDERS = ['textures', 'sounds', 'gui'];

if (!existsSync(dist)) {
  console.error('copy-assets: dist/ not found - run `vite build` first.');
  process.exit(1);
}

for (const folder of FOLDERS) {
  const from = resolve(root, folder);
  if (!existsSync(from)) {
    console.error(`copy-assets: missing source folder "${folder}"`);
    process.exit(1);
  }
  const to = resolve(dist, folder);
  await mkdir(to, { recursive: true });
  await cp(from, to, { recursive: true });
  console.log(`copy-assets: ${folder}/ -> dist/${folder}/`);
}

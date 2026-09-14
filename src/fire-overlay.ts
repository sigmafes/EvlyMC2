import * as THREE from 'three';

/**
 * Shared "on fire" visual: a billboard-cross of two crossed planes (same
 * technique as arrow-projectiles.ts's arrow mesh) textured with the same
 * animated fire strip the FIRE block uses (textures/atlas/fire_atlas.png,
 * 32 frames scrolled vertically), tinted orange and at 50% opacity so the
 * body underneath still reads through it. Geometry and material are shared
 * across every instance (mob or player) - only the Group wrapping them is
 * per-instance, so each can be positioned/sized/toggled independently while
 * the texture's scroll animation (driven once per frame by
 * updateFireOverlayAnimation()) is automatically in sync everywhere.
 */

const FRAME_COUNT = 32; // matches fireTex's own strip layout in block.ts
const FRAMES_PER_SECOND = 20; // matches block.ts's fire animation speed

let sharedTexture: THREE.Texture | null = null;
let sharedMaterial: THREE.MeshBasicMaterial | null = null;
let crossGeometry: THREE.PlaneGeometry | null = null;

function getFireTexture(): THREE.Texture {
  if (!sharedTexture) {
    sharedTexture = new THREE.TextureLoader().load(new URL('../textures/atlas/fire_atlas.png', import.meta.url).href);
    sharedTexture.colorSpace = THREE.SRGBColorSpace;
    sharedTexture.magFilter = THREE.NearestFilter;
    sharedTexture.minFilter = THREE.NearestFilter;
    sharedTexture.generateMipmaps = false;
    sharedTexture.wrapT = THREE.RepeatWrapping;
    sharedTexture.repeat.set(1, 1 / FRAME_COUNT);
    sharedTexture.offset.set(0, (FRAME_COUNT - 1) / FRAME_COUNT);
  }
  return sharedTexture;
}

function getFireMaterial(): THREE.MeshBasicMaterial {
  if (!sharedMaterial) {
    // No baked-in color tint here (was 0xff8c33) - the flame texture's own
    // colors are already fiery, and multiplying them by an extra orange
    // stacked on top of the body's own 25%-orange fire tint just fused the
    // two into one indistinct orange blob instead of the flame reading as
    // its own distinct thing over the body.
    sharedMaterial = new THREE.MeshBasicMaterial({
      map: getFireTexture(),
      transparent: true,
      opacity: 0.5,
      alphaTest: 0.05,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return sharedMaterial;
}

function getCrossGeometry(): THREE.PlaneGeometry {
  if (!crossGeometry) {
    crossGeometry = new THREE.PlaneGeometry(1, 1);
    crossGeometry.userData.shared = true;
  }
  return crossGeometry;
}

/**
 * Builds a "+"-cross fire overlay sized to wrap around a `radius`-wide,
 * `height`-tall hitbox, positioned so its vertical centre lines up with the
 * hitbox's centre when added as a child of a group. `feetYOffset` is where
 * the feet actually sit relative to that group's own local Y=0 - mob groups'
 * origin IS the feet (offset 0, the default), but the player model's group
 * origin is at EYE level instead (player-model-geometry.ts), so its feet sit
 * at local Y=-1.62 - passing that here is what keeps the overlay centred on
 * the body instead of floating chest-height above the head. Starts hidden -
 * toggle with the returned group's `.visible`.
 */
export function createFireOverlay(radius: number, height: number, feetYOffset = 0): THREE.Group {
  const group = new THREE.Group();
  const geo = getCrossGeometry();
  const mat = getFireMaterial();
  const width = Math.max(radius * 2.4, height * 0.6);

  const a = new THREE.Mesh(geo, mat);
  a.scale.set(width, height * 1.1, 1);
  const b = new THREE.Mesh(geo, mat);
  b.scale.set(width, height * 1.1, 1);
  b.rotation.y = Math.PI / 2;

  group.add(a, b);
  group.position.y = feetYOffset + height / 2;
  group.visible = false;
  group.renderOrder = 1; // draw after the body so the 50%-opacity blend reads correctly over it
  return group;
}

/** Advance the shared fire texture's scroll. Call once per frame (game-loop.ts, alongside updateWaterAnimation). */
export function updateFireOverlayAnimation(time: number): void {
  const texture = sharedTexture;
  if (!texture) return;
  const frame = Math.floor(time * FRAMES_PER_SECOND) % FRAME_COUNT;
  texture.offset.y = (FRAME_COUNT - 1 - frame) / FRAME_COUNT;
}

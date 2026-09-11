import * as THREE from 'three';

const MAX = 64;
const RISE_SPEED = 0.9;
const DRIFT = 0.5;
const LIFE = 0.7;
const START_SCALE = 0.35;
const END_SCALE = 0.75;

/**
 * Small pool of billboard smoke sprites (Smoke1..7.png, cycled numerically)
 * used for the mob death poof - separate from ParticleSystem (which is a
 * single untextured THREE.Points cloud) since these need distinct textures
 * and per-sprite fade/scale-up, not just gravity-flung colour dots.
 */
export class SmokeParticles {
  private readonly group = new THREE.Group();
  private readonly sprites: THREE.Sprite[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly life: number[] = [];
  private cursor = 0;

  constructor() {
    const textures: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    for (let i = 1; i <= 7; i++) {
      const tex = loader.load(new URL(`../textures/particles/Smoke${i}.png`, import.meta.url).href);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      textures.push(tex);
    }

    for (let i = 0; i < MAX; i++) {
      const material = new THREE.SpriteMaterial({
        map: textures[i % textures.length],
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.scale.setScalar(START_SCALE);
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.vel.push(new THREE.Vector3());
      this.life.push(0);
    }
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** 6 smoke puffs cycling numerically through Smoke1..7, at `pos`. */
  burst(pos: THREE.Vector3): void {
    for (let k = 0; k < 6; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX;
      const sprite = this.sprites[i];
      sprite.position.set(
        pos.x + (Math.random() - 0.5) * 0.4,
        pos.y + (Math.random() - 0.5) * 0.3,
        pos.z + (Math.random() - 0.5) * 0.4,
      );
      sprite.visible = true;
      sprite.scale.setScalar(START_SCALE);
      (sprite.material as THREE.SpriteMaterial).opacity = 0.9;
      this.vel[i].set((Math.random() - 0.5) * DRIFT, RISE_SPEED * (0.7 + Math.random() * 0.6), (Math.random() - 0.5) * DRIFT);
      this.life[i] = LIFE * (0.8 + Math.random() * 0.4);
    }
  }

  update(delta: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= delta;
      const sprite = this.sprites[i];
      if (this.life[i] <= 0) {
        sprite.visible = false;
        continue;
      }
      sprite.position.addScaledVector(this.vel[i], delta);
      const t = 1 - Math.max(this.life[i], 0) / LIFE;
      sprite.scale.setScalar(START_SCALE + (END_SCALE - START_SCALE) * t);
      (sprite.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - t);
    }
  }
}

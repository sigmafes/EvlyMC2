import * as THREE from 'three';

const MAX = 32;
const FRAME_COUNT = 7; // Smoke1.png..Smoke7.png
const LIFE = 3; // seconds - shown "por 3s antes de desaparecer"
const RISE_SPEED = 0.35; // "suben lentamente"
const DRIFT = 0.15;
const FADE_START = 0.7; // fraction of LIFE elapsed before it starts fading out

/**
 * Small pool of billboard smoke sprites for the mob death poof. Each puff
 * plays Smoke1..Smoke7 as a frame-by-frame animation (in numeric order) over
 * its whole LIFE, rather than picking one random texture and holding it -
 * that mismatch (plus a too-short life and too-fast rise) was the previous
 * bug. Separate from ParticleSystem (a single untextured THREE.Points cloud
 * used for block-break bits), since these need real textures and per-sprite
 * frame animation.
 */
export class SmokeParticles {
  private readonly group = new THREE.Group();
  private readonly textures: THREE.Texture[] = [];
  private readonly sprites: THREE.Sprite[] = [];
  private readonly vel: THREE.Vector3[] = [];
  private readonly life: number[] = [];
  private readonly frame: number[] = [];
  private cursor = 0;

  constructor() {
    const loader = new THREE.TextureLoader();
    for (let i = 1; i <= FRAME_COUNT; i++) {
      const tex = loader.load(new URL(`../textures/particles/Smoke${i}.png`, import.meta.url).href);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      this.textures.push(tex);
    }

    for (let i = 0; i < MAX; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.textures[0],
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.scale.setScalar(0.5);
      this.group.add(sprite);
      this.sprites.push(sprite);
      this.vel.push(new THREE.Vector3());
      this.life.push(0);
      this.frame.push(0);
    }
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** 6 smoke puffs at `pos`, each cycling Smoke1..7 in order over LIFE seconds while rising slowly. */
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
      sprite.scale.setScalar(0.5);
      const material = sprite.material as THREE.SpriteMaterial;
      material.map = this.textures[0];
      material.opacity = 0.9;
      material.needsUpdate = true;
      this.vel[i].set((Math.random() - 0.5) * DRIFT, RISE_SPEED * (0.8 + Math.random() * 0.4), (Math.random() - 0.5) * DRIFT);
      this.life[i] = LIFE;
      this.frame[i] = 0;
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

      const elapsedFrac = 1 - this.life[i] / LIFE;
      const frame = Math.min(FRAME_COUNT - 1, Math.floor(elapsedFrac * FRAME_COUNT));
      if (frame !== this.frame[i]) {
        this.frame[i] = frame;
        const material = sprite.material as THREE.SpriteMaterial;
        material.map = this.textures[frame];
        material.needsUpdate = true;
      }

      const material = sprite.material as THREE.SpriteMaterial;
      material.opacity = elapsedFrac < FADE_START ? 0.9 : 0.9 * (1 - (elapsedFrac - FADE_START) / (1 - FADE_START));
    }
  }
}

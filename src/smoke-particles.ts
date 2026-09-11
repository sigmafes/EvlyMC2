import * as THREE from 'three';

const MAX = 32;
const FRAME_COUNT = 7; // Smoke1.png..Smoke7.png
const LIFE_MIN = 0.5; // seconds - each puff gets a random life in [LIFE_MIN, LIFE_MAX]
const LIFE_MAX = 2;
const RISE_SPEED = 0.35; // "suben lentamente"
const SPREAD_RADIUS = 0.55; // ring radius the 6 puffs are placed around, so they don't overlap
const OUTWARD_SPEED = 0.5; // keeps drifting apart (away from the burst centre) as they rise
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
  private readonly totalLife: number[] = [];
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
      this.totalLife.push(LIFE_MAX);
      this.frame.push(0);
    }
  }

  attachToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  /** 6 smoke puffs at `pos`, spread around a ring so they don't overlap, each with its own random life in [LIFE_MIN, LIFE_MAX] and cycling Smoke1..7 in order over it while drifting outward and rising slowly. */
  burst(pos: THREE.Vector3): void {
    const count = 6;
    const baseAngle = Math.random() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX;
      const angle = baseAngle + (k / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
      const dirX = Math.sin(angle);
      const dirZ = Math.cos(angle);
      const radius = SPREAD_RADIUS * (0.7 + Math.random() * 0.5);
      const sprite = this.sprites[i];
      sprite.position.set(
        pos.x + dirX * radius,
        pos.y + (Math.random() - 0.5) * 0.2,
        pos.z + dirZ * radius,
      );
      sprite.visible = true;
      sprite.scale.setScalar(0.5);
      const material = sprite.material as THREE.SpriteMaterial;
      material.map = this.textures[0];
      material.opacity = 0.9;
      material.needsUpdate = true;
      this.vel[i].set(dirX * OUTWARD_SPEED, RISE_SPEED * (0.8 + Math.random() * 0.4), dirZ * OUTWARD_SPEED);
      const life = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
      this.life[i] = life;
      this.totalLife[i] = life;
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

      const elapsedFrac = 1 - this.life[i] / this.totalLife[i];
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

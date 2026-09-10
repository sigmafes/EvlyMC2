import * as THREE from 'three';
import { BlockId } from './block';
import type { World } from './world';

export type UnderwaterState = {
  isUnderwater: boolean;
  fogNear: number;
  fogFar: number;
};

export class UnderwaterManager {
  private readonly waterSkyColor = new THREE.Color(0x3f76e4);
  private isUnderwater = false;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly world: World,
    private readonly scene: THREE.Scene,
    private readonly fog: THREE.Fog,
    private readonly underwaterOverlay: HTMLElement | null,
  ) {}

  update(skyColor: THREE.Color): UnderwaterState {
    const underwater = this.isCameraInWater();

    if (underwater !== this.isUnderwater) {
      this.isUnderwater = underwater;
      if (underwater) {
        this.fog.near = 1;
        this.fog.far = 14;
        this.scene.background = this.waterSkyColor;
        this.fog.color.copy(this.waterSkyColor);
      } else {
        this.fog.near = 18;
        this.fog.far = 42;
        this.scene.background = skyColor;
        this.fog.color.copy(skyColor);
      }
    }

    this.underwaterOverlay?.classList.toggle('active', underwater);

    return {
      isUnderwater: underwater,
      fogNear: this.fog.near,
      fogFar: this.fog.far,
    };
  }

  private isCameraInWater(): boolean {
    const x = Math.round(this.camera.position.x);
    const z = Math.round(this.camera.position.z);
    const y = Math.floor(this.camera.position.y + 0.5);
    const block = this.world.getBlock(x, y, z);

    if (block !== BlockId.WATER) return false;
    if (this.world.getBlock(x, y + 1, z) === BlockId.WATER) return true;

    const dist = this.world.getWaterDistance(x, y, z);
    const h = dist === 0 ? 0.9 : Math.max(0.18, 0.9 - dist * 0.1);
    return this.camera.position.y < y - 0.5 + h;
  }
}

import * as THREE from 'three';
import { MobModel, type QuadrupedSpec } from './mob-model';

type Mob = {
  model: MobModel;
};

/**
 * Fase H scaffold: just enough to see mobs standing in the world and playing
 * their animation. No AI, no physics, no persistence - a mob spawned here
 * stays exactly where it was placed and doesn't survive a reload. All of
 * that is explicitly out of scope for this pass (see PLAN-MOBS.md).
 */
export class MobManager {
  private readonly mobs: Mob[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** Place a mob at `pos` (feet/ground level, matching block-coordinate convention), facing `yaw`. */
  spawn(spec: QuadrupedSpec, pos: THREE.Vector3, yaw: number): void {
    const model = new MobModel(spec);
    const group = model.getGroup();
    group.position.copy(pos);
    group.rotation.y = yaw;
    // No AI yet to drive real movement - forcing the walk cycle on is the
    // only way to actually see it (and confirm Fase B/G's animation) before
    // that exists.
    model.setWalking(true);
    this.scene.add(group);
    this.mobs.push({ model });
  }

  /** Advance every mob's idle/walk animation and light tint. Call once per frame. */
  update(delta: number, getLight?: (x: number, y: number, z: number) => number): void {
    for (const mob of this.mobs) {
      mob.model.update(delta);
      if (getLight) {
        const p = mob.model.getGroup().position;
        const level = getLight(Math.round(p.x), Math.round(p.y + 0.5), Math.round(p.z));
        mob.model.setLightLevel(level / 15);
      }
    }
  }
}

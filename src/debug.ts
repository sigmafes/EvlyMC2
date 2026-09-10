import * as THREE from 'three';
import { World } from './world';
import { PlayerController } from './player';

export class DebugOverlay {
  private readonly playerHelper: THREE.Box3Helper;
  private readonly hitboxHelper: THREE.Box3Helper;
  private readonly lookArrow: THREE.ArrowHelper;
  private readonly chunkHelpers = new Map<string, THREE.Box3Helper>();
  private readonly lookDir = new THREE.Vector3();
  private enabled = false;

  constructor(private readonly scene: THREE.Scene, private readonly world: World, private readonly player: PlayerController) {
    this.playerHelper = new THREE.Box3Helper(new THREE.Box3(), 0xff3366);
    this.playerHelper.visible = false;
    this.playerHelper.renderOrder = 3;
    scene.add(this.playerHelper);

    // Green hitbox centred on eye height + yellow arrow pointing where the player looks.
    this.hitboxHelper = new THREE.Box3Helper(new THREE.Box3(), 0x00ff00);
    this.hitboxHelper.visible = false;
    this.hitboxHelper.renderOrder = 3;
    scene.add(this.hitboxHelper);

    this.lookArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 1.5, 0xffff00, 0.35, 0.22);
    this.lookArrow.visible = false;
    this.lookArrow.renderOrder = 3;
    scene.add(this.lookArrow);

    document.addEventListener('keydown', this.onKeyDown);
  }

  update() {
    const position = this.player.state.position;
    const { radius, height, collisionEyeHeight } = this.player.getHitbox();

    // Red box: the real collision hitbox (feet -> feet + height).
    const footY = position.y - collisionEyeHeight;
    const playerBox = this.playerHelper.box;
    playerBox.min.set(position.x - radius, footY, position.z - radius);
    playerBox.max.set(position.x + radius, footY + height, position.z + radius);
    this.playerHelper.visible = this.enabled;

    // Green box: thin marker slab at eye height (visual only, no collision).
    const eyeSlab = 0.05;
    const hitbox = this.hitboxHelper.box;
    hitbox.min.set(position.x - radius, position.y - eyeSlab / 2, position.z - radius);
    hitbox.max.set(position.x + radius, position.y + eyeSlab / 2, position.z + radius);
    this.hitboxHelper.visible = this.enabled;

    // Yellow arrow: from the eyes, along the look direction.
    this.lookDir.set(0, 0, -1)
      .applyAxisAngle(new THREE.Vector3(1, 0, 0), this.player.state.pitch)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.player.state.yaw);
    this.lookArrow.position.copy(position);
    this.lookArrow.setDirection(this.lookDir);
    this.lookArrow.visible = this.enabled;

    const activeKeys = new Set(this.world.chunks.keys());
    for (const [key, helper] of this.chunkHelpers) {
      helper.visible = this.enabled && activeKeys.has(key);
      if (!activeKeys.has(key)) {
        this.scene.remove(helper);
        this.chunkHelpers.delete(key);
      }
    }
    for (const [key, chunk] of this.world.chunks) {
      if (this.chunkHelpers.has(key)) continue;
      const helper = new THREE.Box3Helper(chunk.bounds, 0xffd166);
      helper.renderOrder = 3;
      helper.visible = this.enabled;
      this.chunkHelpers.set(key, helper);
      this.scene.add(helper);
    }
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'KeyR' && !event.repeat) this.enabled = !this.enabled;
  };
}

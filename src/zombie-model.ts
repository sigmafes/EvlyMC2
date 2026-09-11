import type { BipedSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/zombie.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

// zombie.png is the classic 64x32 humanoid skin layout (same texOffs formula
// already verified in player-model.ts's SKIN_UV for the 64x64 format: head
// texOffs(0,0), body texOffs(16,16), right arm texOffs(40,16), right leg
// texOffs(0,16) - all size-for-size identical here, just no separate left
// arm/leg region below y=32 the way the newer 64x64 skins have. BipedMobModel
// shares one geometry per limb type across both sides (same simplification
// MobModel already makes for the 4 quadruped legs), so the left limbs reuse
// these same rects unmirrored - fine at this scale for a skin with no
// asymmetric detail baked into the arm/leg texture.
const HEAD_UV: FaceRects = {
  py: [8, 0, 15, 7], ny: [16, 0, 23, 7],
  px: [0, 8, 7, 15], nz: [8, 8, 15, 15], nx: [16, 8, 23, 15], pz: [24, 8, 31, 15],
};
const BODY_UV: FaceRects = {
  py: [20, 16, 27, 19], ny: [28, 16, 35, 19],
  px: [16, 20, 19, 31], nz: [20, 20, 27, 31], nx: [28, 20, 31, 31], pz: [32, 20, 39, 31],
};
const LEG_UV: FaceRects = {
  py: [4, 16, 7, 19], ny: [8, 16, 11, 19],
  px: [0, 20, 3, 31], nz: [4, 20, 7, 31], nx: [8, 20, 11, 31], pz: [12, 20, 15, 31],
};
const ARM_UV: FaceRects = {
  py: [44, 16, 47, 19], ny: [48, 16, 51, 19],
  px: [40, 20, 43, 31], nz: [44, 20, 47, 31], nx: [48, 20, 51, 31], pz: [52, 20, 55, 31],
};

// Pixels -> blocks at 16px/block, same convention as pig/cow/sheep.
const PX = (n: number) => n / 16;

const HEAD_SIZE: [number, number, number] = [PX(8), PX(8), PX(8)];
const BODY_SIZE: [number, number, number] = [PX(8), PX(12), PX(4)];
const LEG_SIZE: [number, number, number] = [PX(4), PX(12), PX(4)];
const ARM_SIZE: [number, number, number] = [PX(4), PX(12), PX(4)];

const LEG_TOP_Y = LEG_SIZE[1];                        // ground -> hip
const BODY_PIVOT_Y = LEG_TOP_Y + BODY_SIZE[1] / 2;    // hip -> torso centre
const SHOULDER_Y = LEG_TOP_Y + BODY_SIZE[1];          // hip -> shoulder
const HEAD_PIVOT_Y = SHOULDER_Y + HEAD_SIZE[1] / 2;

const LEG_INSET_X = LEG_SIZE[0] / 2;                  // legs flush together under the body's centre line
const ARM_INSET_X = BODY_SIZE[0] / 2 + ARM_SIZE[0] / 2; // arms just outside the body

// Arms held out straight ahead (zombie's signature reaching pose) instead
// of hanging down like the legs. The mesh hangs from its pivot along local
// -Y at rotation.x=0 (same as a leg); the model's forward is local -Z (see
// atlas-box.ts/player-model.ts: "the model faces -Z"), and rotating a
// -Y-hanging point by +90 deg about X swings it to -Z - i.e. forward, not
// up. (A first attempt used ~166 deg here, which pointed the arms mostly
// back up overhead instead - this is the "hacia adelante" fix.)
const ARM_PITCH = Math.PI / 2;

export const ZOMBIE_SPEC: BipedSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: HEAD_SIZE, pivot: [0, HEAD_PIVOT_Y, 0], uv: HEAD_UV },
  body: { size: BODY_SIZE, pivot: [0, BODY_PIVOT_Y, 0], uv: BODY_UV },
  leg: { size: LEG_SIZE, uv: LEG_UV },
  legPivots: [
    [-LEG_INSET_X, LEG_TOP_Y, 0], // left
    [LEG_INSET_X, LEG_TOP_Y, 0],  // right
  ],
  arm: { size: ARM_SIZE, uv: ARM_UV },
  armPivots: [
    [-ARM_INSET_X, SHOULDER_Y, 0], // left
    [ARM_INSET_X, SHOULDER_Y, 0],  // right
  ],
  armPitch: ARM_PITCH,
};

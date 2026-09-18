import type { SpiderSpec } from './mob-model';
import type { FaceRects } from './atlas-box';

const TEXTURE_PATH = new URL('../textures/mobs/spider.png', import.meta.url).href;
const TEXTURE_W = 64;
const TEXTURE_H = 32;

/**
 * Standard Minecraft box-UV unwrap (same formula zombie-model.ts's rects
 * were derived from, inclusive end pixels) for a box of pixel size w*h*d
 * whose texture origin is (u, v). Front is -Z in this engine.
 */
function boxUV(u: number, v: number, w: number, h: number, d: number): FaceRects {
  return {
    py: [u + d, v, u + d + w - 1, v + d - 1],
    ny: [u + d + w, v, u + d + 2 * w - 1, v + d - 1],
    px: [u, v + d, u + d - 1, v + d + h - 1],
    nz: [u + d, v + d, u + d + w - 1, v + d + h - 1],
    nx: [u + d + w, v + d, u + 2 * d + w - 1, v + d + h - 1],
    pz: [u + 2 * d + w, v + d, u + 2 * d + 2 * w - 1, v + d + h - 1],
  };
}

// Pixels -> blocks at 16px/block, same convention as the other mob specs.
const PX = (n: number) => n / 16;

// Vanilla ModelSpider layout (spider.png is the classic 64x32 sheet): head
// texOffs(32,4) 8x8x8, neck/thorax texOffs(0,0) 6x6x6, abdomen texOffs(0,12)
// 10x8x12, legs texOffs(18,0) 16x2x2. Everything's centred 9px above the
// ground, thorax at the origin, head in front (-Z), abdomen behind (+Z).
const BODY_Y = PX(9);

export const SPIDER_SPEC: SpiderSpec = {
  texturePath: TEXTURE_PATH,
  textureW: TEXTURE_W,
  textureH: TEXTURE_H,
  head: { size: [PX(8), PX(8), PX(8)], pivot: [0, BODY_Y, -PX(7)], uv: boxUV(32, 4, 8, 8, 8) },
  neck: { size: [PX(6), PX(6), PX(6)], pivot: [0, BODY_Y, 0], uv: boxUV(0, 0, 6, 6, 6) },
  body: { size: [PX(10), PX(8), PX(12)], pivot: [0, BODY_Y, PX(9)], uv: boxUV(0, 12, 10, 8, 12) },
  leg: { size: [PX(16), PX(2), PX(2)], uv: boxUV(18, 0, 16, 2, 2) },
  // Front pair to back pair, each [-X side, +X side], attached to the thorax.
  legPivots: [
    [-PX(4), BODY_Y, -PX(1)], [PX(4), BODY_Y, -PX(1)],
    [-PX(4), BODY_Y, 0], [PX(4), BODY_Y, 0],
    [-PX(4), BODY_Y, PX(1)], [PX(4), BODY_Y, PX(1)],
    [-PX(4), BODY_Y, PX(2)], [PX(4), BODY_Y, PX(2)],
  ],
};

import * as THREE from 'three';
import { applyAtlasUVs, applyFaceShading, type FaceRects } from './atlas-box';

/**
 * Player cape - geometry, texture and swing physics ported from LCE
 * (Minecraft.Client/HumanoidModel.cpp's cloak box + PlayerRenderer.cpp's
 * per-frame angle math + Minecraft.World/Player.cpp's per-tick lag
 * simulation). LCE calls it "cloak" throughout; this file keeps the
 * user-facing "cape" name (textures/cape1.png) but the physics/geometry are
 * a direct port.
 *
 * Geometry: a single 10x16x1 (pixel units, /16 for blocks) box, same as
 * LCE's `cloak->addHumanoidBox(-5, 0, -1, 10, 16, 1, g)` - centred on X,
 * hanging DOWN a full block from its pivot (the top edge, at the shoulders),
 * and 1px thick just behind the torso.
 *
 * Physics: LCE has no wind or multi-segment soft body - it's a single
 * trailing point (`xCloak/yCloak/zCloak`) that chases the player's real
 * position at 25% per TICK (snapping if the gap ever exceeds 10 blocks,
 * e.g. a teleport/respawn), converted here to a frame-rate-independent
 * `1 - exp(-k*dt)` the same way view-bob.ts converts its own per-tick LCE
 * eases. The resulting lag vector (xd/yd/zd = lag position - real position)
 * is decomposed into a forward "lean" (blown back while running), a
 * sideways "lean2" (sway), and a vertical "flap" (falling/jumping), then a
 * walk-cycle flutter and a flat sneaking bump are layered on top - exactly
 * PlayerRenderer.cpp's formula, just fed this engine's own body-yaw/walk
 * state instead of LCE's.
 */

/** Cosmetic allowlist - only these accounts render with a cape; everyone else's PlayerModel keeps `cape.group.visible = false`. Lowercased for a case-insensitive match against a display name. */
const CAPE_ALLOWED_NAMES = new Set(['dummy', 'steve', 'sigmafes']);

export function isCapeAllowed(name: string): boolean {
  return CAPE_ALLOWED_NAMES.has(name.trim().toLowerCase());
}

const CAPE_TEXTURE_PATH = new URL('../textures/cape1.png', import.meta.url).href;
const CAPE_TEX_W = 64;
const CAPE_TEX_H = 32;

// Pixel units (/16 = blocks), matching LCE's addHumanoidBox(-5, 0, -1, 10, 16, 1).
const WIDTH_PX = 10;
const HEIGHT_PX = 16;
const DEPTH_PX = 1;
const PX = 1 / 16;

let sharedGeometry: THREE.BoxGeometry | null = null;
let sharedMaterial: THREE.MeshBasicMaterial | null = null;

/** Standard Minecraft 64x32 cape UV unwrap (box(u=0,v=0,w=10,h=16,d=1)). */
function capeUVRects(): FaceRects {
  return {
    py: [1, 0, 10, 0],   // top
    ny: [11, 0, 20, 0],  // bottom
    px: [0, 1, 0, 16],   // right edge strip
    nx: [11, 1, 11, 16], // left edge strip
    // pz (+Z) faces backward/outward in this engine's -Z-forward convention -
    // that's the big face someone standing behind the player actually sees,
    // so it gets the recognizable "front" cape art. nz (-Z) sits flush
    // against the player's own back and is essentially never seen.
    pz: [1, 1, 10, 16],  // "front" cape art (outward-facing)
    nz: [12, 1, 21, 16], // "back" cape art (touches the player)
  };
}

function getCapeGeometry(): THREE.BoxGeometry {
  if (sharedGeometry) return sharedGeometry;
  const geo = new THREE.BoxGeometry(WIDTH_PX * PX, HEIGHT_PX * PX, DEPTH_PX * PX);
  // Shift the pivot to the TOP edge (local Y=0 at the shoulders, hanging
  // down to -height) instead of BoxGeometry's default centre, so rotating
  // the mesh swings it like a real cape instead of see-sawing through its
  // own middle.
  geo.translate(0, -(HEIGHT_PX * PX) / 2, 0);
  applyAtlasUVs(geo, capeUVRects(), CAPE_TEX_W, CAPE_TEX_H);
  applyFaceShading(geo);
  return (sharedGeometry = geo);
}

function getCapeMaterial(): THREE.MeshBasicMaterial {
  if (sharedMaterial) return sharedMaterial;
  const texture = new THREE.TextureLoader().load(CAPE_TEXTURE_PATH);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  sharedMaterial = new THREE.MeshBasicMaterial({
    map: texture, vertexColors: true, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  return sharedMaterial;
}

const DEG = Math.PI / 180;
/** Matches Player.cpp's per-tick `xCloak += (x - xCloak) * 0.25` (20 tps), converted to a frame-rate-independent `1 - exp(-k*dt)` ease the same way view-bob.ts converts its own per-tick LCE eases - solved so `1 - exp(-k * 1/20) = 0.25`. */
const LAG_K = 5.75;
const SNAP_DISTANCE = 10; // blocks - teleport guard, same threshold LCE uses
const REST_TILT_NORMAL = 10;
const REST_TILT_SPRINT = 75;
const REST_TILT_DAMP = 6; // lambda for THREE.MathUtils.damp - the rise/fall itself, not the per-step flutter on top of it

export class Cape {
  readonly group: THREE.Group;
  private readonly mesh: THREE.Mesh;
  private lagX = 0;
  private lagY = 0;
  private lagZ = 0;
  private initialized = false;
  /** Eased resting tilt (degrees) - damped toward REST_TILT_NORMAL/REST_TILT_SPRINT instead of snapping, so starting/stopping a sprint rises/falls smoothly instead of popping straight to the new angle. */
  private restTilt = REST_TILT_NORMAL;

  constructor() {
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(getCapeGeometry(), getCapeMaterial());
    this.group.add(this.mesh);
  }

  /** Snap the lag point to `pos` immediately - call on spawn/respawn/teleport so the cape doesn't swing in from wherever it happened to be lagging. */
  reset(pos: THREE.Vector3): void {
    this.lagX = pos.x;
    this.lagY = pos.y;
    this.lagZ = pos.z;
    this.initialized = true;
  }

  /**
   * @param delta seconds since last call
   * @param pos current world-space anchor (this model's own group.position - the player's real position, not the cape's)
   * @param bodyYaw current body yaw, radians
   * @param walkPhase01 0..1 progress through the walk-cycle (PlayerModel's own walkCycleTime/WALK_CYCLE_DURATION) - drives the footstep flutter
   * @param walkPow 0..1 how much of the walk animation is currently active (0 idle, ramps with isWalking/isReturning) - fades the flutter in/out with it instead of snapping
   * @param sneakAmount 0..1 current sneak blend (PlayerModel's own sneakAmount)
   * @param sprinting whether the player is currently sprinting - eases the resting tilt up to REST_TILT_SPRINT while true, back down to REST_TILT_NORMAL once it isn't
   */
  update(delta: number, pos: THREE.Vector3, bodyYaw: number, walkPhase01: number, walkPow: number, sneakAmount: number, sprinting: boolean): void {
    if (!this.initialized) { this.reset(pos); return; }
    this.restTilt = THREE.MathUtils.damp(this.restTilt, sprinting ? REST_TILT_SPRINT : REST_TILT_NORMAL, REST_TILT_DAMP, delta);

    const xca = pos.x - this.lagX;
    const yca = pos.y - this.lagY;
    const zca = pos.z - this.lagZ;
    if (Math.abs(xca) > SNAP_DISTANCE) this.lagX = pos.x;
    if (Math.abs(yca) > SNAP_DISTANCE) this.lagY = pos.y;
    if (Math.abs(zca) > SNAP_DISTANCE) this.lagZ = pos.z;

    const k = 1 - Math.exp(-LAG_K * delta);
    this.lagX += (pos.x - this.lagX) * k;
    this.lagY += (pos.y - this.lagY) * k;
    this.lagZ += (pos.z - this.lagZ) * k;

    // LCE's xd/yd/zd = laggedCloak - realPlayer.
    const xd = this.lagX - pos.x;
    const yd = this.lagY - pos.y;
    const zd = this.lagZ - pos.z;

    // Forward vector at the current body yaw (this engine's own convention,
    // matches player.ts/mob-ai.ts's "-sin, -cos" forward - see e.g. the
    // /summon command's spawn-in-front-of-player math).
    const fx = -Math.sin(bodyYaw);
    const fz = -Math.cos(bodyYaw);

    let flap = yd * 10; // radians-ish scale before the DEG conversion below - matches LCE's raw-degree formula
    flap = THREE.MathUtils.clamp(flap, -6, 32);
    let lean = (xd * fx + zd * fz) * 100;
    if (lean < 0) lean = 0;
    const lean2 = (xd * fz - zd * fx) * 100;

    // Footstep flutter - LCE ties this to accumulated walk DISTANCE
    // (sin(walkDist*6)), this engine's arm swing instead runs a fixed-
    // duration cycle; one gentle sway per stride (phase*2*PI), toned WAY
    // down from LCE's raw 32deg swing (which reads as a sharp back-and-
    // forth flick at this model's scale) for a smoother, subtler flap.
    flap += Math.sin(walkPhase01 * 2 * Math.PI) * 10 * walkPow;
    flap += 25 * sneakAmount; // LCE's flat crouch bump, scaled by the sneak blend instead of an all-or-nothing toggle

    // this.restTilt is the eased 10<->75deg value damped above - raised well
    // above LCE's own flat 6deg at rest (at LCE's scale that's enough to
    // visibly clear the back, but on this model it read as glued flat
    // against the torso) and further still while sprinting, same idea as
    // real Minecraft's cape kicking up and out at a sprint.
    let xRot = this.restTilt + lean / 2 + flap;
    xRot = Math.min(xRot, 89); // never flip flat past vertical - REST_TILT_SPRINT (75) alone would clip 4J's original 64 cap, so this is raised to match

    // Negated - a positive X rotation here swung the cape's bottom edge
    // toward the player (a "\" lean into the back), when it should flare
    // away/outward at rest and get blown further out while moving ("/").
    this.mesh.rotation.set(-xRot * DEG, -(lean2 / 2) * DEG, (lean2 / 2) * DEG);
  }
}

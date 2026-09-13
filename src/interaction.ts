import * as THREE from 'three';
import { BlockId, isInteractive, isToggleable } from './block';
import { isBlock, foodValue, ItemId } from './item';
import { getDrops } from './drops';
import { isSlab, shapeBoxesFor } from './block-shapes';
import { USE_HANDLERS, applyPlacementSetup } from './block-placement-rules';
import { Raycast } from './raycast';
import { BlockHighlight } from './block-highlight';
import { BlockPlacer } from './block-placer';
import { BreakOverlay } from './break-overlay';
import { breakTime } from './block-hardness';
import { isTool, attackDamage } from './tools';
import { getBlockSound } from './block-sounds';
import { lockPointer } from './is-touch';
import type { ParticleSystem } from './particles';
import type { PlayerController } from './player';
import type { World } from './world';
import type { SoundManager } from './sound-manager';
import type { PauseMenu } from './pause-menu';

export type TargetBlock = {
  id: BlockId;
  position: THREE.Vector3;
  lightPosition: THREE.Vector3;
  normal: THREE.Vector3;
};

type MiningState = {
  pos: THREE.Vector3;
  id: BlockId;
  normal: THREE.Vector3;
  elapsed: number;
  total: number;
  /** False -> the block breaks but drops nothing (wrong / missing tool). */
  canHarvest: boolean;
};

const SWING_INTERVAL = 0.28;   // hand swings again this often while mining
const CHIP_INTERVAL = 0.18;    // dig particles + tick sound this often while mining

const EAT_DURATION = 1.6;      // seconds to finish eating (LCE: 32 ticks)
const EAT_TICK = 0.175;        // chew sound + crumb particles this often while eating (twice per old tick)

const BOW_MAX_DRAW = 1.0;      // seconds to fully draw (LCE MAX_DRAW_DURATION = 20 ticks = 1s)
const BOW_MIN_POWER = 0.1;     // below this, releasing does nothing (LCE BowItem::releaseUsing)

/** The 6 face neighbours, for sampling the light that actually falls on a block. */
const NEIGHBOR_OFFSETS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * Block interaction controller.
 * Orchestrates raycast, highlight, progressive breaking, and placing.
 */
export class BlockInteraction {
  private readonly raycast: Raycast;
  private readonly highlight: BlockHighlight;
  private readonly breakOverlay = new BreakOverlay();
  private readonly placer: BlockPlacer;
  private isPlaying = false;      // pointer-locked (desktop)
  private touchActive = false;    // on-screen touch controls engaged (mobile)
  /** Freeform touch aim point in NDC (-1..1), or null when no finger is on the
   * look layer - loro's `updateFreeformPickDirection` equivalent: on touch,
   * the pick ray comes from wherever the finger actually is, not a fixed
   * centre crosshair, so there's nothing to aim with until a finger touches
   * down. */
  private touchAimNdc: THREE.Vector2 | null = null;
  private target: TargetBlock | null = null;
  private selectedBlock: BlockId | null = BlockId.OAK_PLANKS;
  /** Raw selected hotbar id (block or tool); drives mining speed / harvest. */
  private selectedItemId: number | null = null;

  private leftHeld = false;
  private mining: MiningState | null = null;
  private swingTimer = 0;
  private chipTimer = 0;

  private attackCooldown = 0;
  private static readonly ATTACK_COOLDOWN = 0.4;

  private rightHeld = false;
  private eating = false;
  private eatTime = 0;
  private eatTickTimer = 0;

  private drawingBow = false;
  private bowDrawTime = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly world: World,
    private readonly player: PlayerController,
    private readonly soundManager?: SoundManager,
    private readonly pauseMenu?: PauseMenu,
    private readonly onSwing?: () => void,
    private readonly onPlace?: () => void,
    private readonly particles?: ParticleSystem,
    private readonly onInteract?: (id: BlockId, pos: THREE.Vector3) => void,
    private readonly onDrop?: (id: number, count: number, pos: THREE.Vector3) => void,
    private readonly onEat?: (heal: number) => void,
    private readonly onEatProgress?: (t01: number) => void,
    private readonly canEat?: () => boolean,
    private readonly onDropSelected?: (all: boolean) => void,
    /** World brightness 0..15 at a block, to shade the break overlay. */
    private readonly getLight?: (x: number, y: number, z: number) => number,
    /** Nearest mob within reach along a ray, if any - checked ahead of block mining on left-click. */
    private readonly hitTestMob?: (origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => { mobId: number; distance: number } | null,
    private readonly attackMob?: (mobId: number, damage: number) => void,
    /** Spend uses on the held tool; the callback reports back whether it broke. */
    private readonly onToolUse?: (amount: number) => void,
    /** True if the player has at least one arrow to fire - gates starting a bow draw. */
    private readonly hasArrows?: () => boolean,
    /** Bow released with enough draw to fire: `power` 0..1 (LCE's post-curve draw strength). Consuming the arrow/durability is the caller's job. */
    private readonly onShootBow?: (power: number) => void,
  ) {
    this.raycast = new Raycast(4);
    this.highlight = new BlockHighlight();
    this.placer = new BlockPlacer();

    canvas.addEventListener('click', this.capturePointer);
    document.addEventListener('pointerlockchange', this.updatePointerState);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('contextmenu', this.preventContextMenu);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('blur', this.onMouseUp);
  }

  /** Gameplay input is live when the pointer is locked OR touch controls are on. */
  private get engaged() { return this.isPlaying || this.touchActive; }

  /** Enable the mobile input path (no pointer lock). */
  setTouchActive(active: boolean) {
    this.touchActive = active;
    if (!active) { this.leftHeld = false; this.rightHeld = false; this.touchAimNdc = null; this.cancelMining(); this.cancelEating(); this.cancelDrawingBow(); }
  }

  attachHighlight(scene: THREE.Scene) {
    this.highlight.attachToScene(scene);
    this.breakOverlay.attachToScene(scene);
  }

  update(delta: number) {
    if (this.attackCooldown > 0) this.attackCooldown -= delta;

    // Touch: no crosshair to fall back to - without a finger down there's
    // nothing to aim at (see touchAimNdc).
    const hit = (this.touchActive && !this.touchAimNdc) ? undefined : this.raycast.castRay(
      this.camera,
      this.world.getMeshObjects(),
      (x, y, z) => this.world.getBlock(x, y, z),
      this.touchActive ? this.touchAimNdc! : undefined,
    );

    if (!hit) {
      this.target = null;
      this.highlight.hideTarget();
    } else {
      const { blockPosition } = hit;
      const normal = (hit.intersection.face?.normal ?? new THREE.Vector3()).clone();
      const lightPosition = blockPosition.clone().add(normal).round();
      const id = this.world.getBlock(blockPosition.x, blockPosition.y, blockPosition.z);
      this.target = { position: blockPosition, lightPosition, id, normal };
      this.highlight.updateTarget(blockPosition, id, shapeBoxesFor(
        id, blockPosition.x, blockPosition.y, blockPosition.z,
        (x, y, z) => this.world.getBlock(x, y, z),
        (x, y, z) => this.world.getBlockData(x, y, z),
      ));
    }

    this.updateMining(delta);
    this.updateEating(delta);
    this.updateDrawingBow(delta);
    this.updateAttackSwing(delta);
  }

  /** MC behaviour: holding the attack button swings the hand on a fixed cadence,
   *  whether or not it's actually breaking a block (air, unbreakable, wrong tool). */
  private updateAttackSwing(delta: number) {
    if (this.leftHeld && this.engaged) {
      this.swingTimer += delta;
      if (this.swingTimer >= SWING_INTERVAL) {
        this.swingTimer -= SWING_INTERVAL;
        this.onSwing?.();
      }
    } else {
      this.swingTimer = 0;
    }
  }

  /** World brightness 0..1 at (rounded) `p`, for shading particles/overlay. */
  private lightAt(p: THREE.Vector3): number {
    return (this.getLight?.(Math.round(p.x), Math.round(p.y), Math.round(p.z)) ?? 15) / 15;
  }

  /**
   * Brightness 0..1 *around* a block, for shading its crack overlay and the
   * chips flying off it. Sampling the block's own cell returns 0 - a solid
   * block holds no sky/block light inside itself - which tinted every break
   * particle pure black; the light that actually falls on the block is the
   * light in the open cells next to it.
   */
  private blockSurfaceLight(p: THREE.Vector3): number {
    if (!this.getLight) return 1;
    const x = Math.round(p.x), y = Math.round(p.y), z = Math.round(p.z);
    let best = this.getLight(x, y, z);
    for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
      best = Math.max(best, this.getLight(x + dx, y + dy, z + dz));
    }
    return best / 15;
  }

  // --- Eating -------------------------------------------------------------

  private startEating() {
    if (this.eating) return;
    if (foodValue(this.selectedItemId) <= 0) return;
    if (this.canEat && !this.canEat()) return;
    this.eating = true;
    this.eatTime = 0;
    this.eatTickTimer = 0;
  }

  private cancelEating() {
    if (!this.eating) return;
    this.eating = false;
    this.eatTime = 0;
    this.onEatProgress?.(0);
  }

  private updateEating(delta: number) {
    if (!this.eating) return;

    // Bail if the held item stopped being food (slot changed) or a GUI opened.
    if (foodValue(this.selectedItemId) <= 0 || !this.engaged) {
      this.cancelEating();
      return;
    }

    this.eatTime += delta;
    this.onEatProgress?.(THREE.MathUtils.clamp(this.eatTime / EAT_DURATION, 0, 1));

    this.eatTickTimer += delta;
    if (this.eatTickTimer >= EAT_TICK) {
      this.eatTickTimer -= EAT_TICK;
      this.soundManager?.playRandom('player/Eat', 3, 0.7);
      const mouth = this.camera.getWorldPosition(new THREE.Vector3());
      const down = new THREE.Vector3(0, -1, 0);
      this.camera.getWorldDirection(down);
      down.y -= 0.6;
      down.normalize();
      mouth.addScaledVector(down, 0.35);
      this.particles?.eat(mouth, down, this.selectedItemId ?? 0, this.lightAt(mouth));
    }

    if (this.eatTime >= EAT_DURATION) {
      const heal = foodValue(this.selectedItemId);
      this.eating = false;
      this.eatTime = 0;
      this.onEatProgress?.(0);
      this.onEat?.(heal);
    }
  }

  // --- Bow -----------------------------------------------------------------

  private startDrawingBow() {
    if (this.drawingBow) return;
    if (this.hasArrows && !this.hasArrows()) return;
    this.drawingBow = true;
    this.bowDrawTime = 0;
  }

  /** Stops the draw without firing - lost focus, GUI opened, item changed. */
  private cancelDrawingBow() {
    if (!this.drawingBow) return;
    this.drawingBow = false;
    this.bowDrawTime = 0;
  }

  private updateDrawingBow(delta: number): void {
    if (!this.drawingBow) return;
    if (this.selectedItemId !== ItemId.BOW || !this.engaged) {
      this.cancelDrawingBow();
      return;
    }
    this.bowDrawTime += delta;
  }

  /**
   * LCE BowItem::releaseUsing: pow = timeHeld/MAX_DRAW_DURATION, smoothed by
   * `(pow^2 + pow*2) / 3`, clamped to [0,1] - below BOW_MIN_POWER the release
   * is too quick to count as a shot at all.
   */
  private releaseBow() {
    if (!this.drawingBow) return;
    this.drawingBow = false;
    let pow = THREE.MathUtils.clamp(this.bowDrawTime / BOW_MAX_DRAW, 0, 1);
    pow = (pow * pow + pow * 2) / 3;
    this.bowDrawTime = 0;
    if (pow < BOW_MIN_POWER) return;
    this.onShootBow?.(Math.min(pow, 1));
  }

  getTargetBlock() {
    return this.target;
  }

  /** The selected hotbar item; only blocks become placeable (`selectedBlock`). */
  selectBlock(id: number | null) {
    this.selectedItemId = id;
    this.selectedBlock = isBlock(id) ? (id as BlockId) : null;
  }

  // --- Mobs -------------------------------------------------------------

  /** If a mob is the nearest thing on the crosshair (closer than any targeted block), hit it and return true. */
  private attackNearestMob(): boolean {
    if (!this.hitTestMob || this.attackCooldown > 0) return false;
    if (this.touchActive && !this.touchAimNdc) return false;
    let origin: THREE.Vector3;
    let dir: THREE.Vector3;
    if (this.touchActive) {
      const ray = this.raycast.rayFromNdc(this.camera, this.touchAimNdc!);
      origin = ray.origin;
      dir = ray.direction;
    } else {
      origin = new THREE.Vector3();
      dir = new THREE.Vector3();
      this.camera.getWorldPosition(origin);
      this.camera.getWorldDirection(dir);
    }
    const mobHit = this.hitTestMob(origin, dir, 4);
    if (!mobHit) return false;
    if (this.target) {
      const blockDist = origin.distanceTo(this.target.position);
      if (blockDist < mobHit.distance) return false;
    }
    this.attackMob?.(mobHit.mobId, attackDamage(this.selectedItemId));
    // LCE DiggerItem::hurtEnemy - hitting something costs two uses, not one.
    if (isTool(this.selectedItemId)) this.onToolUse?.(2);
    this.attackCooldown = BlockInteraction.ATTACK_COOLDOWN;
    return true;
  }

  // --- Mining ---------------------------------------------------------------

  private canMine(id: BlockId): boolean {
    return id !== BlockId.AIR && Number.isFinite(breakTime(id, this.selectedItemId).time);
  }

  private startMining() {
    if (!this.target || !this.canMine(this.target.id)) return;
    const id = this.target.id;
    const { time, canHarvest } = breakTime(id, this.selectedItemId);

    if (time <= 0) {
      this.finishMining(this.target.position.clone(), id, canHarvest);
      return;
    }
    this.mining = {
      pos: this.target.position.clone(),
      id,
      normal: this.target.normal.clone(),
      elapsed: 0,
      total: time,
      canHarvest,
    };
    this.chipTimer = CHIP_INTERVAL;
  }

  private cancelMining() {
    this.mining = null;
    this.breakOverlay.hide();
  }

  private finishMining(pos: THREE.Vector3, id: BlockId, canHarvest: boolean) {
    const light = this.blockSurfaceLight(pos);
    if (id === BlockId.FURNACE) {
      // Spill the furnace's contents before the block (and its data) are gone.
      const f = this.world.getBlockData(pos.x, pos.y, pos.z)?.furnace;
      for (const slot of [f?.input, f?.fuel, f?.output]) {
        if (slot?.id != null && slot.count > 0) this.onDrop?.(slot.id, slot.count, pos.clone());
      }
    }
    const wasDouble = this.world.getBlockData(pos.x, pos.y, pos.z)?.double === true;
    this.world.remove(pos.x, pos.y, pos.z);
    this.particles?.burst(pos, id, light);
    for (const drop of getDrops(id, canHarvest, wasDouble)) this.onDrop?.(drop.id, drop.count, pos.clone());
    const sound = getBlockSound(id, 'dig');
    if (sound) this.soundManager?.playSound(sound);
    // LCE DiggerItem::mineBlock - one use per block actually broken.
    if (isTool(this.selectedItemId)) this.onToolUse?.(1);
    this.mining = null;
    this.breakOverlay.hide();
  }

  private updateMining(delta: number) {
    if (!this.mining) {
      this.breakOverlay.hide();
      // Hold-to-continue: start on the next block once it's targeted.
      if (this.leftHeld && this.target && this.canMine(this.target.id)) this.startMining();
      return;
    }

    const t = this.target;
    const sameBlock =
      !!t && t.id === this.mining.id &&
      t.position.x === this.mining.pos.x &&
      t.position.y === this.mining.pos.y &&
      t.position.z === this.mining.pos.z;

    if (!sameBlock) {
      // Looking elsewhere: retarget if still holding & breakable, else stop.
      if (this.leftHeld && t && this.canMine(t.id)) this.startMining();
      else this.cancelMining();
      return;
    }

    this.mining.elapsed += delta;
    const light = this.blockSurfaceLight(this.mining.pos);
    this.breakOverlay.setProgress(this.mining.pos, this.mining.elapsed / this.mining.total, shapeBoxesFor(
      this.mining.id, this.mining.pos.x, this.mining.pos.y, this.mining.pos.z,
      (x, y, z) => this.world.getBlock(x, y, z),
      (x, y, z) => this.world.getBlockData(x, y, z),
    ));

    this.chipTimer += delta;
    if (this.chipTimer >= CHIP_INTERVAL) {
      this.chipTimer -= CHIP_INTERVAL;
      this.particles?.mine(this.mining.pos, this.mining.normal, this.mining.id, light);
      const mineSound = getBlockSound(this.mining.id, 'mine') ?? getBlockSound(this.mining.id, 'hit');
      if (mineSound) this.soundManager?.playSound(mineSound, 0.5);
    }

    if (this.mining.elapsed >= this.mining.total) {
      this.finishMining(this.mining.pos.clone(), this.mining.id, this.mining.canHarvest);
    }
  }

  // --- Input --------------------------------------------------------------

  private onMouseDown = (event: MouseEvent) => {
    if (!this.isPlaying || (event.button !== 0 && event.button !== 2)) return;

    if (event.button === 0) {
      this.leftHeld = true;
      this.onSwing?.(); // MC/LCE swing even at air
      this.swingTimer = 0; // next auto-swing a full interval after this one
      if (this.attackNearestMob()) return;
      this.startMining();
      return;
    }

    this.rightHeld = true;
    this.useHeld();
  };

  /** Right-click / touch-tap: eat, open an interactive block, or place. */
  private useHeld() {
    // Holding a bow: start the draw instead of placing / interacting.
    if (this.selectedItemId === ItemId.BOW) {
      this.startDrawingBow();
      return;
    }

    // Holding a food item: start eating instead of placing / interacting.
    if (foodValue(this.selectedItemId) > 0 && (!this.canEat || this.canEat())) {
      this.startEating();
      return;
    }

    if (this.touchActive && !this.touchAimNdc) return;
    const hit = this.raycast.castRay(
      this.camera,
      this.world.getMeshObjects(),
      (x, y, z) => this.world.getBlock(x, y, z),
      this.touchActive ? this.touchAimNdc! : undefined,
    );
    if (!hit || !hit.intersection.face) return;

    // Right-clicking an interactive block (crafting table) opens its GUI instead of placing.
    const clicked = this.world.getBlock(hit.blockPosition.x, hit.blockPosition.y, hit.blockPosition.z);
    if (isInteractive(clicked)) {
      this.onInteract?.(clicked, hit.blockPosition.clone());
      return;
    }

    // Fence gate: right-click swings it open/closed instead of placing
    // against it or interacting with a GUI (LCE FenceGateTile::use).
    if (isToggleable(clicked)) {
      const b = hit.blockPosition;
      const data = this.world.getBlockData(b.x, b.y, b.z);
      this.world.setBlockData(b.x, b.y, b.z, { ...data, open: !data?.open });
      this.onSwing?.();
      const sound = getBlockSound(BlockId.OAK_PLANKS, 'dig');
      if (sound && this.soundManager) this.soundManager.playSound(sound, 0.8);
      return;
    }

    // Item-specific right-click behaviour (flint & steel, ...) tried before
    // the generic interact/toggle/place flow below.
    if (this.selectedItemId != null && USE_HANDLERS[this.selectedItemId]?.({
      world: this.world, hit, onSwing: this.onSwing, onToolUse: this.onToolUse, soundManager: this.soundManager,
    })) {
      return;
    }

    // Torches can't hang from a ceiling.
    if (this.selectedBlock === BlockId.TORCH && hit.intersection.face.normal.y < -0.5) return;

    // Slab onto its matching other half -> one full block. LCE
    // StoneSlabTileItem::useOn merges only on the face pointing into the
    // slab's empty half: the top face of a bottom slab, or the bottom face
    // of a top one.
    if (this.selectedBlock != null && isSlab(this.selectedBlock) && clicked === this.selectedBlock) {
      const b = hit.blockPosition;
      const data = this.world.getBlockData(b.x, b.y, b.z);
      const isUpper = data?.half === 'top';
      const ny = hit.intersection.face?.normal.y ?? 0;
      const fillsEmptyHalf = (ny > 0.5 && !isUpper) || (ny < -0.5 && isUpper);
      if (!data?.double && fillsEmptyHalf) {
        this.world.setBlockData(b.x, b.y, b.z, { ...data, half: 'bottom', double: true });
        this.onSwing?.();
        this.onPlace?.();
        const sound = getBlockSound(this.selectedBlock, 'place') ?? getBlockSound(this.selectedBlock, 'dig');
        if (sound && this.soundManager) this.soundManager.playSound(sound);
        return;
      }
    }

    let placedAt: THREE.Vector3 | null = null;
    const placed = this.placer.placeBlock(
      hit.blockPosition,
      hit.intersection.face.normal,
      this.selectedBlock,
      (x, y, z) => this.world.getBlock(x, y, z),
      (x, y, z) => this.player.intersectsBlock(x, y, z),
      (x, y, z, id) => {
        const ok = this.world.add(x, y, z, id);
        if (ok) placedAt = new THREE.Vector3(x, y, z);
        return ok;
      },
    );
    if (placed) {
      // Snapshot BEFORE onPlace(): consumeSelected() can empty the hotbar slot
      // (placing your last block of a stack) and that fires onSelect(null),
      // which nulls this.selectedBlock out from under the code below — losing
      // the furnace's facing, the torch's floor/wall pick, and the place sound
      // every time you placed the last one in a stack.
      const placedBlockId = this.selectedBlock;
      this.onSwing?.();
      this.onPlace?.();
      if (placedAt && placedBlockId != null) {
        applyPlacementSetup({ world: this.world, player: this.player, hit, placedPos: placedAt }, placedBlockId);
      }
      if (placedBlockId) {
        const sound = getBlockSound(placedBlockId, 'place') ?? getBlockSound(placedBlockId, 'dig');
        if (sound && this.soundManager) this.soundManager.playSound(sound);
      }
    }
  }

  // --- Touch input (mobile) ---------------------------------------------------

  /** Drag on the canvas: rotate the view. `dx`/`dy` are pixel deltas. */
  touchLook(dx: number, dy: number) {
    const sensitivity = (this.pauseMenu?.touchSensitivity ?? 100) / 100;
    this.player.look(dx * sensitivity, dy * sensitivity);
  }

  /** Finger on the world layer, at (clientX, clientY): freeform aim point
   * (LCE Android / loro's freeform pick mode) - the pick ray comes from
   * wherever the finger actually is on screen, not a fixed centre crosshair. */
  touchAimMove(clientX: number, clientY: number) {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.touchAimNdc = this.touchAimNdc ? this.touchAimNdc.set(ndcX, ndcY) : new THREE.Vector2(ndcX, ndcY);
  }

  /** Touch-down on a mob: hit it immediately, same as a desktop click - unlike
   * breaking a block, attacking must not wait for the hold-to-break delay. */
  touchTryAttack(): boolean {
    if (!this.touchActive) return false;
    if (!this.attackNearestMob()) return false;
    this.onSwing?.();
    this.swingTimer = 0;
    return true;
  }

  /** Finger lifted off the world layer: nothing left to aim at. */
  touchAimEnd() {
    this.touchAimNdc = null;
    this.target = null;
    this.highlight.hideTarget();
  }

  /** Tap on the world: place a block / use the held item (LCE Android). */
  touchTapPlace() {
    if (!this.touchActive) return;
    this.useHeld();
  }

  /** Finger held on the world: start breaking the targeted block. */
  touchBreakStart() {
    if (!this.touchActive) return;
    this.leftHeld = true;
    this.onSwing?.();
    this.swingTimer = 0;
    if (this.attackNearestMob()) return;
    this.startMining();
  }

  /** Finger lifted: stop breaking. */
  touchBreakEnd() {
    this.leftHeld = false;
    this.cancelMining();
  }

  private onMouseUp = (event?: Event) => {
    if (event && event.type === 'mouseup') {
      const button = (event as MouseEvent).button;
      if (button === 2) {
        this.rightHeld = false;
        this.cancelEating();
        this.releaseBow();
        return;
      }
      if (button !== 0) return;
    } else {
      // blur / pointerlock exit: release everything, but don't let a lost-focus
      // moment fire off a shot - cancel the draw instead of releasing it.
      this.rightHeld = false;
      this.cancelEating();
      this.cancelDrawingBow();
    }
    this.leftHeld = false;
    this.cancelMining();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Digit1' || event.code === 'Numpad1') this.selectedBlock = BlockId.OAK_PLANKS;
    if (event.code === 'Digit2' || event.code === 'Numpad2') this.selectedBlock = BlockId.GLOWSTONE;
    if (event.code === 'Digit3' || event.code === 'Numpad3') this.selectedBlock = BlockId.WATER;
    // Q: throw the selected stack into the world (Ctrl+Q throws the whole stack).
    if (event.code === 'KeyQ' && this.engaged && !event.repeat) this.onDropSelected?.(event.ctrlKey);
  };

  private capturePointer = () => lockPointer(this.canvas);
  private updatePointerState = () => {
    this.isPlaying = document.pointerLockElement === this.canvas;
    if (!this.isPlaying) this.onMouseUp();
  };
  private onMouseMove = (event: MouseEvent) => {
    if (this.isPlaying) {
      const sensitivity = (this.pauseMenu?.mouseSensitivity ?? 30) / 100;
      this.player.look(event.movementX * sensitivity, event.movementY * sensitivity);
    }
  };
  private preventContextMenu = (event: MouseEvent) => event.preventDefault();
}

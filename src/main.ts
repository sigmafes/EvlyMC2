import * as THREE from 'three';
import './style.css';
import { BlockId, createBlockMaterials } from './block';
import { Diagnostics } from './diagnostics';
import { BlockInteraction } from './interaction';
import { PlayerController } from './player';
import { PlayerModel } from './player-model';
import { World } from './world';
import { DebugOverlay } from './debug';
import { TerrainNoise } from './terrain-noise';
import { LightEngine } from './light-engine';
import { LavaEngine, WaterEngine } from './water-engine';
import { FireEngine } from './fire-engine';
import { BlockInspector } from './block-inspector';
import { PauseMenu } from './pause-menu';
import { Inventory } from './inventory';
import { Hud } from './hud';
import { ParticleSystem } from './particles';
import { AmbientSoundEngine } from './ambient-sound';
import { WorldMusic } from './world-music';
import { DroppedItems } from './dropped-items';
import { FurnaceManager } from './furnace';
import { PlayerAir } from './player-air';
import { InventoryDoll } from './inventory-doll';
import { FirstPersonHand } from './first-person-hand';
import { PlayerHealth } from './player-health';
import { loadPlayerSave, savePlayerSave } from './player-store';
import { playClick } from './ui-sound';
import { BLOCK_CATALOG } from './creative-palette';
import { ITEMS, maxStackOf } from './item';
import { CraftingTableUI } from './crafting-table-ui';
import { FurnaceUI } from './furnace-ui';
import { TouchControls } from './touch-controls';
import { lockPointer } from './is-touch';
import { keepFullscreenOnGesture, linkPwaManifest } from './fullscreen';
import { makeStack } from './item-stack';
import { DayNightCycle } from './day-night-cycle';
import { SkyRenderer } from './sky-renderer';
import { Chat } from './chat';
import { UnderwaterManager } from './underwater-manager';
import { GameLoop } from './game-loop';
import { SoundManager } from './sound-manager';
import { MainMenu } from './main-menu';
import { playIntro } from './intro';
import { loadSettings } from './settings';
import { activeWorld } from './worlds';

async function startGame() {
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
keepFullscreenOnGesture();
linkPwaManifest();
const diagnosticsPanel = document.querySelector<HTMLElement>('#diagnostics-panel')!;
const underwaterOverlay = document.querySelector<HTMLElement>('#underwater-overlay')!;
const scene = new THREE.Scene();
const daySkyColor = new THREE.Color(0x8cb9ff);
const nightSkyColor = new THREE.Color(0x020017);
const skyColor = daySkyColor.clone();
const fog = new THREE.Fog(skyColor, 18, 42);
scene.background = skyColor;
scene.fog = fog;

// far plane pushed out so the sky dome (sun/moon/stars/clouds) is never clipped;
// terrain still fades well before it via THREE.Fog.
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

/** The actually-visible viewport. On mobile innerHeight lags the toolbar
 *  show/hide, so prefer visualViewport when it is available. */
function viewportSize() {
  const vv = window.visualViewport;
  return {
    w: Math.max(1, Math.round(vv?.width ?? window.innerWidth)),
    h: Math.max(1, Math.round(vv?.height ?? window.innerHeight)),
  };
}
{
  const { w, h } = viewportSize();
  // updateStyle=false: the CSS (#game-canvas fills #game-shell @ 100dvh) owns
  // the display size, so there is never an inline height that disagrees with
  // the layout and leaves a black strip.
  renderer.setSize(w, h, false);
}
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

// World seed: reused for every deterministic generation pass (terrain, caves,
// ores, trees). Persisted so reloading returns to the same world.
const SEED_KEY = 'evlymc-world-seed';
let worldSeed = Number(localStorage.getItem(SEED_KEY));
if (!Number.isFinite(worldSeed) || worldSeed === 0) {
  worldSeed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  try { localStorage.setItem(SEED_KEY, String(worldSeed)); } catch { /* private mode */ }
}

const terrainNoise = new TerrainNoise(worldSeed);
const soundManager = new SoundManager();
await soundManager.initialize();
// droppedItems is constructed later (needs `world`); this indirection lets
// World's constructor take the drop callback right away, same as soundManager.
let spawnDrop: ((id: number, count: number, pos: THREE.Vector3) => void) | undefined;
const world = new World(scene, createBlockMaterials(), terrainNoise, worldSeed, soundManager, (id, count, pos) => spawnDrop?.(id, count, pos));
await world.loadPersistedEdits(); // apply saved builds before any chunk is generated
const lightEngine = new LightEngine(world);
world.attachLightEngine(lightEngine);
const waterEngine = new WaterEngine(world);
world.attachWaterEngine(waterEngine);
const lavaEngine = new LavaEngine(world);
world.attachLavaEngine(lavaEngine);
const fireEngine = new FireEngine(world);
world.attachFireEngine(fireEngine);
let player!: PlayerController;
player = new PlayerController(
  camera,
  () => world.getCollidersInBounds(
    player.state.position.x - 1,
    player.state.position.x + 1,
    player.state.position.y - 2,
    player.state.position.y + 1,
    player.state.position.z - 1,
    player.state.position.z + 1,
  ),
  world.bounds,
  (x, y, z) => world.getBlock(x, y, z) === BlockId.WATER,
  (x, y, z) => world.getWaterFlow(x, y, z),
  (x, y, z) => world.getBlock(x, y, z) === BlockId.ICE,
  (x, y, z) => world.getBlock(x, y, z),
  soundManager,
);
// Dry-land spawn: (0, 0) is frequently ocean, so the world picks the nearest
// solid-ground column. Deterministic per seed, so it survives reloads.
const SPAWN = world.findSpawnPoint();
player.setSpawn(SPAWN.x, SPAWN.y, SPAWN.z);
const playerModel = new PlayerModel();
scene.add(playerModel.getGroup());
let viewBobOn = true;
const pauseMenu = new PauseMenu(
  camera,
  scene,
  fog,
  (enabled) => world.setSmoothLighting(enabled),
  (slim) => { playerModel.setSlimArms(slim); inventoryDoll.setSlim(slim); hand.setSlim(slim); },
  (chunks) => world.setViewRadius(chunks),
  () => { void leaveWorld(); },
  (on) => { viewBobOn = on; player.setViewBobEnabled(on); },
);

// Save everything and return to the main menu (skipping the intro on reload).
async function leaveWorld() {
  worldMusic.stop();
  await droppedItems.flush();
  droppedItems.clear();
  persistPlayer();
  await world.flushEdits();
  try { sessionStorage.setItem('evlymc-skip-intro', '1'); } catch { /* private mode */ }
  location.reload();
}

// Apply persisted options (from the main-menu Options screen).
const menuSettings = loadSettings();
camera.fov = menuSettings.fov;
camera.updateProjectionMatrix();
world.setViewRadius(menuSettings.renderDistance);
world.setSmoothLighting(menuSettings.smoothLighting);
playerModel.setSlimArms(menuSettings.alexSkin);
if (!menuSettings.fog) scene.fog = null;
pauseMenu.mouseSensitivity = menuSettings.sensitivity;
viewBobOn = menuSettings.viewBob;
player.setViewBobEnabled(menuSettings.viewBob);
pauseMenu.setViewBob(menuSettings.viewBob);
{
  const set = (sliderId: string, outId: string, v: number) => {
    const el = document.querySelector<HTMLInputElement>(`#${sliderId}`);
    const out = document.querySelector<HTMLOutputElement>(`#${outId}`);
    if (el) el.value = String(v);
    if (out) out.value = String(v);
  };
  set('fov-slider', 'fov-value', menuSettings.fov);
  set('sensitivity-slider', 'sensitivity-value', menuSettings.sensitivity);
  set('render-distance-slider', 'render-distance-value', menuSettings.renderDistance);
}

const particles = new ParticleSystem();
particles.attachToScene(scene);

const interaction = new BlockInteraction(
  canvas, camera, world, player, soundManager, pauseMenu,
  () => hand.swing(),
  () => { hand.bump(); inventory.consumeSelected(); },
  particles,
  (id, pos) => {
    if (id === BlockId.CRAFTING_TABLE) craftingTableUI.open();
    else if (id === BlockId.FURNACE) furnaceUI.open(pos);
  },
  (id, count, pos) => droppedItems.spawn(id, count, pos),
  (heal) => {
    playerHealth.heal(heal);
    hud.setHealth(playerHealth.current);
    soundManager.playOne('player/Burp', 0.7);
    inventory.consumeSelected();
  },
  (t) => hand.setEatProgress(t),
  () => true, // no hunger system: food may always be eaten (heal just clamps)
  (all) => {
    const stack = inventory.dropSelected(all);
    if (!stack || stack.id == null) return;
    const eye = player.state.position;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const from = eye.clone().addScaledVector(dir, 0.6);
    from.y -= 0.2;
    droppedItems.spawn(stack.id, stack.count ?? 1, from, dir);
  },
  (x, y, z) => lightEngine.getRawBrightness(x, y, z),
);
interaction.attachHighlight(scene);

// Per-world player save (position + inventory). Block edits persist separately.
const worldKey = activeWorld()?.id ?? `seed-${worldSeed}`;
const playerSave = loadPlayerSave(worldKey);

const inventoryDoll = new InventoryDoll();
inventoryDoll.setSlim(menuSettings.alexSkin);

const hand = new FirstPersonHand();
hand.setSlim(menuSettings.alexSkin);
hand.resize(window.innerWidth / window.innerHeight);

let inventoryOpen = false;
const inventory = new Inventory(
  (id) => { interaction.selectBlock(id); hand.setSlotById(id); playerModel.setHeldItem(id); },
  (open) => {
    inventoryOpen = open;
    player.setMovementLocked(open);
    inventoryDoll.setActive(open);
    if (!open) persistPlayer();
  },
);
const craftingTableUI = new CraftingTableUI(inventory, (open) => {
  inventoryOpen = open;
  player.setMovementLocked(open);
  if (!open) persistPlayer();
});
const furnaceUI = new FurnaceUI(inventory, world, (open) => {
  inventoryOpen = open;
  player.setMovementLocked(open);
  if (!open) persistPlayer();
});
const hud = new Hud();

// Block icons rendered during startup can come out dark before the shared
// offscreen WebGL context is warm — re-render them once the loop is running.
setTimeout(() => { inventory.refreshAll(); }, 300);
const ambient = new AmbientSoundEngine(soundManager, world);
const worldMusic = new WorldMusic(0.35);
worldMusic.start();

// LCE-style dropped items: broken blocks and Q-thrown stacks land here and get
// vacuumed back into the inventory when the player walks over them.
const NON_SOLID = new Set<number>([BlockId.AIR, BlockId.WATER, BlockId.LAVA, BlockId.FIRE]);
const droppedItems = new DroppedItems(
  scene,
  (x, y, z) => !NON_SOLID.has(world.getBlock(x, y, z)),
  (stack) => inventory.addItem(stack),
  () => soundManager.playOne('player/Pop', 0.4),
  worldSeed,
  (x, z) => world.isChunkLoaded(x, z),
);
spawnDrop = (id, count, pos) => droppedItems.spawn(id, count, pos);
await droppedItems.loadPersisted();

// Smelting: steps every lit/loaded furnace. Contents live in the block-data
// side table; the phase-5 GUI feeds it items.
const furnaceManager = new FurnaceManager(world);

// --- Health & death ---
const deathScreen = document.querySelector<HTMLElement>('#death-screen')!;
const playerHealth = new PlayerHealth(
  () => {
    deathScreen.hidden = false;
    document.exitPointerLock();
    ambient.stopAll();
    persistPlayer();
  },
  (cause) => {
    player.hurtImpulse();
    // Throttle the damage-over-time causes so the sound doesn't machine-gun.
    const now = performance.now();
    const gap = cause === 'fire' || cause === 'drown' ? 900 : 0;
    if (now - (lastHurtSoundAt[cause] ?? 0) < gap) return;
    lastHurtSoundAt[cause] = now;
    if (cause === 'fall') soundManager.playOne('player/Fall_damage', 0.7);
    else if (cause === 'fire') soundManager.playRandom('player/Player_fire', 3, 0.6);
    else if (cause === 'drown') soundManager.playRandom('player/Player_drowning', 3, 0.7);
    else soundManager.playRandom('player/Player_hurt', 3, 0.7);
  },
);
const lastHurtSoundAt: Record<string, number> = {};
let lavaTimer = 0;
let fireTimer = 0;

// Breath: drowning damage while the head is underwater (LCE Mob::aiStep).
const playerAir = new PlayerAir(() => {
  playerHealth.damage(2, { ignoreInvuln: true, cause: 'drown' });
  hud.setHealth(playerHealth.current);
});

function respawn() {
  playerHealth.reset();
  playerAir.reset();
  player.restore({ ...SPAWN, yaw: player.state.yaw, pitch: player.state.pitch });
  hud.setHealth(playerHealth.current);
  deathScreen.hidden = true;
  player.setMovementLocked(false);
  lockPointer(canvas);
}

document.querySelector<HTMLButtonElement>('#death-respawn')!.addEventListener('click', () => {
  playClick();
  respawn();
});
document.querySelector<HTMLButtonElement>('#death-title')!.addEventListener('click', () => {
  playClick();
  // Save the world at a clean spawn state, then return to the menu.
  playerHealth.reset();
  player.restore({ ...SPAWN, yaw: player.state.yaw, pitch: player.state.pitch });
  void leaveWorld();
});

function persistPlayer() {
  const inv = inventory.serialize();
  savePlayerSave(worldKey, {
    ...player.snapshot(),
    health: playerHealth.current,
    selectedIndex: inv.selectedIndex,
    slots: inv.slots,
    dayTime: dayNightCycle.getCycleTime(),
  });
}

if (playerSave) {
  const savedAlive = typeof playerSave.health !== 'number' || playerSave.health > 0;
  // Saved dead (or at 0) -> come back at spawn with full health, not where you died.
  player.restore(savedAlive ? playerSave : { ...SPAWN, yaw: playerSave.yaw, pitch: playerSave.pitch });
  inventory.load({ slots: playerSave.slots, selectedIndex: playerSave.selectedIndex });
  if (savedAlive && typeof playerSave.health === 'number') {
    playerHealth.current = Math.min(20, playerSave.health);
  }
}
hud.setHealth(playerHealth.current);

window.addEventListener('beforeunload', persistPlayer);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistPlayer();
});
setInterval(persistPlayer, 5000);
const diagnostics = new Diagnostics(diagnosticsPanel, renderer, world, player, lightEngine);
const blockInspector = new BlockInspector(document.querySelector<HTMLElement>('#block-inspector')!, interaction, world, lightEngine);
const debugOverlay = new DebugOverlay(scene, world, player);
const dayNightCycle = new DayNightCycle(scene, fog, lightEngine, world, daySkyColor, nightSkyColor);
if (playerSave?.dayTime != null) dayNightCycle.restoreTime(playerSave.dayTime);
const skyRenderer = new SkyRenderer(scene, camera);

const chat = new Chat({ canvas, onOpenChange: (open) => player.setMovementLocked(open) });
chat.cheatsEnabled = activeWorld()?.cheats ?? false;
const TIME_PHASES = ['day', 'night', 'sunset', 'sunrise'] as const;
chat.registerCommand('time', (args) => {
  if (args[0] === 'set' && (TIME_PHASES as readonly string[]).includes(args[1])) {
    dayNightCycle.setPhase(args[1] as (typeof TIME_PHASES)[number]);
    return `Set the time to ${args[1]}`;
  }
  return 'Usage: /time set day|night|sunset|sunrise';
});
chat.registerCommand('seed', () => `World seed: ${worldSeed}`);

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
chat.registerCommand('give', (args) => {
  if (args.length === 0) return 'Usage: /give <item|block> [count]';

  // Trailing pure-number argument is the count; the rest is the item name.
  let count = 1;
  let nameParts = args;
  const last = args[args.length - 1];
  if (args.length > 1 && /^\d+$/.test(last)) {
    count = Math.max(1, Math.min(6400, parseInt(last, 10)));
    nameParts = args.slice(0, -1);
  }
  const query = slugify(nameParts.join(' ').replace(/^minecraft:/, ''));

  let id: number | null = null;
  let label = '';
  for (const b of BLOCK_CATALOG) {
    if (slugify(b.name) === query || String(b.id) === query) { id = b.id; label = b.name; break; }
  }
  if (id == null) {
    for (const [key, def] of Object.entries(ITEMS)) {
      if (slugify(def.name) === query || key === query) { id = Number(key); label = def.name; break; }
    }
  }
  if (id == null) return `Unknown item: ${nameParts.join(' ')}`;

  const per = maxStackOf(id);
  let remaining = count;
  while (remaining > 0) {
    const take = Math.min(remaining, per);
    const leftover = inventory.addItem(makeStack(id, take));
    remaining -= take - leftover;
    if (leftover > 0) break;
  }
  const gave = count - remaining;
  return gave > 0 ? `Gave ${gave} × ${label}` : 'Inventory full';
});
const underwaterManager = new UnderwaterManager(camera, world, scene, fog, underwaterOverlay);
const gameLoop = new GameLoop(world, player, lightEngine, camera, canvas, scene, pauseMenu, dayNightCycle, underwaterManager);

// --- Mobile: on-screen touch controls (LCE Android-style) ---
const touchControls = TouchControls.isTouchDevice()
  ? new TouchControls({
      onMoveAxis: (x, z) => player.setMoveAxis(x, z),
      onJump: (held) => player.setJumpHeld(held),
      onSneak: (on) => player.setSneak(on),
      onSprint: (on) => player.setSprint(on),
      onLook: (dx, dy) => interaction.touchLook(dx, dy),
      onTapPlace: () => interaction.touchTapPlace(),
      onBreakStart: () => interaction.touchBreakStart(),
      onBreakEnd: () => interaction.touchBreakEnd(),
      onInventory: () => inventory.toggleInventory(),
      onThirdPerson: () => player.cycleCameraMode(),
      onChat: () => (chat.isOpen ? chat.closeInput() : chat.openInput()),
      onPause: () => pauseMenu.toggle(),
    })
  : null;
player.onSneakChange = (on) => touchControls?.setSneakVisual(on);

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  worldMusic.setPaused(pauseMenu.isPaused || playerHealth.isDead);

  if (touchControls) {
    const menuOpen = inventoryOpen || pauseMenu.isPaused || playerHealth.isDead;
    touchControls.setGameplayVisible(!menuOpen);
    interaction.setTouchActive(!menuOpen);
  }

  // Dead: freeze the world behind the death screen until Respawn / Title screen.
  if (playerHealth.isDead) {
    renderer.render(scene, camera);
    return;
  }

  // Simulation and world updates
  const loopState = gameLoop.update(delta, clock.elapsedTime);
  skyRenderer.update(loopState.dayNight.timeOfDay, delta);

  // --- Damage: fall on landing, plus lava/fire contact over time. ---
  if (!pauseMenu.isPaused) {
    playerHealth.tick(delta);
    droppedItems.update(delta, player.state.position, (x, y, z) => lightEngine.getRawBrightness(x, y, z));
    furnaceManager.tick(delta);

    if (player.consumeWaterEntry()) soundManager.playRandom('player/Water_splash', 2, 0.5);

    const fall = player.consumeFallImpact();
    if (fall > 3.5) {
      playerHealth.damage(Math.ceil(fall - 3), { cause: 'fall' });
      hud.setHealth(playerHealth.current);
    }

    const pp = player.state.position;
    const bx = Math.round(pp.x);
    const bz = Math.round(pp.z);
    const inLava =
      world.getBlock(bx, Math.round(pp.y - 1.4), bz) === BlockId.LAVA ||
      world.getBlock(bx, Math.round(pp.y - 0.6), bz) === BlockId.LAVA;
    const inFire =
      !inLava &&
      (world.getBlock(bx, Math.round(pp.y - 1.4), bz) === BlockId.FIRE ||
        world.getBlock(bx, Math.round(pp.y - 0.6), bz) === BlockId.FIRE);

    if (inLava) {
      lavaTimer += delta;
      if (lavaTimer >= 0.5) { lavaTimer -= 0.5; playerHealth.damage(2, { ignoreInvuln: true, cause: 'fire' }); hud.setHealth(playerHealth.current); }
    } else {
      lavaTimer = 0;
    }
    if (inFire) {
      fireTimer += delta;
      if (fireTimer >= 0.5) { fireTimer -= 0.5; playerHealth.damage(1, { ignoreInvuln: true, cause: 'fire' }); hud.setHealth(playerHealth.current); }
    } else {
      fireTimer = 0;
    }

    ambient.update(player.state.position, delta);
    playerAir.update(delta, loopState.underwater.isUnderwater);
    hud.setAir(playerAir.points, playerAir.full);
  }

  // Sync player model position and visibility with physics
  // Model is only visible in 3rd person (check if camera is not at player position)
  const cameraDistance = camera.position.distanceTo(player.state.position);
  playerModel.setVisible(cameraDistance > 0.5); // Show model if camera is far from player
  playerModel.getGroup().position.copy(player.state.position);
  // MC-style: body trails the movement direction, head points where the player looks.
  playerModel.setOrientation(
    player.state.yaw,
    player.state.pitch,
    player.state.velocity.x,
    player.state.velocity.z,
    delta,
  );
  // Crouch pose (before setAdjustments/walk anim so the offsets compose).
  playerModel.setSneaking(player.state.sneaking);
  playerModel.updateSneak(delta);
  playerModel.setAdjustments(pauseMenu.modelAdjustments);

  // Shade the model by the world light level where the player stands.
  const lp = player.state.position;
  const lightLevel = lightEngine.getRawBrightness(Math.round(lp.x), Math.round(lp.y), Math.round(lp.z));
  playerModel.setLightLevel(lightLevel / 15);

  // First-person hand: visible only in true first person, gameplay unobstructed.
  hand.setVisible(cameraDistance <= 0.5 && !pauseMenu.isPaused && !inventoryOpen);
  hand.update(delta, viewBobOn ? {
    phase: player.viewBob.phase,
    bob: player.viewBob.bob,
    tilt: player.viewBob.tilt,
    yaw: player.state.yaw,
    pitch: player.state.pitch,
    yawLag: player.viewBob.yawBob,
    pitchLag: player.viewBob.pitchBob,
  } : null);
  hand.setLightLevel(lightLevel / 15);

  // The camera is driven by PlayerController.updateCamera() (first/third person),
  // or by the free camera block below. Nothing to sync here.

  // Handle walking animation - only when player is moving
  const playerVelocity = player.state.velocity;
  const isMoving = Math.sqrt(playerVelocity.x ** 2 + playerVelocity.z ** 2) > 0.1;
  if (isMoving) {
    playerModel.startWalking();
  } else {
    playerModel.stopWalking();
  }
  playerModel.updateWalkingAnimation(delta);

  // UI and debug updates
  debugOverlay.update();
  interaction.update(delta);
  particles.update(delta);
  blockInspector.update();
  furnaceUI.update();
  chat.update(delta);

  // Rendering
  const renderStartedAt = performance.now();
  renderer.render(scene, camera);
  // Hand overlay: fresh depth buffer so it draws on top without clipping terrain.
  renderer.autoClear = false;
  renderer.clearDepth();
  hand.render(renderer);
  renderer.autoClear = true;
  const renderMs = performance.now() - renderStartedAt;

  // Diagnostics
  diagnostics.update(performance.now(), loopState.dayNight.cycleProgress * 100);
}

/** Shrink the inventory / crafting-table panels so they never overflow a small
 *  (phone) screen. Never scales past the desktop 1.18. */
function fitInventoryPanels() {
  const scale = Math.min(
    1.18,
    (window.innerWidth - 16) / 352,
    (window.innerHeight - 16) / 332,
  );
  for (const sel of ['#backpack', '#crafting-table', '#furnace']) {
    document.querySelector<HTMLElement>(sel)?.style.setProperty('--inv-scale', String(scale));
  }
}
fitInventoryPanels();

function applyViewport() {
  const { w, h } = viewportSize();
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  hand.resize(w / h);
  fitInventoryPanels();
}
window.addEventListener('resize', applyViewport);
window.addEventListener('orientationchange', applyViewport);
window.visualViewport?.addEventListener('resize', applyViewport);
applyViewport();

let dropDebug = false;
document.addEventListener('keydown', (event) => {
  if (event.code === 'KeyR' && !event.repeat) {
    dropDebug = !dropDebug;
    droppedItems.setDebug(dropDebug);
  }
});

// Make floating panels draggable
function makeFloatingPanelDraggable(panelId: string) {
  const panel = document.querySelector<HTMLElement>(`#${panelId}`)!;
  const header = panel.querySelector<HTMLElement>('header')!;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const loadPosition = () => {
    const saved = localStorage.getItem(`panel-position-${panelId}`);
    if (saved) {
      const { left, top } = JSON.parse(saved);
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
    }
  };

  const savePosition = () => {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(`panel-position-${panelId}`, JSON.stringify({
      left: rect.left,
      top: rect.top,
    }));
  };

  header.style.cursor = 'grab';
  header.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;
    header.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    panel.style.left = `${startLeft + deltaX}px`;
    panel.style.top = `${startTop + deltaY}px`;
    panel.style.right = 'auto';
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      savePosition();
      header.style.cursor = 'grab';
    }
  });

  loadPosition();
}

makeFloatingPanelDraggable('diagnostics-panel');
makeFloatingPanelDraggable('block-inspector');

camera.position.copy(player.state.position);
animate();
}

// Intro sequence, then the main menu. "Singleplayer" starts the game.
// Returning from a world via "Leave World" reloads the page and skips the intro.
function showMainMenu() {
  document.querySelector<HTMLElement>('#main-menu')!.hidden = false;
  new MainMenu({ onSingleplayer: () => { void startGame(); } });
}

let skipIntro = false;
try {
  skipIntro = sessionStorage.getItem('evlymc-skip-intro') === '1';
  if (skipIntro) sessionStorage.removeItem('evlymc-skip-intro');
} catch { /* private mode */ }

if (skipIntro) {
  document.querySelector<HTMLElement>('#intro')!.hidden = true;
  showMainMenu();
} else {
  await playIntro(showMainMenu);
}

import * as THREE from 'three';
import './style.css';
import { BlockId, createBlockMaterials, isSolidBlock } from './block';
import { CHUNK_SIZE } from './worldgen/constants';
import { initPreviewAtlases } from './block-preview';
import { Diagnostics } from './diagnostics';
import { BlockInteraction } from './interaction';
import { PlayerController } from './player';
import { PlayerModel } from './player-model';
import { loadPlayerName } from './player-skin';
import { isCapeAllowed } from './cape';
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
import { SmokeParticles } from './smoke-particles';
import { AmbientSoundEngine } from './ambient-sound';
import { WorldMusic } from './world-music';
import { DroppedItems } from './dropped-items';
import { FurnaceManager } from './furnace';
import { MobManager } from './mob-manager';
import { ArrowProjectiles, powerToSpeed } from './arrow-projectiles';
import { SKELETON_SHOT_POWER } from './mob-ai';
import { getFireFrameIndex } from './fire-overlay';
import { ItemId } from './item';
import { PlayerAir } from './player-air';
import { InventoryDoll } from './inventory-doll';
import { FirstPersonHand } from './first-person-hand';
import { PlayerHealth, type DamageOptions } from './player-health';
import { totalArmorValue, reduceDamageByArmor, armorHurtAmount } from './armor';
import { loadPlayerSave, savePlayerSave } from './player-store';
import { playClick } from './ui-sound';
import { CraftingTableUI } from './crafting-table-ui';
import { FurnaceUI } from './furnace-ui';
import { ChestUI } from './chest-ui';
import { ChestRenderer } from './chest-renderer';
import { TouchControls } from './touch-controls';
import { lockPointer } from './is-touch';
import { armAndroidBack } from './android-back';
import { keepFullscreenOnGesture, linkPwaManifest } from './fullscreen';
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
import { waitForAccessGate } from './access-gate';
import { createMobSpawning } from './mob-spawning';
import { registerGameChatCommands } from './chat-commands';
import { viewportSize, fitInventoryPanels, createApplyViewport, makeFloatingPanelDraggable } from './ui-layout';

// Closed-beta key screen: blocks here, before anything else (intro included)
// runs, until a valid name+key pair is submitted (or this browser already
// unlocked it earlier).
await waitForAccessGate();

/**
 * Set once startGame() below actually creates the singleplayer Chat instance
 * - which only happens if/when the player picks Singleplayer from the menu,
 * so this stays null for a session that goes straight to Multiplayer.
 * setSingleplayerChatEnabled() has to tolerate that (see its own comment).
 */
let singleplayerChat: Chat | null = null;

/**
 * Multiplayer runs alongside this same page (see multiplayer-game.ts's
 * disconnect(), which restores #game-shell rather than reloading, so a
 * session can go Singleplayer -> Multiplayer -> back without a reload) -
 * while it's active it needs sole ownership of the "T" key, or singleplayer's
 * own Chat, if one has been created, would steal every "T" press via its
 * document-level capture-phase listener before multiplayer-game.ts's own
 * chat ever sees it.
 */
export function setSingleplayerChatEnabled(on: boolean): void {
  singleplayerChat?.setEnabled(on);
}

/** Same story as singleplayerChat above, for PauseMenu's own "Tab" listener. */
let singleplayerPauseMenu: PauseMenu | null = null;

export function setSingleplayerPauseMenuEnabled(on: boolean): void {
  singleplayerPauseMenu?.setEnabled(on);
}

async function startGame() {
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
keepFullscreenOnGesture();
linkPwaManifest();
const diagnosticsPanel = document.querySelector<HTMLElement>('#diagnostics-panel')!;
const underwaterOverlay = document.querySelector<HTMLElement>('#underwater-overlay')!;
const fireScreenOverlay = document.querySelector<HTMLElement>('#fire-screen-overlay')!;
const scene = new THREE.Scene();
const daySkyColor = new THREE.Color(0x8cb9ff);
const nightSkyColor = new THREE.Color(0x020017);
const skyColor = daySkyColor.clone();
const fog = new THREE.Fog(skyColor, 18, 42);
scene.background = skyColor;
scene.fog = fog;

/**
 * Push the fog out as render distance grows, so a higher render distance
 * actually shows further before the world fades - it was previously fixed
 * at (18, 42) regardless of render distance, meaning a render distance of
 * 20 chunks looked exactly as foggy as one of 3. `far` stops one chunk
 * short of the real view edge (same margin the old fixed numbers left at
 * the default render distance) so pop-in at the fog line is hidden by fog
 * rather than by nothing.
 */
function applyFogDistanceFor(renderDistanceChunks: number): void {
  const far = Math.max(24, renderDistanceChunks * CHUNK_SIZE - CHUNK_SIZE);
  fog.near = far * 0.5;
  fog.far = far;
}

// far plane pushed out so the sky dome (sun/moon/stars/clouds) is never clipped;
// terrain still fades well before it via THREE.Fog.
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 2000);
camera.rotation.order = 'YXZ';
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

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
// Shared with ParticleSystem below, so break/mine chips sample the same
// already-loaded block textures instead of loading their own copies.
const blockMaterials = await createBlockMaterials();
await initPreviewAtlases(blockMaterials.atlas); // hotbar/dropped/held-item previews reuse the same atlases instead of loading textures a second time
const world = new World(scene, blockMaterials, terrainNoise, worldSeed, soundManager, (id, count, pos) => spawnDrop?.(id, count, pos));
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
playerModel.setCapeVisible(isCapeAllowed(loadPlayerName()));
scene.add(playerModel.getGroup());
let viewBobOn = true;
// touchControls is constructed later (needs `player`/`interaction`/etc.); this
// indirection lets PauseMenu's callback list be wired up right away.
let applyButtonOpacity: ((percent: number) => void) | undefined;
const pauseMenu = new PauseMenu(
  camera,
  scene,
  fog,
  (enabled) => world.setSmoothLighting(enabled),
  (slim) => { playerModel.setSlimArms(slim); inventoryDoll.setSlim(slim); hand.setSlim(slim); },
  (chunks) => { world.setViewRadius(chunks); applyFogDistanceFor(chunks); },
  () => { void leaveWorld(); },
  (on) => { viewBobOn = on; player.setViewBobEnabled(on); },
  (percent) => applyButtonOpacity?.(percent),
);
singleplayerPauseMenu = pauseMenu;

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
applyFogDistanceFor(menuSettings.renderDistance);
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

const particles = new ParticleSystem(blockMaterials);
particles.attachToScene(scene);
const smokeParticles = new SmokeParticles();
smokeParticles.attachToScene(scene);

// mobManager is constructed later (needs `world`/`spawnDrop`); same
// indirection pattern as spawnDrop/applyButtonOpacity above.
let hitTestMob: ((origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number) => { mobId: number; distance: number } | null) | undefined;
let attackMobFn: ((mobId: number, damage: number) => void) | undefined;
let hasArrowsFn: (() => boolean) | undefined;
let shootBowFn: ((power: number) => void) | undefined;
const interaction = new BlockInteraction(
  canvas, camera, world, player, soundManager, pauseMenu,
  () => { hand.swing(); playerModel.swingArm(); },
  () => { hand.bump(); inventory.consumeSelected(); },
  particles,
  (id, pos) => {
    if (id === BlockId.CRAFTING_TABLE) craftingTableUI.open();
    else if (id === BlockId.FURNACE) furnaceUI.open(pos);
    else if (id === BlockId.CHEST) chestUI.open(pos);
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
  (origin, dir, maxDist) => hitTestMob?.(origin, dir, maxDist) ?? null,
  (mobId, damage) => attackMobFn?.(mobId, damage),
  (amount) => {
    if (inventory.damageSelected(amount)) soundManager.playOne('player/break', 0.8);
  },
  () => hasArrowsFn?.() ?? false,
  (power) => shootBowFn?.(power),
  () => chestRenderer.getRaycastTargets(),
  () => inventory.quickEquipArmor(),
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
  (equipped) => {
    playerModel.setArmor(equipped);
    inventoryDoll.setArmor(equipped);
    hud.setArmor(totalArmorValue(equipped));
    soundManager.playRandom('items/Equip_armor', 3, 0.6);
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
// Keeps the chest's animated model in step with placement/breaking - see
// World.onBlockChanged's doc comment. Doesn't cover a chest placed in a
// PREVIOUS session reappearing on load (edits are replayed as raw chunk
// writes, not through add()/remove()) - a real follow-up, not wired yet.
const chestRenderer = new ChestRenderer(scene);
world.onBlockChanged = (x, y, z, id, oldId) => {
  if (oldId === BlockId.CHEST && id !== BlockId.CHEST) chestRenderer.despawn(x, y, z);
  else if (id === BlockId.CHEST && oldId !== BlockId.CHEST) chestRenderer.spawn(x, y, z, world.getBlockData(x, y, z)?.facing ?? 0);
};
const chestUI = new ChestUI(inventory, world, (open) => {
  inventoryOpen = open;
  player.setMovementLocked(open);
  if (!open) persistPlayer();
}, (x, y, z, open) => chestRenderer.setOpen(x, y, z, open), soundManager);
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

// Knockback dealt TO the player by a mob attack (zombie) - same magnitude
// as the knockback MobManager already applies to a mob the player hits
// (KNOCKBACK_SPEED/KNOCKBACK_UP in mob-manager.ts).
const PLAYER_KNOCKBACK_SPEED = 5;
const PLAYER_KNOCKBACK_UP = 4;

// Shared by any hostile-mob damage source (zombie melee, skeleton arrows):
// applies the hit, syncs the HUD heart bar (not automatic - a zombie hit
// landing was otherwise invisible on the HUD despite the value updating
// fine), and shoves the player away from wherever the hit came from (same
// feel as the knockback a hit mob already gets, KNOCKBACK_SPEED/UP in
// mob-manager.ts).
function hurtPlayerFromMob(damage: number, fromPos: THREE.Vector3): void {
  dealDamage(damage, { cause: 'generic' });
  hud.setHealth(playerHealth.current);
  const dx = player.state.position.x - fromPos.x;
  const dz = player.state.position.z - fromPos.z;
  player.applyKnockback(dx, dz, PLAYER_KNOCKBACK_SPEED, PLAYER_KNOCKBACK_UP);
}

// Mobs (PLAN-MOBS.md): models + wander/flee AI, health and drops - see
// mob-manager.ts. Spawned in via /summon for now, nothing places them on its own.
const mobManager = new MobManager(
  scene,
  (x, y, z) => isSolidBlock(world.getBlock(x, y, z)),
  (id, count, pos) => spawnDrop?.(id, count, pos),
  soundManager,
  (x, y, z) => world.getBlock(x, y, z) === BlockId.WATER,
  (pos) => {
    smokeParticles.burst(pos);
  },
  hurtPlayerFromMob,
  () => player.state.position,
  (fromPos, targetPos) => {
    // SKELETON_SHOT_POWER (mob-ai.ts) is the single source of truth for the
    // skeleton's shot speed - mob-ai.ts's arc-compensation math assumes this
    // exact value too, so they can't drift apart.
    const dir = targetPos.clone().sub(fromPos);
    const dist = dir.length();
    if (dist < 1e-6) return;
    dir.normalize().multiplyScalar(powerToSpeed(SKELETON_SHOT_POWER));
    // Fixed damage, independent of the shot's (buffed) speed - see
    // ArrowSpawnOptions.fixedDamage's doc comment.
    arrowProjectiles.spawn(fromPos, dir, { fromPlayer: false, fixedDamage: 2 });
  },
);
hitTestMob = (origin, dir, maxDist) => mobManager.raycastMobs(origin, dir, maxDist);
attackMobFn = (mobId, damage) => {
  mobManager.damage(mobId, damage, player.state.position);
};

const arrowProjectiles = new ArrowProjectiles({
  scene,
  isSolid: (x, y, z) => isSolidBlock(world.getBlock(x, y, z)),
  mobManager,
  getPlayerPos: () => player.state.position,
  getPlayerHitbox: () => player.getHitbox(),
  onHitPlayer: hurtPlayerFromMob,
  collect: (slot) => inventory.addItem(slot),
  onPickup: () => soundManager.playOne('player/Pop', 0.4),
  soundManager,
  getLight: (x, y, z) => lightEngine.getRawBrightness(x, y, z),
});
hasArrowsFn = () => inventory.countItem(ItemId.ARROW) > 0;
shootBowFn = (power) => {
  if (!inventory.removeItem(ItemId.ARROW, 1)) return;
  if (inventory.damageSelected(1)) soundManager.playOne('player/break', 0.8);
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const from = player.state.position.clone().addScaledVector(dir, 0.5);
  // *4, not *2 - a fully-drawn shot was falling noticeably short of vanilla's
  // reach; doubling the resulting speed (and thus range/impact) fixes that.
  dir.multiplyScalar(powerToSpeed(power * 4));
  arrowProjectiles.spawn(from, dir, { fromPlayer: true, crit: power >= 1 });
  soundManager.playOne('items/Bow_shoot', 0.9);
};

// --- Health & death ---
const deathScreen = document.querySelector<HTMLElement>('#death-screen')!;
let deathParticlesSpawned = false;
const playerHealth = new PlayerHealth(
  () => {
    deathScreen.hidden = false;
    document.exitPointerLock();
    // Dying shouldn't silence the game - ambience/music keep playing through
    // the death screen (previously ambient.stopAll() here cut fire/water/lava
    // loop sounds, and worldMusic.setPaused() below used to also check
    // playerHealth.isDead, pausing music too).
    persistPlayer();
    // Same death treatment as mobs (mob-manager.ts): topple + red tint, then
    // a smoke burst - shown in forced third-person while the camera slowly
    // pulls back from the death spot (see the playerHealth.isDead branch).
    deathParticlesSpawned = false;
    player.startDeathCamera();
    playerModel.startDeath();
    playerModel.setVisible(true); // forced third-person needs the body visible, even if it was hidden (first person) the instant before
    hand.setVisible(false); // the dead branch below never re-runs the normal first/third-person visibility toggle
    inventory.setDead(true); // no inventory to manage from a corpse - also force-closes it if it happened to be open
  },
  (cause) => {
    player.hurtImpulse();
    playerModel.hurt();
    // Throttle the damage-over-time causes so the sound doesn't machine-gun.
    // Fire's own tick cadence is 500ms (lavaTimer/fireTimer below) - a 900ms
    // gap here was longer than that, so it silently ate exactly every other
    // tick's sound (900 > 500 means only every 2nd tick clears the gap).
    // 400ms sits under the tick interval so every tick's sound plays.
    const now = performance.now();
    const gap = cause === 'fire' ? 400 : cause === 'drown' ? 900 : 0;
    if (now - (lastHurtSoundAt[cause] ?? 0) < gap) return;
    lastHurtSoundAt[cause] = now;
    // Fall damage plays BOTH the fall-specific thud and the same generic
    // "oof" hurt sound any other hit gets, not just the thud on its own.
    if (cause === 'fall') { soundManager.playOne('player/Fall_damage', 0.7); soundManager.playRandom('player/Player_hurt', 3, 0.7); }
    else if (cause === 'fire') soundManager.playRandom('player/Player_fire', 3, 0.6);
    else if (cause === 'drown') soundManager.playRandom('player/Player_drowning', 3, 0.7);
    else soundManager.playRandom('player/Player_hurt', 3, 0.7);
  },
);
/**
 * Every real damage source funnels through here instead of calling
 * playerHealth.damage() directly, so armor (LCE Mob::getDamageAfterArmorAbsorb
 * / Inventory::hurtArmor) is applied uniformly: reduces the amount that
 * actually lands, carries the fractional remainder into the next hit
 * (reduceDamageByArmor's `spill`), and spends durability on every equipped
 * piece independently. Drowning bypasses armor entirely, same as vanilla's
 * magic/drown damage sources.
 */
let armorSpill = 0;
function dealDamage(rawAmount: number, opts: DamageOptions = {}): void {
  if ((opts.cause ?? 'generic') === 'drown') {
    playerHealth.damage(rawAmount, opts);
    return;
  }
  const armorValue = totalArmorValue(inventory.getArmor().map((s) => s.id));
  if (armorValue > 0) {
    const { damage, spill } = reduceDamageByArmor(rawAmount, armorValue, armorSpill);
    armorSpill = spill;
    inventory.damageArmor(armorHurtAmount(rawAmount));
    playerHealth.damage(damage, opts);
  } else {
    playerHealth.damage(rawAmount, opts);
  }
}

const lastHurtSoundAt: Record<string, number> = {};
let lavaTimer = 0;
let fireTimer = 0;
// "on_fire" after-burn: still takes damage for a while after leaving contact
// with lava/fire, same idea as mob-manager.ts's fireTicksLeft.
const PLAYER_FIRE_AFTERBURN_TICKS = 8;
const PLAYER_FIRE_TICK_INTERVAL = 1;
let playerFireTicksLeft = 0;
let playerFireTickTimer = 0;
let playerOnFire = false;

// Breath: drowning damage while the head is underwater (LCE Mob::aiStep).
const playerAir = new PlayerAir(() => {
  dealDamage(2, { ignoreInvuln: true, cause: 'drown' });
  hud.setHealth(playerHealth.current);
});

function respawn() {
  playerHealth.reset();
  playerAir.reset();
  player.restore({ ...SPAWN, yaw: player.state.yaw, pitch: player.state.pitch });
  playerModel.resetDeath();
  hud.setHealth(playerHealth.current);
  deathScreen.hidden = true;
  player.setMovementLocked(false);
  lockPointer(canvas);
  // Dying while on fire must not carry the burn into the fresh spawn - clear
  // the after-burn counter/timer, not just the visual.
  lavaTimer = 0;
  fireTimer = 0;
  playerFireTicksLeft = 0;
  playerFireTickTimer = 0;
  playerOnFire = false;
  playerModel.setOnFire(false);
  inventory.setDead(false);
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
  playerModel.resetDeath();
  void leaveWorld();
});

function persistPlayer() {
  const inv = inventory.serialize();
  savePlayerSave(worldKey, {
    ...player.snapshot(),
    health: playerHealth.current,
    selectedIndex: inv.selectedIndex,
    slots: inv.slots,
    armor: inv.armor,
    dayTime: dayNightCycle.getCycleTime(),
  });
}

if (playerSave) {
  const savedAlive = typeof playerSave.health !== 'number' || playerSave.health > 0;
  // Saved dead (or at 0) -> come back at spawn with full health, not where you died.
  player.restore(savedAlive ? playerSave : { ...SPAWN, yaw: playerSave.yaw, pitch: playerSave.pitch });
  // Migrate the old flat "wool" item (id 135, retired when wool became a
  // real placeable block) out of saves made before that change, so it
  // doesn't sit there as a broken/unknown slot.
  const OLD_WOOL_ITEM_ID = 135;
  for (const slot of playerSave.slots) {
    if (slot && slot.id === OLD_WOOL_ITEM_ID) {
      slot.id = BlockId.WOOL;
      slot.name = 'Wool';
      slot.sideTexture = 'blocks/wool.png';
    }
  }
  inventory.load({ slots: playerSave.slots, selectedIndex: playerSave.selectedIndex, armor: playerSave.armor });
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
singleplayerChat = chat;
chat.cheatsEnabled = activeWorld()?.cheats ?? false;

const mobSpawning = createMobSpawning({ world, player, mobManager, dayNightCycle, lightEngine });
registerGameChatCommands(chat, { player, mobManager, dayNightCycle, worldSeed, renderer, scene, camera, inventory, mobSpawning });

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
      onAttackTry: () => interaction.touchTryAttack(),
      onAimMove: (x, y) => interaction.touchAimMove(x, y),
      onAimEnd: () => interaction.touchAimEnd(),
      onInventory: () => inventory.toggleInventory(),
      onThirdPerson: () => player.cycleCameraMode(),
      onChat: () => (chat.isOpen ? chat.closeInput() : chat.openInput()),
      onPause: () => pauseMenu.toggle(),
    })
  : null;
player.onSneakChange = (on) => touchControls?.setSneakVisual(on);
applyButtonOpacity = (percent) => touchControls?.setButtonOpacity(percent);
touchControls?.setButtonOpacity(menuSettings.buttonOpacity);

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  // Clamp: a minimized/backgrounded tab starves requestAnimationFrame, so the
  // first frame after it regains focus can report a multi-second delta -
  // enough to fling mobs (and, less dramatically, the player) through walls
  // in one physics step. Capping it keeps a stall from ever being worse than
  // a single slow frame.
  const delta = Math.min(clock.getDelta(), 0.1);

  worldMusic.setPaused(pauseMenu.isPaused);

  if (touchControls) {
    const menuOpen = inventoryOpen || pauseMenu.isPaused || playerHealth.isDead;
    touchControls.setGameplayVisible(!menuOpen);
    interaction.setTouchActive(!menuOpen);
    // Android's back gesture otherwise has nothing to catch (see
    // android-back.ts's doc comment) - a menu being open is exactly when a
    // back press should close it instead of backgrounding the app.
    if (menuOpen) armAndroidBack();
  }

  // Dead: gameplay (movement, mobs, damage) freezes behind the death screen,
  // but the death animation + camera boom-out (player.startDeathCamera() /
  // playerModel.startDeath(), fired from the onDeath callback above) keep
  // playing for DEATH_ZOOM-ish seconds before everything truly settles.
  if (playerHealth.isDead) {
    const toppled = playerModel.updateDeathAnimation(delta);
    if (toppled && !deathParticlesSpawned) {
      deathParticlesSpawned = true;
      const pos = playerModel.group.position.clone();
      pos.y += 0.9;
      smokeParticles.burst(pos);
      playerModel.setVisible(false);
    }
    player.updateDeathCamera(delta);
    smokeParticles.update(delta);
    renderer.render(scene, camera);
    return;
  }

  // Simulation and world updates
  const loopState = gameLoop.simulate(delta, clock.elapsedTime);
  // Frustum culling - camera-dependent, must reflect this exact frame's view
  // (see updateView()'s doc comment), so it's called separately every
  // rendered frame rather than folded into simulate().
  gameLoop.updateView();
  skyRenderer.update(loopState.dayNight.timeOfDay, delta);

  // --- Damage: fall on landing, plus lava/fire contact over time. ---
  if (!pauseMenu.isPaused) {
    playerHealth.tick(delta);
    droppedItems.update(delta, player.state.position, (x, y, z) => lightEngine.getRawBrightness(x, y, z));
    furnaceManager.tick(delta);
    mobManager.update(
      delta,
      (x, y, z) => lightEngine.getRawBrightness(x, y, z),
      player.state.position,
      (x, y, z) => lightEngine.getSkyExposure(x, y, z),
      (x, y, z) => world.getBlock(x, y, z),
    );

    mobSpawning.update(delta);
    arrowProjectiles.update(delta);

    if (player.consumeWaterEntry()) soundManager.playRandom('player/Water_splash', 2, 0.5);

    const fall = player.consumeFallImpact();
    if (fall > 3.5) {
      dealDamage(Math.ceil(fall - 3), { cause: 'fall' });
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
      // lavaTimer is exactly 0 only on the very first frame of contact (the
      // "else" branch below resets it the instant contact is lost) - jump it
      // straight to the tick threshold so that first frame damages
      // immediately instead of waiting out a full 0.5s tick before the first hit.
      if (lavaTimer === 0) lavaTimer = 0.5;
      lavaTimer += delta;
      if (lavaTimer >= 0.5) { lavaTimer -= 0.5; dealDamage(2, { ignoreInvuln: true, cause: 'fire' }); hud.setHealth(playerHealth.current); }
    } else {
      lavaTimer = 0;
    }
    if (inFire) {
      if (fireTimer === 0) fireTimer = 0.5;
      fireTimer += delta;
      if (fireTimer >= 0.5) { fireTimer -= 0.5; dealDamage(1, { ignoreInvuln: true, cause: 'fire' }); hud.setHealth(playerHealth.current); }
    } else {
      fireTimer = 0;
    }

    // "on_fire" mode: touching lava/fire tops the after-burn counter back up
    // (so it doesn't start draining until contact is actually lost), then it
    // keeps ticking PLAYER_FIRE_AFTERBURN_TICKS times, 1 damage/tick, before
    // going out - same visual (orange tint + flame overlay) and damage
    // pattern as mob-manager.ts's mob.onFire.
    if (inLava || inFire) {
      playerFireTicksLeft = PLAYER_FIRE_AFTERBURN_TICKS;
    }
    playerOnFire = playerFireTicksLeft > 0;
    if (playerOnFire) {
      playerFireTickTimer += delta;
      if (playerFireTickTimer >= PLAYER_FIRE_TICK_INTERVAL) {
        playerFireTickTimer -= PLAYER_FIRE_TICK_INTERVAL;
        playerFireTicksLeft -= 1;
        dealDamage(1, { ignoreInvuln: true, cause: 'fire' });
        hud.setHealth(playerHealth.current);
      }
    } else {
      playerFireTickTimer = 0;
    }
    playerModel.setOnFire(playerOnFire);
    // The 3D flame overlay (on playerModel's group) is already first-person-only
    // for free - the whole group is hidden there (see playerModel.setVisible()
    // below) and only shows in third person. The screen overlay is its first-
    // person equivalent, so it's gated the other way: first person only.
    const showFireScreen = playerOnFire && player.isFirstPerson();
    fireScreenOverlay.classList.toggle('active', showFireScreen);
    if (showFireScreen) {
      // Stretch a single frame to fill the element (no tiling) - background-size
      // is computed from the element's own rendered height so one 16x16 frame
      // maps to exactly one screen-height's worth of the 32-frame strip.
      const h = fireScreenOverlay.clientHeight;
      fireScreenOverlay.style.backgroundSize = `100% ${h * 32}px`;
      fireScreenOverlay.style.backgroundPositionY = `-${getFireFrameIndex(clock.elapsedTime) * h}px`;
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
  playerModel.setLightLevel(lightLevel / 15, delta);

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
  playerModel.updateWalkingAnimation(delta, player.isSprinting);

  // UI and debug updates
  debugOverlay.update();
  interaction.update(delta);
  const bowDraw = interaction.getBowDrawProgress();
  player.setAimProgress(bowDraw);
  hand.setBowDraw(bowDraw);
  player.setSpeedRestricted(interaction.isMovementRestricted());
  particles.update(delta, camera);
  smokeParticles.update(delta);
  blockInspector.update();
  furnaceUI.update();
  chestRenderer.update(delta, (x, y, z) => lightEngine.getRawBrightness(x, y, z));
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

fitInventoryPanels();

const applyViewport = createApplyViewport(camera, renderer, hand);
window.addEventListener('resize', applyViewport);
window.addEventListener('orientationchange', applyViewport);
window.visualViewport?.addEventListener('resize', applyViewport);
applyViewport();

let dropDebug = false;
document.addEventListener('keydown', (event) => {
  if (event.code === 'KeyR' && !event.repeat) {
    dropDebug = !dropDebug;
    droppedItems.setDebug(dropDebug);
    mobManager.setDebug(dropDebug);
    arrowProjectiles.setDebug(dropDebug);
  }
});

// Make floating panels draggable
makeFloatingPanelDraggable('diagnostics-panel');
makeFloatingPanelDraggable('block-inspector');

camera.position.copy(player.state.position);
animate();
}

// Intro sequence, then the main menu. "Singleplayer" starts the game.
// Returning from a world via "Leave World" reloads the page and skips the intro.
function showMainMenu() {
  document.querySelector<HTMLElement>('#main-menu')!.hidden = false;
  new MainMenu({
    onSingleplayer: () => { void startGame(); },
    onMultiplayer: (serverUrl, worldId) => {
      void import('./multiplayer-game').then((m) => m.startMultiplayer(serverUrl, worldId));
    },
  });
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

import * as THREE from 'three';
import { MpClient } from './net/mp-client';
import { BlockId, blockLightProperties, createBlockMaterials, isSolidBlock, type BlockMaterials } from './block';
import { Chunk, CHUNK_SIZE, CHUNK_HEIGHT } from './chunk';
import { TerrainNoise } from './terrain-noise';
import { lockPointer, unlockPointerForGui, isTouchDevice } from './is-touch';
import { loadSettings, saveSettings } from './settings';
import { TouchControls } from './touch-controls';
import { PlayerModel, createSkinMaterials, disposeSkinMaterials, type PlayerSkinMaterials, type ModelAdjustments } from './player-model';
import { InventoryDoll } from './inventory-doll';
import { FirstPersonHand } from './first-person-hand';
import { ViewBob } from './view-bob';
import { showHeldItemName } from './held-item-name';
import { playClick } from './ui-sound';
import { showTooltip, hideTooltip } from './tooltip';
import { loadPlayerSkinDataUrl } from './player-skin';
import { loadPlayToken } from './access-gate';
import { setSingleplayerChatEnabled, setSingleplayerPauseMenuEnabled } from './main';
import { thirdPersonCameraPosition } from './third-person-camera';
import { LightEngine, type LightWorld } from './light-engine';
import { SkyRenderer } from './sky-renderer';
import { SoundManager } from './sound-manager';
import { getBlockSound } from './block-sounds';
import { playMobSound } from './mob-sounds';
import { MOB_STATS, isBipedKind, type MobKind, type MobSpec, type AnyMobModel } from './mob-manager';
import { MobModel, BipedMobModel, type QuadrupedSpec, type BipedSpec } from './mob-model';
import { PIG_SPEC } from './pig-model';
import { COW_SPEC } from './cow-model';
import { SHEEP_SPEC } from './sheep-model';
import { ZOMBIE_SPEC } from './zombie-model';
import { SKELETON_SPEC } from './skeleton-model';
import { renderSlot, createEmptySlot, HOTBAR_SIZE, TOTAL_SLOTS, type InventorySlot } from './inventory';
import { Hud } from './hud';
import { COOK_SECONDS } from './smelting';
import { foodValue, isBlock, ItemId, ITEMS } from './item';
import { BLOCK_CATALOG } from './creative-palette';
import { makeStack } from './item-stack';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh, tintByLight, initPreviewAtlases, renderBlockPreview, renderItemIcon } from './block-preview';
import { breakTime } from './block-hardness';
import { BreakOverlay } from './break-overlay';
import { BlockHighlight } from './block-highlight';
import { shapeBoxesFor } from './block-shapes';
import { createArrowMesh, orientArrowMesh } from './arrow-projectiles';
import { AmbientSoundEngine } from './ambient-sound';
import { WorldMusic } from './world-music';
import { ParticleSystem } from './particles';
import { SmokeParticles } from './smoke-particles';
import { UnderwaterManager } from './underwater-manager';
import { computeDayNightState, resolveCycleTime, NIGHT_SKY_DARKEN } from './day-night-math';
import type { EntitySnapshot, DroppedItemSnapshot, ArrowSnapshot, CraftSlotRef } from './net/protocol';

/**
 * Fase 6 of the multiplayer migration plan: the client side of the world
 * server built in Fase 5. Deliberately self-contained (its own scene/camera/
 * renderer/canvas, own input handling) rather than woven into main.ts's
 * singleplayer flow - that keeps this first version from risking any
 * regression to the existing (much larger, much more capable) singleplayer
 * game while the multiplayer path is still this early/limited.
 *
 * Terrain: real, not a placeholder. The server only ever sends a `worldSeed`
 * (see world-do.ts) - it never ships block data over the wire at all. Since
 * generation is fully deterministic (same Chunk/TerrainNoise/worldgen/*
 * classes the singleplayer client and the server's world-server/src/terrain.ts
 * both use), this client just regenerates the identical terrain locally from
 * that seed, the same way world-server/src/terrain.ts does server-side for
 * collision. Both sides agree on the world's shape without a byte of terrain
 * ever crossing the network - only edits (breakBlock/placeBlock) do.
 *
 * Terrain streams in/out as the player moves (updateStreaming() below) -
 * generated a few chunks per frame within VIEW_RADIUS_CHUNKS, unloaded once
 * well outside it, same "why bother" reasoning as singleplayer's own
 * ChunkManager: an infinite world can't all be resident at once. Server-side
 * collision (world-server/src/terrain.ts) was ALREADY effectively unbounded
 * since Fase "terreno real" (it generates any chunk a physics query touches,
 * with no view-radius limit) - this just brings the client's rendering up to
 * the same "walk anywhere" standard the server's physics already had, so a
 * player doesn't end up standing on real (solid) ground that a fixed static
 * grid simply never rendered.
 *
 * Still-limited scope (matches world-do.ts's own documented scope): melee
 * combat only (left-click an entity's hitbox - see onMouseDown),
 * no bow/ranged attack from the player and no PvP (world-do.ts rejects a
 * non-negative attack target); health is a plain heart-count string, not the
 * real HUD; no client-side prediction (camera
 * POSITION always comes from the server's last `state` message - only look
 * direction is local, for responsiveness). Every one of
 * those is a real follow-up, not a corner cut by accident.
 */

const TICK_HZ = 20;
const SEND_INTERVAL_MS = 1000 / TICK_HZ;
const MOUSE_SENSITIVITY_BASE = 0.0022; // matches player.ts's own base look constant exactly
const REACH = 5;
const VIEW_RADIUS_CHUNKS = 3; // 7x7 chunks (112x112 blocks) around the player, kept loaded
const UNLOAD_MARGIN_CHUNKS = 1; // a chunk isn't unloaded until it's this far PAST the view radius, so walking back and forth right at the edge doesn't thrash load/unload every frame
const CHUNKS_PER_FRAME = 1; // generation+meshing is real CPU work - spread across frames like singleplayer's own FrameBudget, not all at once

type RemoteEntity = {
  mesh: THREE.Group;
  /** The actual raycast target (a Group isn't one) - tagged with `userData.entityId` for onMouseDown's attack-vs-break check. */
  hitbox: THREE.Mesh;
  label: HTMLDivElement;
  /** How far above mesh.position the name label floats - differs by kind since a player's origin is eye-height but a mob's is feet-height (see makeEntityAvatar). */
  labelOffsetY: number;
  /** Only for kind:'player' - the real skinned/animated model (see makeEntityAvatar). */
  playerModel?: PlayerModel;
  /** Only for a MOB - the same MobModel/BipedMobModel singleplayer renders, driven from the server's snapshots. */
  mobModel?: AnyMobModel;
  /** Seconds until this mob's next ambient bark, mirroring mob-manager.ts's own idleSoundTimer - the server has no SoundManager, so idle cues are the client's own business. */
  idleSoundTimer?: number;
  /** This player's own skin materials (see createSkinMaterials) - kept so onEntityRemoved/disconnect can dispose them; undefined for a mob. */
  skinMaterials?: PlayerSkinMaterials;
  /** Health as of the last `state` tick - a drop since then triggers the model's hurt flash (and, for a mob, its hurt bark). */
  lastHealth: number;
  /** This entity's yaw as of the last `state` tick - updateRemoteAnimation's setOrientation() reads this every render frame (not just on a tick), since it owns and eases group.rotation.y itself once a player has a playerModel. */
  lastYaw: number;
  /** Only for kind:'player' - look pitch as of the last `state` tick, same read pattern as lastYaw (PlayerModel.setOrientation() applies it to the head bone every render frame). */
  lastPitch: number;
  /** Only for kind:'player' - as of the last `state` tick, applied every render frame in updateRemoteAnimation via setSneaking()/setHeldItem(). */
  sneaking: boolean;
  heldItem: number | null;
  /**
   * Movement since the previous `state` tick (raw position delta, not
   * divided by tick duration - only its direction and whether it clears a
   * small threshold matter to PlayerModel.setOrientation()/the walk-cycle
   * check, not its exact magnitude). Computed ONCE per tick in onState and
   * held constant across every render frame until the next tick, rather
   * than recomputed per frame from the mesh's own position - the position
   * itself only changes at the server's 20Hz, so recomputing every ~60Hz
   * render frame would see zero movement between ticks and flicker the walk
   * animation on and off in time with the tick rate instead of running smoothly.
   */
  moveDeltaX: number;
  moveDeltaZ: number;
  /** EntityKind ('player' or a MobKind) - kept so onEntityRemoved/onState can look up the right sound (playMobSound) without the server having to resend it. */
  kind: string;
  /** Seconds this entity has been toppling (server `dying`), driving the death spin. The server keeps a dying mob in the snapshot for DEATH_SPIN_DURATION precisely so this animation has time to play before the entity disappears. */
  dyingFor?: number;
};

/**
 * PlayerModel.setAdjustments() is what actually MOVES the legs (and torso/
 * arms/head) into the crouch pose - setSneaking()/updateSneak() alone only
 * rotate the torso and add an arm-swing offset (see player-model.ts's
 * setAdjustments doc comment: the leg position shift lives there, reading
 * the same sneakAmount). Singleplayer calls it every frame with
 * pauseMenu.modelAdjustments (a debug-tunable, all-zero by default); this
 * client has no PauseMenu instance, so an all-zero constant stands in for
 * "no manual tuning applied" - same effective result.
 */
const ZERO_MODEL_ADJUSTMENTS: ModelAdjustments = {
  head: { x: 0, y: 0, z: 0 },
  torso: { x: 0, y: 0, z: 0 },
  armLeft: { x: 0, y: 0, z: 0 },
  armRight: { x: 0, y: 0, z: 0 },
  legs: { x: 0, y: 0, z: 0 },
};

/** Matches mobs.ts's DEATH_SPIN_DURATION - how long the server keeps a dying mob around, so the topple finishes exactly as it vanishes. */
const DEATH_SPIN_DURATION = 0.75;

/** Kind -> model spec, same table singleplayer's mob-spawning.ts builds. Imported per-model rather than from mob-spawning itself so the multiplayer bundle doesn't drag in that file's whole slot-based spawning system, which it never runs. */
const MOB_SPECS: Record<MobKind, MobSpec> = {
  pig: PIG_SPEC, cow: COW_SPEC, sheep: SHEEP_SPEC, zombie: ZOMBIE_SPEC, skeleton: SKELETON_SPEC,
};

/** Ambient bark cadence, matching mob-manager.ts's own IDLE_SOUND_MIN/MAX and MOB_SOUND_RADIUS. */
const IDLE_SOUND_MIN = 4;
const IDLE_SOUND_MAX = 9;
const MOB_SOUND_RADIUS = 4;
const nextIdleDelay = () => IDLE_SOUND_MIN + Math.random() * (IDLE_SOUND_MAX - IDLE_SOUND_MIN);

export function startMultiplayer(serverUrl: string, worldId: string): void {
  // Singleplayer's own Chat/PauseMenu instances live for the whole page and
  // would otherwise steal every "T"/"Tab" press from this session's own chat
  // and options panel (see main.ts's doc comments) - both re-enabled in
  // disconnect() below.
  setSingleplayerChatEnabled(false);
  setSingleplayerPauseMenuEnabled(false);

  const canvas = document.querySelector<HTMLCanvasElement>('#mp-canvas')!;
  const crosshair = document.querySelector<HTMLElement>('#mp-crosshair')!;
  const hint = document.querySelector<HTMLElement>('#mp-hint')!;
  /**
   * Real HUD (heart/bubble/XP textures), not the old emoji-text stand-in -
   * built here rather than in index.html like every other MP-only panel in
   * this file, but the ELEMENTS underneath are the exact same structure
   * singleplayer's #hud/#hud-hearts/#hud-bubbles/#hud-xp use (see style.css's
   * mp- prefixed mirror of those rules), so the shared `Hud` class (hud.ts)
   * needs no changes beyond accepting which ids to bind to.
   */
  const hudEl = document.createElement('div');
  hudEl.id = 'mp-hud';
  hudEl.hidden = true;
  hudEl.innerHTML = [
    '<div id="mp-hud-bubbles" hidden></div>',
    '<div id="mp-hud-hearts"></div>',
    '<div id="mp-hud-xp"><div id="mp-hud-xp-fill"></div></div>',
  ].join('');
  document.body.appendChild(hudEl);
  const hud = new Hud({ hearts: '#mp-hud-hearts', bubbles: '#mp-hud-bubbles', xpFill: '#mp-hud-xp-fill' });
  const menu = document.querySelector<HTMLElement>('#main-menu')!;
  const connectScreen = document.querySelector<HTMLElement>('#multiplayer-connect')!;
  // #game-shell (singleplayer's HUD/hotbar/crosshair/chat/game-canvas) is
  // never marked `hidden` in the HTML or toggled by main.ts - it just sits
  // behind #main-menu's own opaque panorama the whole time. Hiding
  // #main-menu alone left it exposed: its HUD painted over this scene (z-
  // index 2 vs this canvas's implicit 0) AND its own <canvas>, though
  // visually transparent, still captured every click before it could reach
  // #mp-canvas - the exact "click doesn't do anything" symptom. Must hide it
  // explicitly and restore it on disconnect.
  const gameShell = document.querySelector<HTMLElement>('#game-shell')!;
  const previousGameShellDisplay = gameShell.style.display;
  gameShell.style.display = 'none';
  // Touch controls mount straight into <body> here (see the TouchControls
  // call below) instead of #game-shell, so their usual z-indices (tuned to
  // sit under singleplayer's hotbar/inventory) would land BELOW #mp-canvas's
  // z-index:900 and never receive a touch. This class raises them above it -
  // see the body.mp-touch rules in style.css.
  document.body.classList.add('mp-touch');

  canvas.hidden = false;
  crosshair.hidden = false;
  hint.hidden = false;
  hudEl.hidden = false;
  menu.hidden = true;
  connectScreen.hidden = true;

  // Same day/night colours singleplayer's main.ts uses (daySkyColor/
  // nightSkyColor passed into its own DayNightCycle) - kept in sync by eye
  // since main.ts doesn't export them; see updateDayNight() below for how
  // they're actually applied.
  const DAY_SKY_COLOR = new THREE.Color(0x8cb9ff);
  const NIGHT_SKY_COLOR = new THREE.Color(0x020017);

  const scene = new THREE.Scene();
  scene.background = DAY_SKY_COLOR.clone();
  // Fog range is shorter than singleplayer's (18-42, tuned to its default
  // view radius) since multiplayer's own VIEW_RADIUS_CHUNKS (7x7 chunks,
  // 112 blocks) is smaller - this just needs to hide the chunk-unload edge,
  // not match singleplayer's exact numbers.
  const fog = new THREE.Fog(scene.background.clone(), 40, 72);
  scene.fog = fog;
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(3, 10, 2);
  scene.add(sun);

  // Seeded from the same persisted settings singleplayer's own PauseMenu
  // reads/writes (localStorage, per origin) - a sensitivity or FOV set in
  // one mode carries over to the other, since it's the same person at the
  // same device either way.
  const mpSettings = loadSettings();
  const camera = new THREE.PerspectiveCamera(mpSettings.fov, window.innerWidth / window.innerHeight, 0.05, 500);
  // Same formula interaction.ts's onMouseMove applies to pauseMenu.mouseSensitivity: the 0-100 slider value divided by 100, scaling the base look constant. Mutable so the options panel's slider takes effect immediately.
  let sensitivityScale = mpSettings.sensitivity / 100;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // First-person held item/arm + its swing/place animation - own overlay
  // scene+camera (see FirstPersonHand's doc comment), same class singleplayer's
  // main.ts uses. Was never wired up here at all, which is why neither the
  // held item nor the swing-on-hit ever showed in the default first-person
  // view (third-person's own PlayerModel.setHeldItem()/swingArm() - wired
  // separately below - only become visible in third-person camera mode).
  const hand = new FirstPersonHand();
  hand.resize(camera.aspect);
  // Sun/moon/stars/clouds/horizon glow - same class singleplayer's main.ts
  // uses, driven every frame from applyDayNightState() below with the same
  // timeOfDay the flat sky/fog colour already tracks.
  const skyRenderer = new SkyRenderer(scene, camera);
  // Purely local/reactive - each client plays its own sounds for whatever it
  // already sees over the wire (blockChanged, a health drop, entityRemoved),
  // same as singleplayer's interaction.ts/mob-manager.ts do, just triggered
  // from network messages instead of local mining/AI code. No protocol
  // changes needed. initialize() needs a user gesture first (browser
  // autoplay policy) - done on the first click/touch that locks the pointer.
  const soundManager = new SoundManager();
  // Covers touch too (lockPointer above is desktop-only) - any first tap/click
  // anywhere satisfies the browser's autoplay-needs-a-gesture policy.
  // Music starts on the same gesture: browsers refuse autoplay before one.
  const onFirstGesture = () => { void soundManager.initialize(); worldMusic.start(); document.removeEventListener('pointerdown', onFirstGesture); };
  document.addEventListener('pointerdown', onFirstGesture, { once: true });

  // --- Real terrain: generated locally from the seed, not shipped over the
  // network - see the module doc comment. Streams in/out around the player
  // once `welcome` gives the seed (initTerrain() below); until materials
  // finish loading, updateStreaming() is a no-op and the scene is just sky.
  const chunks = new Map<string, Chunk>();
  let chunkMeshes: THREE.Mesh[] = [];
  /**
   * Real voxel lighting (BFS sky/block-light propagation), reusing
   * LightEngine exactly as singleplayer's World does - see LightWorld's doc
   * comment in light-engine.ts for why a thin adapter over this file's own
   * `chunks` map can drive it without pulling in all of World (ChunkManager,
   * IndexedDB persistence, water/lava/fire engines - none of which apply
   * here, since the server is the one authority on both terrain and edits).
   * Without this, chunk.ts's default light reader (a flat 15/15, "always
   * full bright") is what every multiplayer chunk had rendered with so far -
   * fine until day/night needed the ground to actually go dark at night.
   */
  const lightWorld: LightWorld = {
    chunks,
    getBlock,
    // Bounds-check y exactly like BlockStore.getLight/setLight (World's own
    // backing store) does - chunk.light's underlying array is sized to
    // CHUNK_HEIGHT and throws on an out-of-range y, which the BFS
    // propagation in light-engine.ts routinely probes (a column's neighbour
    // one block below y=0, or above the build height) expecting a plain 0
    // back, not a crash.
    getLight: (channel, x, y, z) => {
      if (y < 0 || y >= CHUNK_HEIGHT) return 0;
      const [cx, cz] = chunkCoordOf(x, z);
      return chunks.get(`${cx},${cz}`)?.getLight(channel, x, y, z) ?? 0;
    },
    setLight: (channel, x, y, z, level) => {
      if (y < 0 || y >= CHUNK_HEIGHT) return false;
      const [cx, cz] = chunkCoordOf(x, z);
      const chunk = chunks.get(`${cx},${cz}`);
      if (!chunk) return false;
      chunk.setLight(channel, x, y, z, level);
      return true;
    },
    emissionAt: (id) => blockLightProperties[id].emission,
  };
  const lightEngine = new LightEngine(lightWorld);
  /** Every currently-loaded chunk queued for a re-mesh after a skyDarken step - drained a few per frame (relightQueue below), same reasoning as CHUNKS_PER_FRAME: remeshing all ~49 loaded chunks in one frame on every step would be a visible hitch. */
  const relightQueue: string[] = [];
  const RELIGHT_CHUNKS_PER_FRAME = 2;
  /** Every block edit this client has ever seen (from blockChanged, including the backlog world-do.ts replays right after `welcome`), kept forever - not just "pending" - so a chunk unloaded and later reloaded still shows every edit made in it, not just ones that arrived while it happened to not exist yet. */
  const edits = new Map<string, BlockId>();
  /**
   * The server's WaterEngine/LavaEngine spread distance for every WATER/LAVA
   * cell this client has seen (blockChanged's optional `waterDistance` -
   * undefined for every non-liquid block, see protocol.ts's doc comment).
   * This client has no water simulation of its own - the server owns it -
   * so without this every liquid cell would mesh flat instead of getting the
   * sloped corner heights singleplayer's own World.getLiquidDistance() feeds
   * its chunk mesher (see getLiquidDistance/setWaterDistanceReader below,
   * mirroring world.ts's own wiring).
   */
  const waterDistances = new Map<string, number>();
  const loadQueue: string[] = [];
  const queuedKeys = new Set<string>();
  let lastPlayerChunkKey = '';
  let terrainNoise: TerrainNoise | null = null;
  let materials: BlockMaterials | null = null;

  // --- Ambience. All of this is purely local: the server sends no sound,
  // music or particle events, and none of it affects gameplay - it's the
  // same modules singleplayer runs, fed from state this client already has.
  // Own overlay element for the same reason as the fire one: main.ts's loop
  // keeps running behind this session and drives singleplayer's #underwater-
  // overlay from its own state, which would fight us for the class.
  const underwaterOverlayEl = document.createElement('div');
  underwaterOverlayEl.id = 'mp-underwater-overlay';
  underwaterOverlayEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(underwaterOverlayEl);

  /** The surface sky colour for the current time of day, kept separate from `scene.background` so it survives being replaced by the underwater tint - see applyDayNightState. */
  const currentSkyColor = new THREE.Color();
  /** Camera currently under water, as of the last UnderwaterManager update. */
  let submerged = false;

  let particles: ParticleSystem | null = null;
  const smokeParticles = new SmokeParticles();
  smokeParticles.attachToScene(scene);
  const worldMusic = new WorldMusic(0.35);
  const ambient = new AmbientSoundEngine(soundManager, { getBlock: (x, y, z) => getBlock(x, y, z) });
  const underwater = new UnderwaterManager(
    camera,
    {
      getBlock: (x, y, z) => getBlock(x, y, z),
      // This client has no flowing-water depth: the server owns the water
      // simulation and only ships the resulting blocks (see Fase 6b), so
      // every water block reads as a full one. The practical effect is that
      // the camera goes "underwater" at a flowing block's full height rather
      // than at its real, lower surface.
      getWaterDistance: () => 0,
    },
    scene,
    fog,
    underwaterOverlayEl,
  );
  let worldSeed = 0;
  /**
   * initTerrain() awaits initPreviewAtlases() (see below) before block/item
   * slot previews can render anything but a flat white placeholder - it used
   * to be called fire-and-forget (`void initTerrain(...)`), so if the
   * server's first `inventory` packet won the race against that promise,
   * renderHotbar()/renderBackpack() would call renderSlot() with the atlas
   * still null and every slot rendered white forever (block-preview.ts's
   * slower per-texture fallback path can lose its own late redraw). Kept so
   * the inventory-render call sites below can wait on it.
   */
  let terrainReady: Promise<void> | null = null;

  function chunkCoordOf(x: number, z: number): [number, number] {
    return [Math.floor((x + 8) / CHUNK_SIZE), Math.floor((z + 8) / CHUNK_SIZE)];
  }
  function getBlock(x: number, y: number, z: number): BlockId {
    const [cx, cz] = chunkCoordOf(x, z);
    const chunk = chunks.get(`${cx},${cz}`);
    return chunk ? chunk.getBlock(x, y, z) : BlockId.AIR;
  }
  /** Same signature/role as world.ts's own getLiquidDistance - fed into every chunk's setWaterDistanceReader below. `id` is unused (the map is already keyed by position only, since a cell is never both water and lava at once) but kept to match the mesher's WaterDistanceReader signature. */
  function getLiquidDistance(_id: BlockId, x: number, y: number, z: number): number {
    return waterDistances.get(`${x},${y},${z}`) ?? 0;
  }

  function rebuildChunkMeshList(): void {
    chunkMeshes = [];
    for (const chunk of chunks.values()) {
      for (const sc of chunk.subchunks) chunkMeshes.push(sc.mesh);
    }
  }

  async function initTerrain(seed: number): Promise<void> {
    worldSeed = seed;
    materials = await createBlockMaterials();
    // Wires up the shared block/item atlas that renderBlockPreview()/
    // renderItemIcon() (src/block-preview.ts, used by every inventory-slot
    // render in this file) need to crop a texture. main.ts calls this too,
    // right after its own createBlockMaterials() - without it those two
    // functions fail silently and every slot just stays blank, which is why
    // no item/block texture ever showed up in the hotbar or backpack.
    await initPreviewAtlases(materials.atlas);
    terrainNoise = new TerrainNoise(seed);
    // Block-break particles need the block atlas, so this can only be built
    // once the materials exist - hence here rather than alongside the other
    // ambient systems below.
    particles = new ParticleSystem(materials);
    particles.attachToScene(scene);
  }

  function generateChunk(cx: number, cz: number): void {
    if (!terrainNoise || !materials) return;
    const key = `${cx},${cz}`;
    if (chunks.has(key)) return;
    const chunk = new Chunk(
      scene, materials, cx, cz,
      getBlock, // cross-chunk reads during generation - AIR for a neighbour not generated yet, same tolerance singleplayer's own incremental streaming already has
      terrainNoise.sample.bind(terrainNoise), terrainNoise, worldSeed,
    );
    // Replay every edit that lands inside this chunk - covers both "arrived
    // before this chunk ever existed" and "this chunk was unloaded and is
    // now being regenerated from scratch".
    for (const [ekey, id] of edits) {
      const [ex, ey, ez] = ekey.split(',').map(Number);
      if (ex >= chunk.minX && ex < chunk.minX + CHUNK_SIZE && ez >= chunk.minZ && ez < chunk.minZ + CHUNK_SIZE) {
        chunk.setBlockData(ex, ey, ez, id);
      }
    }
    chunks.set(key, chunk); // must be in the map before initializeChunk() - it (and cross-chunk skylight propagation) reads neighbouring chunks via getBlock()
    // Real per-chunk lighting (see the lightWorld/lightEngine doc comment
    // above) instead of the default flat "always full bright" reader -
    // must happen before rebuildDirty() below so the very first mesh build
    // already bakes correct brightness, not a throwaway full-bright one.
    chunk.setLightReader(lightEngine.getRawBrightness.bind(lightEngine));
    // Same reasoning as setLightReader just above - must be set before the
    // first rebuildDirty() so the initial mesh already has real liquid
    // corner heights instead of the mesher's flat default (see
    // waterDistances/getLiquidDistance's doc comments).
    chunk.setWaterDistanceReader(getLiquidDistance);
    lightEngine.initializeChunk(chunk);
    chunk.rebuildDirty();
    // Whichever neighbors were already loaded meshed their shared boundary
    // assuming this chunk didn't exist - now that it does, that guess is
    // wrong and their mesh at this edge needs to be recomputed against the
    // real block/light data instead (see rebuildAdjacentChunks's doc
    // comment). Without this, streaming order determined which chunk
    // boundaries ended up with missing or duplicated faces.
    rebuildAdjacentChunks(cx, cz);
    rebuildChunkMeshList();
  }

  function unloadChunk(key: string): void {
    const chunk = chunks.get(key);
    if (!chunk) return;
    chunk.dispose();
    chunks.delete(key);
    const relightIdx = relightQueue.indexOf(key);
    if (relightIdx !== -1) relightQueue.splice(relightIdx, 1);
    rebuildChunkMeshList();
  }

  /** Queues newly-in-range chunks and drops far-out-of-range ones - only recomputed when the player actually crosses into a different chunk, not every frame. */
  function updateStreaming(): void {
    if (!terrainNoise || !materials) return;
    const [pcx, pcz] = chunkCoordOf(lastServerPos.x, lastServerPos.z);
    const playerKey = `${pcx},${pcz}`;
    if (playerKey !== lastPlayerChunkKey) {
      lastPlayerChunkKey = playerKey;
      for (let dx = -VIEW_RADIUS_CHUNKS; dx <= VIEW_RADIUS_CHUNKS; dx++) {
        for (let dz = -VIEW_RADIUS_CHUNKS; dz <= VIEW_RADIUS_CHUNKS; dz++) {
          const k = `${pcx + dx},${pcz + dz}`;
          if (!chunks.has(k) && !queuedKeys.has(k)) { loadQueue.push(k); queuedKeys.add(k); }
        }
      }
      const unloadRadius = VIEW_RADIUS_CHUNKS + UNLOAD_MARGIN_CHUNKS;
      for (const k of [...chunks.keys()]) {
        const [cx, cz] = k.split(',').map(Number);
        if (Math.abs(cx - pcx) > unloadRadius || Math.abs(cz - pcz) > unloadRadius) unloadChunk(k);
      }
      // Drop anything still queued that fell out of range before its turn came up.
      for (let i = loadQueue.length - 1; i >= 0; i--) {
        const [cx, cz] = loadQueue[i].split(',').map(Number);
        if (Math.abs(cx - pcx) > VIEW_RADIUS_CHUNKS || Math.abs(cz - pcz) > VIEW_RADIUS_CHUNKS) {
          queuedKeys.delete(loadQueue[i]);
          loadQueue.splice(i, 1);
        }
      }
      loadQueue.sort((a, b) => {
        const [ax, az] = a.split(',').map(Number);
        const [bx, bz] = b.split(',').map(Number);
        return (ax - pcx) ** 2 + (az - pcz) ** 2 - ((bx - pcx) ** 2 + (bz - pcz) ** 2);
      });
    }
    for (let i = 0; i < CHUNKS_PER_FRAME && loadQueue.length > 0; i++) {
      const k = loadQueue.shift()!;
      queuedKeys.delete(k);
      const [cx, cz] = k.split(',').map(Number);
      generateChunk(cx, cz);
    }
  }

  /** Client's own free-running copy of the server's authoritative day/night clock (see world-do.ts's dayNightElapsed doc comment) - advanced locally every frame for a smooth transition, hard-resynced whenever a `dayTime` message arrives so it can't drift indefinitely. Seeded from `welcome`. */
  let clientDayTime = 0;
  /** Set on `welcome` - suppresses block sounds for a moment after connecting, so the backlog of every historical edit world-do.ts replays as its own blockChanged right after `welcome` (see onJoin's doc comment there) doesn't play a burst of break/place sounds on join. */
  let joinedAtMs = 0;
  /**
   * True from `welcome` until the first `state` message - the window where
   * world-do.ts's onJoin is still synchronously replaying every historical
   * edit as its own `blockChanged` (see that loop's own doc comment). The
   * server never starts ticking `state` messages until that replay loop has
   * already finished sending, so the first `state` is a reliable "the
   * backlog is over" signal.
   *
   * While this is true, applyBlockChange() below skips the expensive part
   * (light BFS + chunk remesh) for EVERY edit and only writes the raw block
   * data - for a world with thousands of edits (a decayed forest alone can
   * be that many), doing a full relight+remesh per edit synchronously froze
   * the whole tab for seconds: no rendering, no input, and whatever HAD
   * already relit mid-freeze visibly "broke on its own" as the backlog
   * caught up in front of the player. Once the backlog is confirmed over,
   * one single full relight (lightEngine.rebuildLoadedChunks()) plus a
   * throttled remesh via the existing relightQueue replaces all of that
   * per-edit work with one bounded pass.
   */
  let catchingUp = true;
  /** The local player's own health as of the last `state` tick - a drop triggers Player_hurt, same as remote entities' lastHealth triggers their own hurt cue. */
  let lastSelfHealth = Infinity;

  /**
   * Applies the current point in the day/night cycle to the sky/fog colour,
   * and - on an integer skyDarken step change - re-lights every loaded
   * chunk (see the relightQueue/lightEngine doc comment above). Block-level
   * lighting itself (torches, skylight propagation) already reflects the
   * new skyDarken the instant lightEngine.setSkyDarken() below returns true
   * - getRawBrightness reads it live - the queue only exists to spread the
   * many chunk re-MESHES that need to pick that up across several frames
   * instead of one big hitch.
   */
  function applyDayNightState(elapsed: number, delta = 0): void {
    const cycleTime = resolveCycleTime(elapsed, 0);
    const { skyDarken, timeOfDay } = computeDayNightState(cycleTime);
    if (lightEngine.setSkyDarken(skyDarken)) {
      relightQueue.length = 0;
      for (const key of chunks.keys()) relightQueue.push(key);
    }
    // Always resolve the surface sky, but only paint it while the camera is
    // above water. UnderwaterManager swaps the background/fog to its blue
    // ONCE, on the frame you go under; this function runs every frame, so
    // writing unconditionally would repaint the daylight sky over that blue
    // the very same frame and the tint would never be visible. Singleplayer
    // avoids this by only repainting when the cycle's colour actually
    // changes - here the guard is explicit instead.
    currentSkyColor.copy(DAY_SKY_COLOR).lerp(NIGHT_SKY_COLOR, skyDarken / NIGHT_SKY_DARKEN);
    if (!submerged) {
      scene.background = currentSkyColor;
      fog.color.copy(currentSkyColor);
    }
    // Sun/moon/stars/clouds/horizon glow on top of the flat sky colour above -
    // same split singleplayer's main.ts makes (DayNightCycle owns the flat
    // colour, SkyRenderer draws the celestial bodies over it).
    skyRenderer.update(timeOfDay, delta);
  }

  /**
   * Rebuild every already-loaded neighbor of (cx,cz) from scratch - all 8,
   * not just the 4 orthogonal ones. Three unrelated bugs share this one fix:
   * - A chunk that streamed in AFTER its neighbor was already meshed left
   *   that neighbor's boundary faces stuck with whatever culling decision it
   *   made when there was nothing there yet (generateChunk's call below).
   * - Light propagated by a block edit can spread across a chunk boundary
   *   (a column that lost its roof near the edge, say) - the edited chunk's
   *   own rebuild in applyBlockChange doesn't touch the neighbor's mesh, so
   *   its shading would stay stale even though the light DATA is correct.
   * - Same as either of the above, but AT a chunk corner: light and culling
   *   both reach across a shared corner too, not just a shared edge - src/
   *   world.ts's own markAdjacentChunksDirty had the identical 4-only gap
   *   (this isn't a multiplayer-only bug, just fixed here first), which
   *   could leave an isolated dark patch sitting right at a chunk corner
   *   until something else happened to touch that specific diagonal chunk.
   * All three are the same shape of bug: "a chunk's mesh is stale because
   * something changed just outside it" - so one helper covers them.
   */
  function rebuildAdjacentChunks(cx: number, cz: number): void {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const neighbor = chunks.get(`${cx + dx},${cz + dz}`);
      if (!neighbor) continue;
      neighbor.markAllDirty();
      neighbor.rebuildDirty();
    }
  }

  function applyBlockChange(x: number, y: number, z: number, id: BlockId, waterDistance?: number, silent?: boolean): void {
    // Recorded even when the block id itself doesn't change below (a
    // flowing cell can stay WATER/LAVA while its distance settles to a
    // different value) - same limitation singleplayer's own World.setBlock
    // has (its blockStore-level "changed" check doesn't know about the
    // separate WaterEngine distance map either), so this is parity with it,
    // not a new gap: the next remesh this cell's chunk gets for ANY reason
    // will pick up the latest value even when this specific update doesn't
    // itself trigger one.
    const key = `${x},${y},${z}`;
    if (waterDistance === undefined) waterDistances.delete(key);
    else waterDistances.set(key, waterDistance);

    const previousId = getBlock(x, y, z);
    // Captured BEFORE the edit, same as world.ts's setBlock/place - queueing
    // the light update below needs to know what this cell was lighting like
    // just before it changed, not after.
    const oldSkyLight = lightWorld.getLight('skyLight', x, y, z);
    const oldBlockLight = lightWorld.getLight('blockLight', x, y, z);

    // Reactive, not optimistic: world-do.ts's setBlock() broadcasts to
    // EVERY session including whoever sent the edit, so playing a sound here
    // (once, for every edit - ours and everyone else's alike) instead of
    // also at the moment performInteraction() sends breakBlock/placeBlock
    // avoids doubling up our own break/place sound.
    // A flowing water/lava cell re-broadcasts its OWN setBlock() every time
    // the server's engine advances it (same cell, same blockId, just a new
    // distance) - world.ts's own water tick never plays a sound for this
    // either (only its own add()/remove(), called from an actual player
    // placing/breaking, does). `waterDistance === 0` is the source cell;
    // anything deeper into the flow (an actual liquid, not this specific
    // spread step) skips the place sound below.
    const isFlowingLiquidStep = (id === BlockId.WATER || id === BlockId.LAVA) && waterDistance !== 0;
    if (performance.now() - joinedAtMs > 500 && !isFlowingLiquidStep && !silent && !catchingUp) {
      const sound = id === BlockId.AIR
        ? getBlockSound(previousId, 'dig')
        : getBlockSound(id, 'place') ?? getBlockSound(id, 'dig');
      if (sound) soundManager.playSound(sound);
      // Break puff, same as singleplayer's interaction.ts does on its own
      // digs - here it fires for every player's edits, not just ours, since
      // that's what this handler already sees.
      if (id === BlockId.AIR && previousId !== BlockId.AIR) {
        particles?.burst(new THREE.Vector3(x, y, z), previousId, lightEngine.getRawBrightness(x, y, z) / 15);
      }
    }
    edits.set(`${x},${y},${z}`, id);
    const [cx, cz] = chunkCoordOf(x, z);
    const chunk = chunks.get(`${cx},${cz}`);
    if (!chunk) return;

    if (catchingUp) {
      // Raw write only - correct for physics/getBlock() immediately, but no
      // light/mesh work yet (see catchingUp's own doc comment for why: a
      // chunk that already exists this early gets properly relit in one
      // shot once the backlog is confirmed done, instead of once per edit).
      chunk.setBlockData(x, y, z, id);
      return;
    }
    if (!chunk.setBlock(x, y, z, id)) return;

    // Light was only ever computed ONCE, at chunk generation - nothing here
    // told it a block changed, so a broken block kept the darkness of
    // whatever solid thing used to occupy it (rendering pitch black) and a
    // placed one never cast or blocked anything. queueBlockUpdate() re-seeds
    // the BFS from this cell; processUpdates() drains it synchronously right
    // here rather than waiting for a frame-loop pass, since a single edit's
    // propagation is small and this mirrors the one-rebuild-per-edit
    // approach this function already had (see chunkData backlog replay on
    // join, which can call this dozens of times back to back).
    lightEngine.queueBlockUpdate(x, y, z, oldSkyLight, oldBlockLight);
    lightEngine.processUpdates();
    chunk.rebuildDirty(Infinity, y);
    rebuildAdjacentChunks(cx, cz);
  }

  const remoteEntities = new Map<number, RemoteEntity>();

  /**
   * Items lying on the ground, keyed by the server's `entityId`. The server
   * owns position and pickup (world-do.ts's ServerDroppedItems); this side
   * only draws them and adds the spin/bob singleplayer's own DroppedItems
   * does, which never travels over the wire so it stays smooth between the
   * server's 20Hz snapshots.
   *
   * Two nested objects on purpose: the OUTER group is moved to exactly what
   * the server last said and nothing else ever writes to it, while the inner
   * mesh carries the cosmetic offset as a LOCAL transform. Keeping a copy of
   * the authoritative height alongside the animation (the obvious one-object
   * version) means the two can silently drift apart - which is exactly what
   * happened first try here: the bob kept re-applying against a stale height
   * and left every item hovering half a block over the ground.
   */
  type GroundItem = { anchor: THREE.Group; mesh: THREE.Group; spawnedAt: number };
  const groundItems = new Map<number, GroundItem>();

  function addGroundItem(snap: DroppedItemSnapshot): GroundItem {
    const slot = makeStack(snap.itemId, snap.count);
    const block = isBlock(snap.itemId);
    const mesh = block ? buildBlockMesh(slot) : buildItemMesh(slot.sideTexture ?? '');
    mesh.scale.setScalar(block ? 0.17 : 0.4); // same sizes singleplayer's DroppedItems uses
    const anchor = new THREE.Group();
    anchor.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
    anchor.add(mesh);
    scene.add(anchor);
    const item: GroundItem = { anchor, mesh, spawnedAt: performance.now() };
    groundItems.set(snap.entityId, item);
    return item;
  }

  function removeGroundItem(entityId: number): void {
    const item = groundItems.get(entityId);
    if (!item) return;
    scene.remove(item.anchor);
    disposeBlockMesh(item.mesh);
    groundItems.delete(entityId);
  }

  /** Spin + idle bob, as singleplayer's DroppedItems.update() does it - cosmetic only, driven by local time rather than by anything the server sends, and applied as a local offset so it can't move the item off the ground it's resting on. */
  function animateGroundItems(delta: number): void {
    for (const item of groundItems.values()) {
      item.mesh.rotation.y += delta * 1.6;
      const age = (performance.now() - item.spawnedAt) / 1000;
      item.mesh.position.y = 0.06 + Math.sin(age * 3) * 0.06;
      const p = item.anchor.position;
      tintByLight(item.mesh, lightEngine.getRawBrightness(Math.round(p.x), Math.round(p.y), Math.round(p.z)) / 15);
    }
  }

  /**
   * Arrows in flight or stuck in walls, keyed by the server's `entityId`.
   * Pure rendering: the server owns flight, impact and recovery, so all this
   * does is move and point the same mesh singleplayer uses. No per-instance
   * disposal on removal - createArrowMesh() hands out shared geometry and
   * material, so disposing one arrow's would break every other one in flight.
   */
  const arrowMeshes = new Map<number, THREE.Group>();

  function syncArrows(snaps: ArrowSnapshot[]): void {
    const seen = new Set<number>();
    for (const snap of snaps) {
      seen.add(snap.entityId);
      let mesh = arrowMeshes.get(snap.entityId);
      if (!mesh) {
        mesh = createArrowMesh();
        scene.add(mesh);
        arrowMeshes.set(snap.entityId, mesh);
      }
      mesh.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
      orientArrowMesh(mesh, snap.yaw, snap.pitch);
    }
    for (const [entityId, mesh] of arrowMeshes) {
      if (seen.has(entityId)) continue;
      scene.remove(mesh);
      arrowMeshes.delete(entityId);
    }
  }

  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:901;';
  document.body.appendChild(labelLayer);

  // --- Hotbar: server is authoritative (world-do.ts's Session.inventory) -
  // this just renders whatever `inventoryUpdate` last said and lets the
  // player pick a slot (number keys) or drop it (Q). Reuses inventory.ts's
  // own renderSlot()/CSS classes (.inventory-slot/.inventory-block/etc,
  // already generic - not scoped to singleplayer's #game-shell) instead of
  // reinventing slot rendering. The backpack panel (E, below) renders the
  // rest of the same 36-slot array.
  const hotbarEl = document.createElement('div');
  hotbarEl.id = 'mp-hotbar';
  const hotbarSlotEls: HTMLButtonElement[] = [];
  for (let i = 0; i < HOTBAR_SIZE; i++) {
    const btn = document.createElement('button');
    btn.className = 'inventory-slot';
    btn.type = 'button';
    // Tap/click selects this slot, same as singleplayer's HUD hotbar row
    // (Inventory.createSlotElement's click handler, src/inventory.ts:306-309)
    // - this is the ONLY way a touch player can change slots (no keyboard),
    // and it works for a mouse click too, alongside the digit keys above and
    // the scroll wheel (onWheel below). Moving items between STORAGE slots
    // still only works from inside the backpack panel, but selecting the
    // currently-held hotbar slot doesn't need it open at all.
    const index = i;
    btn.addEventListener('click', () => client.send({ type: 'selectSlot', index }));
    hotbarEl.appendChild(btn);
    hotbarSlotEls.push(btn);
  }
  document.body.appendChild(hotbarEl);
  let inventorySlots: InventorySlot[] = Array.from({ length: TOTAL_SLOTS }, createEmptySlot);
  let selectedSlotIndex = 0;
  /** Same key scheme as singleplayer's Inventory.announceHeld - `index:id`, so a stack-count-only change (mining, placing) doesn't re-flash the name. */
  let lastHeldKey: string | null = null;
  function announceHeldIfChanged(): void {
    const slot = inventorySlots[selectedSlotIndex] ?? createEmptySlot();
    const key = `${selectedSlotIndex}:${slot.id ?? ''}`;
    const first = lastHeldKey === null;
    const changed = key !== lastHeldKey;
    lastHeldKey = key;
    if (first || !changed || backpackOpen) return;
    showHeldItemName(slot.id === null ? null : slot.name);
  }
  function renderHotbar(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      renderSlot(hotbarSlotEls[i], inventorySlots[i] ?? createEmptySlot());
      hotbarSlotEls[i].classList.toggle('selected', i === selectedSlotIndex);
    }
  }
  renderHotbar();

  /**
   * Cursor-follows-mouse inventory interaction, same feel as singleplayer's
   * Inventory class (src/inventory.ts's pickUpFrom/placeHeld/depositOne) -
   * left click takes/places a whole stack, right click takes half / places
   * one, holding right and dragging across slots deposits one into each new
   * slot entered. Unlike singleplayer this client never mutates a slot
   * directly: `heldItem` here is just a LOCAL mirror of the server's own
   * `session.heldItem` (world-do.ts), echoed back by `invHeld` after every
   * invPickUp/invPlace/invCancel - the actual pick/place/merge/swap logic
   * all happens server-side (same reasoning `craftMove` already had: this
   * inventory is server-authoritative, so a real move needs the server's
   * own validation, not an optimistic local guess).
   */
  let heldItem: InventorySlot | null = null;
  const ghostEl = document.createElement('div');
  ghostEl.id = 'mp-inventory-ghost';
  ghostEl.className = 'inventory-ghost'; // same look as singleplayer's own held-item cursor (style.css)
  ghostEl.hidden = true;
  document.body.appendChild(ghostEl);
  function renderGhost(): void {
    ghostEl.innerHTML = '';
    if (!heldItem) { ghostEl.hidden = true; return; }
    ghostEl.hidden = false;
    const canvas = document.createElement('canvas');
    canvas.className = 'inventory-block';
    ghostEl.appendChild(canvas);
    if (isBlock(heldItem.id)) renderBlockPreview(canvas, heldItem);
    else renderItemIcon(canvas, heldItem.sideTexture ?? '');
    const count = heldItem.count ?? 1;
    if (count > 1) {
      const badge = document.createElement('span');
      badge.className = 'slot-count';
      badge.textContent = String(count);
      ghostEl.appendChild(badge);
    }
  }
  document.addEventListener('mousemove', (e) => {
    ghostEl.style.left = `${e.clientX}px`;
    ghostEl.style.top = `${e.clientY}px`;
  });
  // Hover tooltip with the item's name, same as singleplayer's Inventory -
  // every slot button already carries its name in aria-label via renderSlot,
  // so this one delegated listener covers the hotbar, backpack, table and
  // furnace panels without needing to resolve each CraftSlotRef back to a value.
  document.addEventListener('mousemove', (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.inventory-slot');
    const name = el?.getAttribute('aria-label');
    if (el && name && !heldItem) showTooltip(name, e.clientX, e.clientY);
    else hideTooltip();
  });

  /** Every slot button this file creates, so the paint-drag gesture below can look up which one the cursor is currently over. */
  const slotRefByEl = new Map<HTMLElement, CraftSlotRef>();
  /** Non-null only while the right mouse button is down AND something is held - the set of slots already painted this drag, so re-entering one doesn't deposit twice. Mouse-only (unlike singleplayer's touch-aware onPaintDown/Move/Up, src/inventory.ts:615-656) - this panel has no touch equivalent to unify it with. */
  let paintSeen: Set<HTMLElement> | null = null;
  document.addEventListener('mousedown', (e) => { if (e.button === 2) paintSeen = new Set(); });
  document.addEventListener('mouseup', (e) => { if (e.button === 2) paintSeen = null; });
  document.addEventListener('mousemove', (e) => {
    if (!paintSeen || !heldItem) return;
    const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.inventory-slot');
    if (!el || paintSeen.has(el)) return;
    const ref = slotRefByEl.get(el);
    if (!ref) return;
    paintSeen.add(el);
    client.send({ type: 'invPlace', to: ref, one: true });
  });

  function onSlotClick(ref: CraftSlotRef): void {
    if (heldItem) client.send({ type: 'invPlace', to: ref, one: false });
    else client.send({ type: 'invPickUp', from: ref, half: false });
  }
  function onSlotRightClick(ref: CraftSlotRef, el: HTMLElement): void {
    // The button that opened this same drag already deposited via the
    // paint-drag listener above (mousedown fires before contextmenu) -
    // don't also run the plain one-shot action for it.
    if (paintSeen?.has(el)) return;
    paintSeen?.add(el);
    if (heldItem) client.send({ type: 'invPlace', to: ref, one: true });
    else client.send({ type: 'invPickUp', from: ref, half: true });
  }

  /** `count` fresh `.inventory-slot` buttons wired to left/right click on `{ zone: 'inventory', index: indexOffset + i }` - the shared building block for every inventory-slot grid below (backpack's own 27, the mirrored hotbar rows in both panels, and the table's 27). */
  function makeInventorySlotButtons(count: number, indexOffset: number): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    for (let i = 0; i < count; i++) {
      const btn = document.createElement('button');
      btn.className = 'inventory-slot';
      btn.type = 'button';
      const ref: CraftSlotRef = { zone: 'inventory', index: indexOffset + i };
      slotRefByEl.set(btn, ref);
      btn.addEventListener('click', () => onSlotClick(ref));
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSlotRightClick(ref, btn); });
      out.push(btn);
    }
    return out;
  }
  /** `count` fresh `.inventory-slot` buttons for a crafting grid's own cells (zone:'grid'), same wiring pattern as makeInventorySlotButtons. */
  function makeCraftSlotButtons(count: number): HTMLButtonElement[] {
    const out: HTMLButtonElement[] = [];
    for (let i = 0; i < count; i++) {
      const btn = document.createElement('button');
      btn.className = 'inventory-slot craft-slot';
      btn.type = 'button';
      const ref: CraftSlotRef = { zone: 'grid', index: i };
      slotRefByEl.set(btn, ref);
      btn.addEventListener('click', () => onSlotClick(ref));
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSlotRightClick(ref, btn); });
      out.push(btn);
    }
    return out;
  }

  /**
   * Backpack (E): singleplayer's real GUI texture (gui/inventory.png) with
   * the personal 2x2 crafting grid embedded in it, not a separate C-toggled
   * panel - same layout `#backpack`/`#backpack-panel` use, mirrored here
   * under mp- ids (see style.css) since main.ts's own #backpack is a
   * different DOM tree bound to singleplayer's Inventory class.
   *
   * Opening the backpack also opens a side-2 crafting grid server-side
   * (`craftOpen({ table: null })`) - the 2x2 is real crafting-grid state the
   * whole time the backpack is up, not a cosmetic 4 buttons.
   */
  const backpackEl = document.createElement('div');
  backpackEl.id = 'mp-backpack';
  backpackEl.hidden = true;
  const backpackPanelEl = document.createElement('div');
  backpackPanelEl.id = 'mp-backpack-panel';
  const backpackCraftEl = document.createElement('div');
  backpackCraftEl.id = 'mp-backpack-craft';
  const backpackCraftEls = makeCraftSlotButtons(4);
  backpackCraftEls.forEach((el) => backpackCraftEl.appendChild(el));
  const backpackCraftResultEl = document.createElement('button');
  backpackCraftResultEl.type = 'button';
  backpackCraftResultEl.className = 'inventory-slot craft-result';
  backpackCraftResultEl.addEventListener('click', () => client.send({ type: 'craftTakeOutput' }));
  const backpackGridEl = document.createElement('div');
  backpackGridEl.id = 'mp-backpack-grid';
  const backpackGridEls = makeInventorySlotButtons(TOTAL_SLOTS - HOTBAR_SIZE, HOTBAR_SIZE);
  backpackGridEls.forEach((el) => backpackGridEl.appendChild(el));
  const backpackHotbarEl = document.createElement('div');
  backpackHotbarEl.id = 'mp-backpack-hotbar';
  const backpackHotbarEls = makeInventorySlotButtons(HOTBAR_SIZE, 0);
  backpackHotbarEls.forEach((el) => backpackHotbarEl.appendChild(el));
  // Paper-doll preview, same class and coordinates as singleplayer's own
  // #backpack-doll (style.css:182-191) - #mp-backpack-panel uses the exact
  // same inventory.png background/coordinate system, so the empty well to
  // the left of the 2x2 grid is in the same spot here.
  const backpackDollEl = document.createElement('canvas');
  backpackDollEl.id = 'mp-backpack-doll';
  backpackDollEl.setAttribute('aria-hidden', 'true');
  backpackPanelEl.append(backpackDollEl, backpackCraftEl, backpackCraftResultEl, backpackGridEl, backpackHotbarEl);
  backpackEl.appendChild(backpackPanelEl);
  document.body.appendChild(backpackEl);
  // Same delegated UI click as pause-menu.ts's own root listener.
  backpackEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) playClick();
  });
  // Right-click on empty space (not a recognised slot, which stops this via
  // stopPropagation) while holding something puts it back - same as
  // singleplayer's document-level cancelHeld() only ever reached when the
  // click didn't land on a slot in the first place.
  backpackEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (heldItem) client.send({ type: 'invCancel' }); });
  const backpackDoll = new InventoryDoll({ canvasSelector: '#mp-backpack-doll', containerSelector: '#mp-backpack' });
  backpackDoll.setSlim(mpSettings.alexSkin);

  let backpackOpen = false;
  function renderBackpack(): void {
    backpackCraftEls.forEach((el, i) => renderSlot(el, craftInputs[i] ?? createEmptySlot()));
    renderSlot(backpackCraftResultEl, craftOutput);
    for (let i = 0; i < backpackGridEls.length; i++) {
      renderSlot(backpackGridEls[i], inventorySlots[HOTBAR_SIZE + i] ?? createEmptySlot());
    }
    for (let i = 0; i < backpackHotbarEls.length; i++) {
      renderSlot(backpackHotbarEls[i], inventorySlots[i] ?? createEmptySlot());
    }
  }
  function setBackpackOpen(open: boolean): void {
    backpackOpen = open;
    backpackEl.hidden = !open;
    backpackDoll.setActive(open);
    if (open) {
      craftSide = 2;
      client.send({ type: 'craftOpen', table: null });
      renderBackpack();
      unlockPointerForGui();
    } else {
      client.send({ type: 'craftClose' });
      lockPointer(canvas);
      hideTooltip();
    }
  }

  /**
   * Crafting table (right-click a placed one): the real 3x3, singleplayer's
   * `#crafting-table`/`#crafting-table-panel` (gui/Crafting_table_gui.png)
   * mirrored the same way the backpack above is. Only a real table grants
   * this - world-do.ts's openCraftGrid checks the block itself, a client
   * can't just ask for the bigger grid.
   */
  const tableEl = document.createElement('div');
  tableEl.id = 'mp-crafting-table';
  tableEl.hidden = true;
  const tablePanelEl = document.createElement('div');
  tablePanelEl.id = 'mp-crafting-table-panel';
  const tableCraftEl = document.createElement('div');
  tableCraftEl.id = 'mp-ct-craft';
  const tableCraftEls = makeCraftSlotButtons(9);
  tableCraftEls.forEach((el) => tableCraftEl.appendChild(el));
  const tableCraftResultEl = document.createElement('button');
  tableCraftResultEl.type = 'button';
  tableCraftResultEl.className = 'inventory-slot ct-result';
  tableCraftResultEl.addEventListener('click', () => client.send({ type: 'craftTakeOutput' }));
  const tableBackpackEl = document.createElement('div');
  tableBackpackEl.id = 'mp-ct-backpack';
  const tableBackpackEls = makeInventorySlotButtons(TOTAL_SLOTS - HOTBAR_SIZE, HOTBAR_SIZE);
  tableBackpackEls.forEach((el) => tableBackpackEl.appendChild(el));
  const tableHotbarEl = document.createElement('div');
  tableHotbarEl.id = 'mp-ct-hotbar';
  const tableHotbarEls = makeInventorySlotButtons(HOTBAR_SIZE, 0);
  tableHotbarEls.forEach((el) => tableHotbarEl.appendChild(el));
  tablePanelEl.append(tableCraftEl, tableCraftResultEl, tableBackpackEl, tableHotbarEl);
  tableEl.appendChild(tablePanelEl);
  document.body.appendChild(tableEl);
  tableEl.addEventListener('contextmenu', (e) => { e.preventDefault(); if (heldItem) client.send({ type: 'invCancel' }); });
  tableEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) playClick();
  });

  let tableOpen = false;
  function renderTable(): void {
    tableCraftEls.forEach((el, i) => renderSlot(el, craftInputs[i] ?? createEmptySlot()));
    renderSlot(tableCraftResultEl, craftOutput);
    for (let i = 0; i < tableBackpackEls.length; i++) {
      renderSlot(tableBackpackEls[i], inventorySlots[HOTBAR_SIZE + i] ?? createEmptySlot());
    }
    for (let i = 0; i < tableHotbarEls.length; i++) {
      renderSlot(tableHotbarEls[i], inventorySlots[i] ?? createEmptySlot());
    }
  }
  function setTableOpen(open: boolean, table: { x: number; y: number; z: number } | null = null): void {
    tableOpen = open;
    tableEl.hidden = !open;
    if (open) {
      craftSide = 3;
      client.send({ type: 'craftOpen', table });
      renderTable();
      unlockPointerForGui();
    } else {
      client.send({ type: 'craftClose' });
      lockPointer(canvas);
      hideTooltip();
    }
  }

  /**
   * Death screen. Built here rather than reusing singleplayer's own
   * #death-screen section: main.ts already binds its buttons to the
   * singleplayer respawn path, so sharing the element would run that world's
   * respawn logic from inside a multiplayer session.
   *
   * The server holds the player dead until the button is pressed (see
   * protocol.ts's `died`/`respawn`), so this isn't just a visual - it's what
   * actually ends the death.
   */
  /**
   * Flames licking up the screen while burning. Its own element rather than
   * singleplayer's #fire-screen-overlay for the same reason as the death
   * screen: main.ts's loop keeps running behind this session and toggles that
   * one from its OWN (always false here) fire state every frame, which would
   * fight this one for control of the class.
   */
  const fireOverlayEl = document.createElement('div');
  fireOverlayEl.id = 'mp-fire-overlay';
  fireOverlayEl.setAttribute('aria-hidden', 'true');
  document.body.appendChild(fireOverlayEl);

  /**
   * Real networked chat: press T (or the touch chat button) to type, Enter
   * to send. There's no local echo on submit - the server's own broadcast
   * (world-do.ts's `case 'chat'`) goes to every connected session INCLUDING
   * the sender, so this only ever prints what actually reached the server,
   * never a message that looked sent but got dropped by the socket.
   *
   * Own element rather than singleplayer's #chat, for the same reason as the
   * death screen and overlays: that one is bound to `loadPlayerName()`/its
   * own slash-command dispatcher, and main.ts's Chat instance lives for the
   * whole page - see setSingleplayerChatEnabled's doc comment for how the
   * "T" key itself is handed over for the duration of this session.
   */
  const chatEl = document.createElement('div');
  chatEl.id = 'mp-chat';
  const chatLogEl = document.createElement('div');
  chatLogEl.id = 'mp-chat-log';
  const chatInputEl = document.createElement('input');
  chatInputEl.id = 'mp-chat-input';
  chatInputEl.type = 'text';
  chatInputEl.maxLength = 256;
  chatInputEl.autocomplete = 'off';
  chatInputEl.spellcheck = false;
  chatInputEl.hidden = true;
  chatEl.append(chatLogEl, chatInputEl);
  document.body.appendChild(chatEl);
  let chatOpen = false;

  const CHAT_LINE_LIFETIME_MS = 15000;
  function addChatLine(text: string): void {
    const line = document.createElement('div');
    line.className = 'mp-chat-line';
    line.textContent = text;
    chatLogEl.appendChild(line);
    while (chatLogEl.children.length > 50) chatLogEl.firstElementChild!.remove();
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
    // Each line times out on its OWN clock rather than a single shared timer,
    // so an old line doesn't get its lifetime reset just because a new one
    // arrived - it disappears 15s after it was added, independent of chat
    // activity around it.
    setTimeout(() => line.remove(), CHAT_LINE_LIFETIME_MS);
  }

  function openChat(): void {
    chatOpen = true;
    chatInputEl.hidden = false;
    chatInputEl.value = '';
    document.exitPointerLock();
    chatInputEl.focus(); // from the T press/tap's own gesture, so a phone's soft keyboard is allowed to open
  }

  function closeChat(regrabPointer: boolean): void {
    chatOpen = false;
    chatInputEl.hidden = true;
    chatInputEl.blur();
    if (regrabPointer) lockPointer(canvas);
  }

  chatInputEl.addEventListener('keydown', (e) => {
    // Stop this from ALSO reaching the document-level onKeyDown below -
    // without it, typing "e"/"c"/"q"/a digit while chatting would toggle the
    // backpack, the craft menu, drop the held item, or change hotbar slot,
    // and an Escape meant to cancel the message would also disconnect (that
    // key doubles as "leave the world" while not typing).
    e.stopPropagation();
    if (e.key === 'Enter') {
      const text = chatInputEl.value.trim();
      if (text.length > 0) client.send({ type: 'chat', text });
      closeChat(true);
    } else if (e.key === 'Escape') {
      closeChat(true);
    }
  });
  // Losing focus any other way (tapping elsewhere on a phone, alt-tab) must
  // still clear `chatOpen` - otherwise sendInput()'s movement guard below
  // would stay stuck thinking the player is chatting forever.
  chatInputEl.addEventListener('blur', () => { if (chatOpen) closeChat(false); });

  const deathEl = document.createElement('div');
  deathEl.id = 'mp-death-screen';
  deathEl.hidden = true;
  const deathTitle = document.createElement('h1');
  deathTitle.textContent = 'Game Over';
  const deathCause = document.createElement('p');
  const deathRespawnBtn = document.createElement('button');
  deathRespawnBtn.className = 'mc-button';
  deathRespawnBtn.type = 'button';
  deathRespawnBtn.innerHTML = '<span>Respawn</span>';
  deathEl.append(deathTitle, deathCause, deathRespawnBtn);
  document.body.appendChild(deathEl);
  let isDead = false;

  deathRespawnBtn.addEventListener('click', () => {
    if (!isDead) return;
    isDead = false;
    deathEl.hidden = true;
    client.send({ type: 'respawn' });
    lockPointer(canvas);
  });

  /** Which side grid is currently open (2 = backpack's own, 3 = a real table) - only meaningful while one of backpackOpen/tableOpen is true, but kept as one flag since only one can be open at a time and both renderBackpack()/renderTable() read the same craftInputs/craftOutput either way. */
  let craftSide: 2 | 3 = 2;
  let craftInputs: InventorySlot[] = [];
  let craftOutput: InventorySlot = createEmptySlot();

  /**
   * Furnace GUI: right-click a placed furnace block to open it. Input/fuel
   * are real cursor-follows-mouse slots now (same invPickUp/invPlace model
   * as the backpack/table, see onSlotClick/onSlotRightClick above) instead
   * of "Meter combustible"/"Meter para fundir" buttons that only ever took
   * the selected hotbar slot's whole stack - and the player's own inventory
   * is mirrored into the panel (like singleplayer's #furnace-backpack/
   * #furnace-hotbar) so it's visible and usable while the furnace is open,
   * not just the three furnace slots. Output stays its own thing (click to
   * collect straight into the inventory) - it was never a "place into"
   * target even in singleplayer (bindExternalSlot's takeOnly).
   */
  const furnaceEl = document.createElement('div');
  furnaceEl.id = 'mp-furnace';
  furnaceEl.hidden = true;
  const furnaceInputSlot = document.createElement('button');
  furnaceInputSlot.id = 'mp-furnace-input';
  const furnaceFuelSlot = document.createElement('button');
  furnaceFuelSlot.id = 'mp-furnace-fuel';
  const furnaceOutputSlot = document.createElement('button');
  furnaceOutputSlot.id = 'mp-furnace-output';
  for (const btn of [furnaceInputSlot, furnaceFuelSlot, furnaceOutputSlot]) { btn.className = 'inventory-slot'; btn.type = 'button'; }
  const furnaceInputRef: CraftSlotRef = { zone: 'furnaceInput', index: 0 };
  const furnaceFuelRef: CraftSlotRef = { zone: 'furnaceFuel', index: 0 };
  slotRefByEl.set(furnaceInputSlot, furnaceInputRef);
  slotRefByEl.set(furnaceFuelSlot, furnaceFuelRef);
  furnaceInputSlot.addEventListener('click', () => onSlotClick(furnaceInputRef));
  furnaceInputSlot.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSlotRightClick(furnaceInputRef, furnaceInputSlot); });
  furnaceFuelSlot.addEventListener('click', () => onSlotClick(furnaceFuelRef));
  furnaceFuelSlot.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); onSlotRightClick(furnaceFuelRef, furnaceFuelSlot); });
  furnaceOutputSlot.addEventListener('click', () => {
    if (furnacePos) client.send({ type: 'furnaceTakeOutput', ...furnacePos });
  });
  const furnaceFlame = document.createElement('div');
  furnaceFlame.id = 'mp-furnace-flame';
  const furnaceArrow = document.createElement('div');
  furnaceArrow.id = 'mp-furnace-arrow';
  // Mirrored inventory, same coordinates/pattern as the backpack/table's own
  // grid+hotbar - lets the player see and move items while at the furnace
  // instead of only being able to act on their blind SELECTED slot.
  const furnaceBackpackEl = document.createElement('div');
  furnaceBackpackEl.id = 'mp-furnace-backpack';
  const furnaceBackpackEls = makeInventorySlotButtons(TOTAL_SLOTS - HOTBAR_SIZE, HOTBAR_SIZE);
  furnaceBackpackEls.forEach((el) => furnaceBackpackEl.appendChild(el));
  const furnaceHotbarEl = document.createElement('div');
  furnaceHotbarEl.id = 'mp-furnace-hotbar';
  const furnaceHotbarEls = makeInventorySlotButtons(HOTBAR_SIZE, 0);
  furnaceHotbarEls.forEach((el) => furnaceHotbarEl.appendChild(el));
  const furnacePanel = document.createElement('div');
  furnacePanel.id = 'mp-furnace-panel';
  furnacePanel.append(
    furnaceFlame, furnaceArrow, furnaceInputSlot, furnaceFuelSlot, furnaceOutputSlot,
    furnaceBackpackEl, furnaceHotbarEl,
  );
  furnaceEl.appendChild(furnacePanel);
  document.body.appendChild(furnaceEl);
  furnaceEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) playClick();
  });
  let furnacePos: { x: number; y: number; z: number } | null = null;
  let furnaceOpenState = false;
  /** furnace.ts's FurnaceState only stores {id,count} (SlotRef) - not the name/texture renderSlot() needs - so this fills that in the same way world-do.ts's describeSlot() does for the real inventory. */
  function furnaceSlotToInventorySlot(ref: { id: number; count: number } | null): InventorySlot {
    if (!ref) return createEmptySlot();
    if (isBlock(ref.id)) {
      const catalogEntry = BLOCK_CATALOG.find((b) => b.id === ref.id);
      return catalogEntry ? { ...catalogEntry, count: ref.count } : { id: ref.id, name: 'Block', count: ref.count };
    }
    const def = ITEMS[ref.id];
    return { id: ref.id, name: def?.name ?? 'Item', sideTexture: def?.texture, count: ref.count };
  }
  function renderFurnace(state: { input: { id: number; count: number } | null; fuel: { id: number; count: number } | null; output: { id: number; count: number } | null; cookTime: number; litTime: number; litDuration: number }): void {
    renderSlot(furnaceInputSlot, furnaceSlotToInventorySlot(state.input));
    renderSlot(furnaceFuelSlot, furnaceSlotToInventorySlot(state.fuel));
    renderSlot(furnaceOutputSlot, furnaceSlotToInventorySlot(state.output));
    // Same clip-path gauges as singleplayer's #furnace-arrow/#furnace-flame
    // (style.css:297-323) instead of the old width%-based generic bars.
    const cookPct = Math.min(1, state.cookTime / COOK_SECONDS) * 100;
    furnaceArrow.style.clipPath = `inset(0 ${100 - cookPct}% 0 0)`;
    const litPct = state.litDuration > 0 ? (state.litTime / state.litDuration) * 100 : 0;
    furnaceFlame.style.clipPath = `inset(${100 - litPct}% 0 0 0)`;
    for (let i = 0; i < furnaceBackpackEls.length; i++) {
      renderSlot(furnaceBackpackEls[i], inventorySlots[HOTBAR_SIZE + i] ?? createEmptySlot());
    }
    for (let i = 0; i < furnaceHotbarEls.length; i++) {
      renderSlot(furnaceHotbarEls[i], inventorySlots[i] ?? createEmptySlot());
    }
  }
  function setFurnaceOpen(open: boolean, pos?: { x: number; y: number; z: number }): void {
    furnaceOpenState = open;
    furnaceEl.hidden = !open;
    if (open && pos) {
      furnacePos = pos;
      client.send({ type: 'furnaceOpen', x: pos.x, y: pos.y, z: pos.z });
      unlockPointerForGui();
    } else {
      if (heldItem) client.send({ type: 'invCancel' });
      if (furnacePos) client.send({ type: 'furnaceClose' });
      furnacePos = null;
      lockPointer(canvas);
      hideTooltip();
    }
  }

  let yaw = 0;
  let pitch = 0;
  let seq = 0;
  let running = true;
  const lastServerPos = new THREE.Vector3(0, 2, 0);
  /** World-space movement since the last server tick, for the local third-person body's walk animation - see onState below for why this is a position delta rather than the server's raw velocity. */
  let localMoveDeltaX = 0;
  let localMoveDeltaZ = 0;
  /** Fed once per server tick (onState), since that's the only cadence we get real position/velocity samples at - same ViewBob class singleplayer's player.ts drives every frame from local physics. */
  const viewBob = new ViewBob();
  let lastStateTimeMs = 0;

  /**
   * Hitbox wireframes (R) - the exact meshes onMouseDown already raycasts
   * against for attack targeting (player/mob hitboxes, see
   * buildPlayerHitbox and makeMobAvatar), not a separate set of debug boxes:
   * they're built invisible by default and this just flips `.visible` on
   * every one currently in `remoteEntities`, plus seeds new ones with the
   * current state so an entity that spawns while debug is already on
   * doesn't start invisible.
   */
  let hitboxDebug = false;
  function toggleHitboxDebug(): void {
    hitboxDebug = !hitboxDebug;
    for (const entity of remoteEntities.values()) {
      (entity.hitbox.material as THREE.MeshBasicMaterial).visible = hitboxDebug;
    }
  }

  /**
   * Diagnostics panel (O) - singleplayer's own Diagnostics class
   * (src/diagnostics.ts) is built around a singleplayer `World`/`player`
   * this client doesn't have, so this is its own lean readout of whatever
   * multiplayer-game.ts already tracks: no new measurements invented for it,
   * just surfaced. `pingMs` starts null (no round trip completed yet) and is
   * updated by onPong below.
   */
  const diagnosticsEl = document.createElement('div');
  diagnosticsEl.id = 'mp-diagnostics';
  diagnosticsEl.hidden = true;
  document.body.appendChild(diagnosticsEl);
  let diagnosticsOpen = false;
  let pingMs: number | null = null;
  let fps = 0;

  function renderDiagnostics(): void {
    if (!diagnosticsOpen) return;
    const p = lastServerPos;
    diagnosticsEl.textContent = [
      `FPS: ${fps.toFixed(0)}`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Yaw/Pitch: ${(yaw * 180 / Math.PI).toFixed(1)} / ${(pitch * 180 / Math.PI).toFixed(1)}`,
      `Chunks loaded: ${chunks.size}`,
      `Entities: ${remoteEntities.size}`,
      `Camera mode: ${cameraMode === 0 ? 'first-person' : cameraMode === 1 ? 'third-person' : 'third-person-front'}`,
      `Day time: ${clientDayTime.toFixed(0)}s`,
      `Ping: ${pingMs === null ? '...' : `${pingMs.toFixed(0)}ms`}`,
    ].join('\n');
  }

  // A ping every couple of seconds is plenty for a diagnostics readout - this
  // isn't driving any gameplay decision, just a number on a debug panel.
  const PING_INTERVAL_MS = 2000;
  let lastPingSentAt = 0;
  function updatePing(now: number): void {
    if (now - lastPingSentAt < PING_INTERVAL_MS) return;
    lastPingSentAt = now;
    client.send({ type: 'ping', clientTimeMs: now });
  }

  /**
   * Pause/options panel (Tab) - copies singleplayer's real #pause-menu DOM
   * shape and CSS classes (.pause-view/.texture-button/.slider-row, see
   * style.css) instead of a bespoke one-view panel, per explicit request to
   * make it look and behave the same: a "Game Paused" view with Back to
   * Game/Options/Leave World, and a separate Options view with the sliders,
   * switched between exactly like pause-menu.ts's own showOptions(). Own
   * element rather than singleplayer's actual #pause-menu instance for the
   * same reason as chat/death/overlays: that one is PauseMenu's own DOM and
   * main.ts's instance lives for the whole page (guarded off for the
   * duration of this session by setSingleplayerPauseMenuEnabled, same
   * pattern as the chat "T" guard).
   *
   * Only sliders that actually DO something in this client are here -
   * render distance is deliberately left out: raising it past
   * SIMULATION_RADIUS_CHUNKS (game/active-region.ts, server-side) would show
   * frozen mobs/fire sitting motionless at the edge of view, so it isn't a
   * safe knob to hand the player without also plumbing a server-side cap
   * negotiation that doesn't exist yet.
   */
  const optionsEl = document.createElement('div');
  optionsEl.id = 'mp-options';
  optionsEl.hidden = true;

  function makeSlider(label: string, min: number, max: number, value: number, onInput: (v: number) => void): HTMLElement {
    const row = document.createElement('label');
    row.className = 'slider-row';
    const text = document.createElement('span');
    const out = document.createElement('output');
    out.textContent = String(value);
    text.append(`${label}: `, out);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = String(v);
      onInput(v);
    });
    row.append(text, input);
    return row;
  }
  function makeButton(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'texture-button';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  const pausedViewEl = document.createElement('div');
  pausedViewEl.className = 'pause-view';
  const pausedHeading = document.createElement('h1');
  pausedHeading.textContent = 'Game Paused';
  const backToGameBtn = makeButton('Back to Game', () => toggleOptionsPanel());
  const openOptionsBtn = makeButton('Options', () => showOptionsView(true));
  const leaveBtn = makeButton('Leave World', () => disconnect('Disconnected'));
  pausedViewEl.append(pausedHeading, backToGameBtn, openOptionsBtn, leaveBtn);

  const optionsViewEl = document.createElement('div');
  optionsViewEl.className = 'pause-view';
  optionsViewEl.hidden = true;
  const optionsHeading = document.createElement('h1');
  optionsHeading.textContent = 'Options';
  const sensitivityRow = makeSlider('Mouse Sensitivity', 1, 200, mpSettings.sensitivity, (v) => {
    sensitivityScale = v / 100;
    saveSettings({ sensitivity: v });
  });
  // Kept separate from camera.fov itself (mirrors pause-menu.ts's own
  // fovSlider vs camera.fov split) because the underwater dip below needs
  // its own baseline to subtract from every frame, not the last value it
  // itself wrote.
  let baseFov = mpSettings.fov;
  const fovRow = makeSlider('FOV', 30, 110, mpSettings.fov, (v) => {
    baseFov = v;
    saveSettings({ fov: v });
  });
  optionsViewEl.append(optionsHeading, fovRow, sensitivityRow);
  // Touch-only controls: meaningless (and disabled in singleplayer's own
  // panel too) on a device with no on-screen buttons or touch-drag look.
  if (isTouchDevice()) {
    const opacityRow = makeSlider('Button Opacity', 10, 100, mpSettings.buttonOpacity, (v) => {
      touchControls?.setButtonOpacity(v);
      saveSettings({ buttonOpacity: v });
    });
    optionsViewEl.appendChild(opacityRow);
  }
  const optionsBackBtn = makeButton('Back', () => showOptionsView(false));
  optionsViewEl.appendChild(optionsBackBtn);

  optionsEl.append(pausedViewEl, optionsViewEl);
  document.body.appendChild(optionsEl);
  optionsEl.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('button')) playClick();
  });

  /** Same showOptions(show) split as pause-menu.ts - swap which of the two views is visible without closing the whole panel. */
  function showOptionsView(show: boolean): void {
    pausedViewEl.hidden = show;
    optionsViewEl.hidden = !show;
  }

  let optionsOpen = false;
  function toggleOptionsPanel(): void {
    optionsOpen = !optionsOpen;
    optionsEl.hidden = !optionsOpen;
    if (optionsOpen) { showOptionsView(false); unlockPointerForGui(); } else { lockPointer(canvas); }
  }

  /** Decoded once per skin string and cached, since the same data: URL is re-sent to every client and shouldn't be re-decoded per remote avatar. `null` (the default skin) and a load failure both resolve to `null` - createSkinMaterials(null) already falls back to the built-in skin. Declared here (rather than down by playerSkins, where it used to live) because buildLocalPlayerModel below calls loadSkinImage() immediately, not from a deferred callback - it needs skinImageCache to already exist. */
  const skinImageCache = new Map<string, Promise<HTMLImageElement | null>>();
  function loadSkinImage(dataUrl: string | null): Promise<HTMLImageElement | null> {
    if (!dataUrl) return Promise.resolve(null);
    let p = skinImageCache.get(dataUrl);
    if (!p) {
      p = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = dataUrl;
      });
      skinImageCache.set(dataUrl, p);
    }
    return p;
  }

  /**
   * Third-person camera + this player's own visible body (LCE F5 cycle: 0
   * first person, 1 behind, 2 in front looking back). First person renders
   * no local avatar at all - the camera IS the eye, same as singleplayer's
   * own first-person mode hides its player model.
   *
   * The camera math (thirdPersonCameraPosition) is the exact function
   * player.ts's PlayerController extracted its own boom into, so both modes
   * feel identical - see third-person-camera.ts's doc comment for why that
   * was pulled out rather than written twice.
   */
  let cameraMode: 0 | 1 | 2 = 0;
  let localPlayerModel: PlayerModel | null = null;
  let localSkinMaterials: PlayerSkinMaterials | null = null;

  function buildLocalPlayerModel(materials: PlayerSkinMaterials): void {
    if (localPlayerModel) {
      scene.remove(localPlayerModel.group);
      disposeGroupGeometries(localPlayerModel.group);
      disposeSkinMaterials(localSkinMaterials!);
    }
    localPlayerModel = new PlayerModel(materials);
    localPlayerModel.setVisible(cameraMode !== 0);
    scene.add(localPlayerModel.group);
    localSkinMaterials = materials;
  }
  void loadSkinImage(loadPlayerSkinDataUrl()).then((img) => buildLocalPlayerModel(createSkinMaterials(img)));

  function cycleCameraMode(): void {
    cameraMode = ((cameraMode + 1) % 3) as 0 | 1 | 2;
    localPlayerModel?.setVisible(cameraMode !== 0);
  }

  /** Solid-block test for the third-person boom's collision, straight from this client's own streamed chunks - not the server, since this is purely a local camera concern. */
  const isSolidAtLocal = (x: number, y: number, z: number) => isSolidBlock(getBlock(x, y, z));

  const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];
  const keys = new Set<string>();
  /**
   * Double-tap-forward-style sprint toggle, same as player.ts's own
   * setSprint(): Ctrl only needs a single press (while already moving) to
   * turn sprint ON, and it clears itself the instant the player stops
   * moving (sendInput below) - not "held the whole time", which is what
   * sending `keys.has('ControlLeft')` directly used to do.
   */
  let sprintToggled = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'KeyT' && !chatOpen) {
      // Without this, the same keydown that opens the input (focusing it
      // synchronously below) still runs its default browser behavior -
      // typing a literal "t" into the now-focused field the instant it opens.
      e.preventDefault();
      openChat();
      return;
    } // opens even over another panel, same as singleplayer's own T
    keys.add(e.code);
    if (e.code === 'Escape') disconnect('Disconnected');
    if (e.code === 'ControlLeft' && !e.repeat && (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD') || touchMoveX !== 0 || touchMoveZ !== 0)) {
      sprintToggled = true;
    }
    if (e.code === 'KeyI') { cycleCameraMode(); return; } // same key singleplayer's player.ts cycles F5's 3 modes on
    if (e.code === 'KeyO' && !e.repeat) { diagnosticsOpen = !diagnosticsOpen; diagnosticsEl.hidden = !diagnosticsOpen; return; } // same key singleplayer's Diagnostics.toggle() uses
    if (e.code === 'KeyR' && !e.repeat) { toggleHitboxDebug(); return; } // same key singleplayer's dropDebug toggle uses
    if (e.code === 'Tab') {
      e.preventDefault();
      // Don't stack it on top of another panel - closing is always allowed
      // (getting back OUT of options can't be blocked by anything), opening
      // is refused while backpack/table/furnace already have the pointer.
      if (optionsOpen || !(tableOpen || backpackOpen || furnaceOpenState)) toggleOptionsPanel();
      return;
    }
    if (e.code === 'KeyE' && !optionsOpen) {
      // E closes the table instead of opening the backpack over it, same
      // reasoning as the furnace branch right below - only one panel at a
      // time. There's no C shortcut any more: the 2x2 lives inside the
      // backpack now (setBackpackOpen opens it server-side too), so E alone
      // covers "personal crafting", matching singleplayer's own E.
      if (tableOpen) { setTableOpen(false); return; }
      if (furnaceOpenState) { setFurnaceOpen(false); return; }
      setBackpackOpen(!backpackOpen);
      return;
    }
    if (tableOpen || backpackOpen || furnaceOpenState || optionsOpen) return; // don't move/select slots while a menu has the pointer
    const digitIndex = DIGIT_CODES.indexOf(e.code);
    if (digitIndex !== -1) client.send({ type: 'selectSlot', index: digitIndex });
    if (e.code === 'KeyQ') {
      const dir = camera.getWorldDirection(new THREE.Vector3());
      // Same split as singleplayer's interaction.ts onDropSelected(ctrlKey):
      // plain Q drops one item, Ctrl+Q drops the whole stack.
      client.send({ type: 'dropItem', dir: { x: dir.x, y: dir.y, z: dir.z }, all: e.ctrlKey });
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * MOUSE_SENSITIVITY_BASE * sensitivityScale;
    pitch -= e.movementY * MOUSE_SENSITIVITY_BASE * sensitivityScale;
    pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  };
  document.addEventListener('mousemove', onMouseMove);

  // Hotbar slot switch by scroll wheel - same circular formula and the same
  // "only while actually playing" gate as singleplayer's Inventory.onWheel
  // (src/inventory.ts:814-828), just re-derived here since this client keeps
  // its own selectedSlotIndex/panel-open flags instead of that class.
  const onWheel = (e: WheelEvent) => {
    if (tableOpen || backpackOpen || furnaceOpenState || optionsOpen || chatOpen) return;
    if (document.pointerLockElement !== canvas) return;
    e.preventDefault();
    const direction = e.deltaY > 0 ? 1 : -1;
    const next = (selectedSlotIndex + direction + HOTBAR_SIZE) % HOTBAR_SIZE;
    client.send({ type: 'selectSlot', index: next });
  };
  document.addEventListener('wheel', onWheel, { passive: false });

  // --- Touch (Android/mobile) input state - see TouchControls wiring below.
  // Mirrors main.ts's desktop-vs-touch split: keyboard/mouse drive `keys`
  // directly, touch drives these instead, and sendInput() merges both so
  // either input method (or both, on a hybrid device) works.
  let touchMoveX = 0, touchMoveZ = 0;
  let touchJump = false, touchSprint = false, touchSneak = false;
  /** Freeform aim point (NDC), wherever the finger currently is - unlike the
   * mouse's fixed centre crosshair. Cleared (null) when no finger is down. */
  let touchAimNdc: THREE.Vector2 | null = null;

  // Same block-position-from-hit formula as raycast.ts's resolveBlockPosition
  // (minus its fire-plane special case, not relevant here): nudge the hit
  // point slightly INTO the face along its normal before rounding, so it
  // lands on the block that was actually hit rather than its neighbour.
  const raycaster = new THREE.Raycaster();
  /** Shared by the mouse's click handler and touch's tap/hold/attack handlers - `ndc` is (0,0) for the mouse's fixed centre crosshair, or the finger's freeform aim point for touch. */
  // Purely local chew feedback while the server runs the real bite. Matches
  // singleplayer's EAT_DURATION / EAT_TICK so both modes sound the same.
  const EAT_DURATION = 1.6;
  const EAT_TICK = 0.175;
  let chewLeft = 0;
  let chewTickTimer = 0;
  function startChewing(): void {
    chewLeft = EAT_DURATION;
    chewTickTimer = 0;
  }
  function updateChewing(delta: number): void {
    if (chewLeft <= 0) return;
    chewLeft -= delta;
    chewTickTimer += delta;
    if (chewTickTimer >= EAT_TICK) {
      chewTickTimer -= EAT_TICK;
      soundManager.playRandom('player/Eat', 3, 0.7);
    }
  }

  /**
   * Raycasts for the block under `ndc` (terrain meshes only, not entities -
   * mining specifically targets a block, unlike performInteraction below
   * which has to choose between a block and an entity for break/attack).
   * Shared by performInteraction's own logic used to and by the mining state
   * machine below, which needs to re-run this every frame while the button
   * is held to know whether the player is still looking at the same block.
   */
  function raycastBlockTarget(ndc: THREE.Vector2): { x: number; y: number; z: number; id: BlockId; normal: THREE.Vector3 } | null {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(chunkMeshes, false);
    for (const hit of hits) {
      if (hit.distance > REACH || !hit.face) break; // sorted by distance - nothing past REACH is worth checking
      const normal = hit.face.normal;
      const b = hit.point.clone().addScaledVector(normal, -0.01).round();
      const id = getBlock(b.x, b.y, b.z);
      // Same as src/raycast.ts's own DDA walk (`if (id === BlockId.WATER)
      // continue`) - water is never a mineable/targetable surface, the ray
      // passes straight through it to whatever's actually behind/under it.
      if (id === BlockId.WATER) continue;
      return { x: b.x, y: b.y, z: b.z, id, normal };
    }
    return null;
  }

  /**
   * Real mining: how long a dig takes (and whether it drops anything) comes
   * from breakTime() (src/block-hardness.ts, pure - same formula
   * singleplayer's interaction.ts uses), driven every frame while the mine
   * button is held rather than sending `breakBlock` the instant it's
   * pressed. The server re-derives the same duration itself and rejects
   * anything that arrives too early (world-do.ts's handleBreakBlock) - this
   * client-side timer is purely what makes the wait feel real (the break
   * overlay, the chip sound/particles), never something the server trusts.
   */
  type MiningState = { x: number; y: number; z: number; id: BlockId; elapsed: number; total: number };
  let mining: MiningState | null = null;
  let miningChipTimer = 0;
  const MINING_CHIP_INTERVAL = 0.18; // matches interaction.ts's own CHIP_INTERVAL
  let leftHeld = false; // desktop: mouse button 0 currently down
  let touchMiningHeld = false; // touch: the hold-to-break gesture is active (onBreakStart/onBreakEnd below)
  const breakOverlay = new BreakOverlay();
  breakOverlay.attachToScene(scene);
  // Black wireframe outline on whatever block the player is aiming at - was
  // never ported at all (BlockHighlight, imported below, wasn't even
  // referenced in this file). shapeBoxesFor's readData is a bare `() =>
  // undefined`, same as this client's own chunk mesher: multiplayer doesn't
  // track per-block orientation data yet (Fase 5 of
  // PLAN-MULTIPLAYER-MISSING-FEATURES.md), so stairs/slabs render at their
  // default shape both in the world mesh AND here - consistent with each
  // other today, and both will pick up the real orientation together once
  // that fase lands.
  const blockHighlight = new BlockHighlight();
  blockHighlight.attachToScene(scene);
  function updateBlockHighlight(): void {
    const ndc = document.pointerLockElement === canvas ? CENTER_NDC : touchAimNdc;
    const target = ndc ? raycastBlockTarget(ndc) : null;
    if (!target) { blockHighlight.hideTarget(); return; }
    const pos = new THREE.Vector3(target.x, target.y, target.z);
    const shape = shapeBoxesFor(target.id, target.x, target.y, target.z, getBlock, () => undefined);
    blockHighlight.updateTarget(pos, target.id, shape);
  }

  function selectedItemId(): number | null {
    return inventorySlots[selectedSlotIndex]?.id ?? null;
  }

  /** True while the block at `id` is even worth timing - unbreakable (Infinity) blocks like bedrock never start a dig, matching singleplayer's own canMine(). */
  function canMineClient(id: BlockId): boolean {
    return id !== BlockId.AIR && Number.isFinite(breakTime(id, selectedItemId()).time);
  }

  function cancelMining(): void {
    mining = null;
    breakOverlay.hide();
  }

  function startMining(target: { x: number; y: number; z: number; id: BlockId }): void {
    const { time } = breakTime(target.id, selectedItemId());
    client.send({ type: 'breakStart', x: target.x, y: target.y, z: target.z });
    if (time <= 0) {
      // Hardness-0 blocks (torches, fire, ...) break the instant the dig
      // starts - same short-circuit singleplayer's startMining() takes,
      // rather than showing an overlay for a duration of zero.
      client.send({ type: 'breakBlock', x: target.x, y: target.y, z: target.z });
      return;
    }
    mining = { x: target.x, y: target.y, z: target.z, id: target.id, elapsed: 0, total: time };
    miningChipTimer = 0;
  }

  /** Called every frame from frame() below - see the module's per-frame update pass. */
  function updateMining(delta: number): void {
    if (!(leftHeld || touchMiningHeld)) {
      if (mining) cancelMining();
      return;
    }
    const ndc = document.pointerLockElement === canvas ? CENTER_NDC : touchAimNdc;
    const target = ndc ? raycastBlockTarget(ndc) : null;

    if (!mining) {
      // Hold-to-continue: once a breakable block comes under the crosshair
      // while the button is still held, start on it - matches singleplayer's
      // own "start on the next block once it's targeted" behaviour.
      if (target && canMineClient(target.id)) startMining(target);
      return;
    }

    const sameBlock = !!target && target.x === mining.x && target.y === mining.y && target.z === mining.z && target.id === mining.id;
    if (!sameBlock) {
      // Looking elsewhere (or the block changed under them): retarget if
      // still holding and the new one is breakable, else give up.
      if (target && canMineClient(target.id)) startMining(target);
      else cancelMining();
      return;
    }

    mining.elapsed += delta;
    breakOverlay.setProgress(new THREE.Vector3(mining.x, mining.y, mining.z), mining.elapsed / mining.total);

    miningChipTimer += delta;
    if (miningChipTimer >= MINING_CHIP_INTERVAL) {
      miningChipTimer -= MINING_CHIP_INTERVAL;
      const light = lightEngine.getRawBrightness(mining.x, mining.y, mining.z) / 15;
      particles?.mine(new THREE.Vector3(mining.x, mining.y, mining.z), target!.normal, mining.id, light);
      const mineSound = getBlockSound(mining.id, 'mine') ?? getBlockSound(mining.id, 'hit');
      if (mineSound) soundManager.playSound(mineSound, 0.5);
      localPlayerModel?.swingArm(); // repeats every chip, same cadence interaction.ts's own swing-while-mining uses
      hand.swing(); // first-person view - same onSwing cue main.ts wires into BlockInteraction
    }

    if (mining.elapsed >= mining.total) {
      client.send({ type: 'breakBlock', x: mining.x, y: mining.y, z: mining.z });
      mining = null;
      breakOverlay.hide();
    }
  }

  function performInteraction(ndc: THREE.Vector2, action: 'place' | 'attack'): boolean {
    // Eating doesn't need anything in reach (unlike breaking/placing/
    // attacking) - checked first, before the raycast even runs, so holding
    // a food item and right-clicking always eats regardless of what's (or
    // isn't) in front of the crosshair.
    if (action === 'place') {
      const heldSlot = inventorySlots[selectedSlotIndex];
      if (heldSlot?.id !== null && heldSlot?.id !== undefined && foodValue(heldSlot.id) > 0) {
        client.send({ type: 'useItem', slotIndex: selectedSlotIndex });
        // The bite takes 1.6s to land server-side (world-do.ts's
        // handleUseItem), so without an immediate cue the click would feel
        // like it did nothing until the hearts suddenly jump. Chew locally on
        // the same cadence singleplayer does, for as long as the bite lasts.
        startChewing();
        return true;
      }
    }
    raycaster.setFromCamera(ndc, camera);
    // Entity hitboxes take priority over terrain at the same/closer distance -
    // attacking a mob standing right against a wall shouldn't accidentally
    // break the wall instead just because intersectObjects happened to order
    // it second. Both lists go through in one call so `hits` is already
    // sorted by distance; explicitly preferring an entity within REACH over
    // a same-ray terrain hit further away.
    const entityHitboxes = [...remoteEntities.values()].map((r) => r.hitbox);
    const hits = raycaster.intersectObjects([...chunkMeshes, ...entityHitboxes], false);
    // Same water-skip as raycastBlockTarget/src/raycast.ts - an entity hit
    // always counts (it isn't blocked by a water surface), but a terrain hit
    // on a water cell is passed through to whatever's actually behind/under
    // it, same reach budget either way.
    const hit = hits.find((h) => {
      if (h.distance > REACH) return false;
      if (h.object.userData.entityId !== undefined) return true;
      if (!h.face) return false;
      const b = h.point.clone().addScaledVector(h.face.normal, -0.01).round();
      return getBlock(b.x, b.y, b.z) !== BlockId.WATER;
    });
    if (!hit) return false;
    const entityId = hit.object.userData.entityId as number | undefined;
    if (action === 'attack') {
      // Mob ids are negative (ServerMobManager); player ids are positive -
      // PvP is deliberately not wired up yet (see world-do.ts's attack
      // handler), so this just doesn't send anything for a player target.
      if (entityId === undefined || entityId >= 0) return false;
      client.send({ type: 'attack', targetId: entityId });
      localPlayerModel?.swingArm(); // same third-person swing cue as a successful mine start below
      hand.swing();
      return true;
    }
    if (entityId !== undefined || !hit.face) return false;
    const normal = hit.face.normal;
    // Right-clicking an existing FURNACE block opens its GUI instead of
    // placing a new block against it - same "existing block under the
    // crosshair" coordinate raycastBlockTarget uses for mining, not the
    // neighbouring spot a new block would land in.
    const existing = hit.point.clone().addScaledVector(normal, -0.01).round();
    if (getBlock(existing.x, existing.y, existing.z) === BlockId.FURNACE) {
      setFurnaceOpen(true, { x: existing.x, y: existing.y, z: existing.z });
      return true;
    }
    // A crafting table opens the 3x3 rather than getting a block placed
    // against it, same as singleplayer's own right-click on one.
    if (getBlock(existing.x, existing.y, existing.z) === BlockId.CRAFTING_TABLE) {
      setTableOpen(true, { x: existing.x, y: existing.y, z: existing.z });
      return true;
    }
    // The server ignores this blockId and places whatever is actually in
    // the player's selected inventory slot (world-do.ts's handlePlaceBlock
    // doc comment) - sent here only because the protocol message still
    // needs some number in that field. No-op silently if the slot's empty
    // or holds a non-block item.
    const heldId = inventorySlots[selectedSlotIndex]?.id;
    if (heldId === null || heldId === undefined) return false;
    const p = hit.point.clone().addScaledVector(normal, 0.5).round();
    client.send({ type: 'placeBlock', x: p.x, y: p.y, z: p.z, blockId: heldId, face: 0 });
    hand.bump(); // same onPlace cue main.ts wires (dip-and-spring, not a swing - singleplayer doesn't swing the arm on a successful place either)
    return true;
  }

  // --- Bow: hold right-click to draw, release to fire. Same timing and power
  // curve as singleplayer's interaction.ts (LCE BowItem), kept here rather
  // than reused because that class is built around the singleplayer world/
  // inventory objects this client doesn't have. The server re-checks the
  // player actually owns an arrow and spends it (world-do.ts's handleShootBow),
  // so a client lying about `power` can only affect its own shot's arc.
  const BOW_MAX_DRAW = 1.0;   // seconds to a full draw
  const BOW_MIN_POWER = 0.1;  // below this the release is too quick to count
  let bowDrawStart: number | null = null;

  const holdingBow = () => inventorySlots[selectedSlotIndex]?.id === ItemId.BOW;
  /** The server is the one that actually spends the arrow; this check only keeps a player with an empty quiver from hearing a phantom shot, the same way singleplayer refuses to even start the draw. */
  const hasArrows = () => inventorySlots.some((s) => s.id === ItemId.ARROW && (s.count ?? 0) > 0);

  const releaseBow = () => {
    if (bowDrawStart === null) return;
    const held = (performance.now() - bowDrawStart) / 1000;
    bowDrawStart = null;
    let pow = THREE.MathUtils.clamp(held / BOW_MAX_DRAW, 0, 1);
    pow = (pow * pow + pow * 2) / 3; // LCE's own smoothing
    if (pow < BOW_MIN_POWER) return;
    const dir = camera.getWorldDirection(new THREE.Vector3());
    client.send({ type: 'shootBow', power: Math.min(pow, 1), dir: { x: dir.x, y: dir.y, z: dir.z } });
    soundManager.playOne('items/Bow_shoot', 0.9);
  };

  const CENTER_NDC = new THREE.Vector2(0, 0);
  const onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) { lockPointer(canvas); return; }
    if (e.button === 0) {
      // A left-click first tries an attack (mob under the crosshair) as a
      // one-shot action, same as singleplayer's own onMouseDown; only if
      // that misses does holding the button start (and continue) mining,
      // driven every frame by updateMining() rather than an instant break.
      if (!performInteraction(CENTER_NDC, 'attack')) leftHeld = true;
    } else if (e.button === 2) {
      if (holdingBow() && hasArrows()) bowDrawStart = performance.now();
      else if (!holdingBow()) performInteraction(CENTER_NDC, 'place');
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) { leftHeld = false; cancelMining(); }
    if (e.button === 2) releaseBow();
  };
  // Losing pointer lock any other way (Escape, alt-tab, the browser's own
  // lock-loss on a long hold) doesn't fire a mouseup - without this, a mine
  // in progress when that happens would keep "holding" forever, mining
  // straight through walking into a menu.
  const onPointerLockChange = () => {
    if (document.pointerLockElement !== canvas) { leftHeld = false; cancelMining(); }
  };
  document.addEventListener('pointerlockchange', onPointerLockChange);
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('contextmenu', onContextMenu);

  const touchControls = TouchControls.isTouchDevice()
    ? new TouchControls({
        onMoveAxis: (x, z) => { touchMoveX = x; touchMoveZ = z; },
        onJump: (held) => { touchJump = held; },
        onSneak: (on) => { touchSneak = on; },
        onSprint: (on) => { touchSprint = on; },
        onLook: (dx, dy) => {
          // Singleplayer's own touchSensitivity setting isn't actually wired
          // to anything there either (its slider persists a value nothing
          // reads) - reusing the desktop sensitivity here isn't a regression
          // against a working feature, it's the same gap singleplayer has,
          // just not silently ignoring the shared slider like that one does.
          yaw -= dx * MOUSE_SENSITIVITY_BASE * sensitivityScale;
          pitch -= dy * MOUSE_SENSITIVITY_BASE * sensitivityScale;
          pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        },
        onTapPlace: () => { if (touchAimNdc) performInteraction(touchAimNdc, 'place'); },
        // Same hold-driven mining as the desktop mouse button - TouchControls
        // already recognizes "finger held still" as the gesture (HOLD_MS),
        // this just flags it for updateMining() to act on every frame.
        onBreakStart: () => { touchMiningHeld = true; },
        onBreakEnd: () => { touchMiningHeld = false; cancelMining(); },
        onAttackTry: () => (touchAimNdc ? performInteraction(touchAimNdc, 'attack') : false),
        onAimMove: (clientX, clientY) => {
          const rect = canvas.getBoundingClientRect();
          const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
          const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
          touchAimNdc = touchAimNdc ? touchAimNdc.set(ndcX, ndcY) : new THREE.Vector2(ndcX, ndcY);
        },
        onAimEnd: () => { touchAimNdc = null; },
        // Same E-key logic as onKeyDown below: don't open the backpack over
        // the furnace GUI, and close the table first if it's up.
        onInventory: () => {
          if (furnaceOpenState) return;
          if (tableOpen) setTableOpen(false);
          setBackpackOpen(!backpackOpen);
        },
        onThirdPerson: () => cycleCameraMode(),
        // Toggle: tap again while open to send-or-cancel back to the world
        // instead of leaving the keyboard up with no obvious way down.
        onChat: () => { if (chatOpen) closeChat(true); else openChat(); },
        // Opens the options panel (with its own Leave World button inside)
        // rather than disconnecting outright - matches singleplayer's own
        // touch pause button (pauseMenu.toggle()), which was never a
        // one-tap quit either.
        onPause: () => { if (!(tableOpen || backpackOpen || furnaceOpenState)) toggleOptionsPanel(); },
      }, document.body) // not #game-shell (default) - that's hidden entirely above, which would hide these controls too
    : null;

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    hand.resize(camera.aspect);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  /** Every player's currently-known skin ("data: URL, or null for default), keyed by their entity id - populated from the server's playerSkin messages (see client.connect below), which can arrive before OR after that player's first state snapshot creates their avatar. */
  const playerSkins = new Map<number, string | null>();

  /**
   * Real avatar for another player: the exact same PlayerModel (skinned,
   * animated head/torso/arms/legs) singleplayer renders for its own player,
   * so other players see this one's actual skin instead of a placeholder -
   * built with its OWN skin materials (createSkinMaterials) rather than the
   * shared singleton the local player's model uses, so several different
   * skins can render at once without stomping each other. Mobs get their own
   * real models the same way - see makeMobAvatar below.
   */
  // Invisible box, parented to a player model so it inherits the group's own
  // matrixWorld updates - the actual raycast target (onMouseDown/
  // performInteraction need a single Mesh, not a multi-part model group).
  // Centered between the top of the head (~0.18 above eye level) and the
  // feet (-1.62 below), matching PlayerModel's own eye-origin convention.
  function buildPlayerHitbox(id: number): THREE.Mesh {
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.8, 0.6),
      // Invisible by default (this box only exists as a raycast target) -
      // wireframe+color are set up front so toggling `.visible` on for the R
      // debug key (see hitboxDebug below) is the only thing that has to
      // happen later, not a second material swap.
      new THREE.MeshBasicMaterial({ visible: hitboxDebug, wireframe: true, color: 0xff2222 }),
    );
    hitbox.position.y = -0.72;
    hitbox.userData.entityId = id;
    return hitbox;
  }

  function makePlayerAvatar(id: number, name: string, skinImage: HTMLImageElement | null): RemoteEntity {
    const materials = createSkinMaterials(skinImage);
    const model = new PlayerModel(materials);
    scene.add(model.group);
    const hitbox = buildPlayerHitbox(id);
    model.group.add(hitbox);
    const label = document.createElement('div');
    label.textContent = name;
    label.className = 'mp-name-tag';
    labelLayer.appendChild(label);
    return {
      // Lower than before (was 1.1, above the model's actual head) and with
      // a translucent background (see .mp-name-tag in style.css) so it reads
      // over any background instead of relying only on a 1px text-shadow.
      mesh: model.group, hitbox, label, labelOffsetY: 0.55, playerModel: model, skinMaterials: materials,
      lastHealth: Infinity, lastYaw: 0, lastPitch: 0, sneaking: false, heldItem: null, moveDeltaX: 0, moveDeltaZ: 0, kind: 'player',
    };
  }

  /** A player's skin arrived (or finished decoding) after their avatar already exists - rebuilds the model in place with the new skin materials, since PlayerModel bakes its materials in at construction with no way to swap them after the fact. */
  function rebuildPlayerAvatarSkin(id: number, image: HTMLImageElement | null): void {
    const entity = remoteEntities.get(id);
    if (!entity || !entity.playerModel) return;
    const oldGroup = entity.mesh;
    const materials = createSkinMaterials(image);
    const model = new PlayerModel(materials);
    model.group.position.copy(oldGroup.position);
    model.group.rotation.copy(oldGroup.rotation);
    const hitbox = buildPlayerHitbox(id);
    model.group.add(hitbox);
    scene.add(model.group);
    scene.remove(oldGroup);
    disposeGroupGeometries(oldGroup);
    if (entity.skinMaterials) disposeSkinMaterials(entity.skinMaterials);
    entity.mesh = model.group;
    entity.playerModel = model;
    entity.hitbox = hitbox;
    entity.skinMaterials = materials;
  }

  function applySkinWhenReady(id: number, skinDataUrl: string | null): void {
    void loadSkinImage(skinDataUrl).then((img) => rebuildPlayerAvatarSkin(id, img));
  }

  /**
   * Avatar for a MOB: the exact MobModel/BipedMobModel singleplayer renders,
   * fed from the server's snapshots instead of from a local MobManager. A
   * mob's `pos` is FEET height (mob-manager.ts convention), which is also the
   * model group's own origin, so the position goes straight on - the opposite
   * of a player's eye-height origin.
   */
  function makeMobAvatar(id: number, kind: MobKind, name: string): RemoteEntity {
    const stats = MOB_STATS[kind];
    const spec = MOB_SPECS[kind];
    const hitboxSize = { radius: stats.radius, height: stats.height };
    const mobModel: AnyMobModel = isBipedKind(kind)
      ? new BipedMobModel(spec as BipedSpec, hitboxSize)
      : new MobModel(spec as QuadrupedSpec, hitboxSize);
    const mesh = mobModel.getGroup();

    // Invisible single-Mesh raycast target, same trick buildPlayerHitbox uses:
    // onMouseDown needs one object to hit, not a multi-part model group.
    const hitbox = new THREE.Mesh(
      new THREE.BoxGeometry(stats.radius * 2, stats.height, stats.radius * 2),
      new THREE.MeshBasicMaterial({ visible: hitboxDebug, wireframe: true, color: 0xff2222 }),
    );
    hitbox.position.y = stats.height / 2; // feet-origin group -> box centred on the body
    hitbox.userData.entityId = id; // read by onMouseDown to tell an attack target apart from terrain
    mesh.add(hitbox);

    scene.add(mesh);
    const label = document.createElement('div');
    label.textContent = name;
    label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
    labelLayer.appendChild(label);
    return {
      mesh, hitbox, label, labelOffsetY: stats.height + 0.3, mobModel,
      lastHealth: Infinity, lastYaw: 0, lastPitch: 0, sneaking: false, heldItem: null, moveDeltaX: 0, moveDeltaZ: 0, kind,
      idleSoundTimer: nextIdleDelay(),
    };
  }

  /** Every Mesh's geometry under `root` - a player model is ~10 boxes (body parts + their overlay shells + the hitbox), each its own BufferGeometry created fresh per PlayerModel instance (never shared, unlike singleplayer's one-off local model), so leaving these behind on every join/leave/skin-rebuild would leak real GPU memory over a long session. Materials are handled separately (disposeSkinMaterials for a player, disposeMobMaterials for a mob) since which material(s) a mesh owns vs. shares varies by avatar kind. */
  function disposeGroupGeometries(root: THREE.Object3D): void {
    root.traverse((obj) => { if (obj instanceof THREE.Mesh) obj.geometry.dispose(); });
  }

  function removeEntityAvatar(entity: RemoteEntity): void {
    scene.remove(entity.mesh);
    entity.label.remove();
    disposeGroupGeometries(entity.mesh);
    if (entity.skinMaterials) disposeSkinMaterials(entity.skinMaterials);
    else disposeMobMaterials(entity.mesh);
  }

  /**
   * Every distinct material under a mob model. MobModel builds a handful
   * per instance (body, wool/overlay shell, separately-textured extras like
   * cow horns, the fire overlay) and shares each across several meshes, so
   * this de-dupes before disposing rather than disposing the same one many
   * times. Their `map` is deliberately left alone: mob textures come from
   * mob-model.ts's module-level cache and are shared by every mob of that
   * kind, so disposing one here would blank out every other cow on screen.
   */
  function disposeMobMaterials(root: THREE.Object3D): void {
    const seen = new Set<THREE.Material>();
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) seen.add(mat);
    });
    for (const mat of seen) mat.dispose();
  }

  /** Advances one remote entity's animation - see moveDeltaX/Z's doc comment for why this reads a value computed once per tick rather than the entity's raw position each frame. Call every render frame, not just on a `state` message, so the swing stays smooth between the server's 20Hz updates. */
  function updateRemoteAnimation(entity: RemoteEntity, delta: number): void {
    const moving = entity.moveDeltaX * entity.moveDeltaX + entity.moveDeltaZ * entity.moveDeltaZ > 0.0001;

    if (entity.dyingFor !== undefined) {
      // Topple over the Z axis across the same window the server holds a dying
      // mob in the snapshot for - singleplayer's mob-manager.ts does this with
      // its own deathTimer, which isn't on the wire, so the client runs the
      // clock itself from the first `dying` snapshot it saw.
      entity.dyingFor += delta;
      const t = Math.min(1, entity.dyingFor / DEATH_SPIN_DURATION);
      entity.mesh.rotation.z = (Math.PI / 2) * t;
      entity.mobModel?.setWalking(false);
      entity.mobModel?.update(delta); // keeps the death tint resolving; setDying() was set when `dying` first arrived
      return; // a corpse doesn't walk
    }

    if (entity.mobModel) {
      entity.mobModel.setWalking(moving);
      const p = entity.mesh.position;
      entity.mobModel.setLightLevel(lightEngine.getRawBrightness(Math.round(p.x), Math.round(p.y), Math.round(p.z)) / 15);
      entity.mobModel.update(delta);
      updateMobIdleSound(entity, delta);
      return;
    }

    if (!entity.playerModel) return;
    if (moving) entity.playerModel.startWalking(); else entity.playerModel.stopWalking();
    entity.playerModel.setOrientation(entity.lastYaw, entity.lastPitch, entity.moveDeltaX, entity.moveDeltaZ, delta);
    // Same order as main.ts:733-734/localPlayerModel above - before
    // updateWalkingAnimation so the crouch offset composes with the walk
    // cycle for other players too, not just this client's own body.
    entity.playerModel.setSneaking(entity.sneaking);
    entity.playerModel.updateSneak(delta);
    entity.playerModel.setAdjustments(ZERO_MODEL_ADJUSTMENTS); // same as localPlayerModel above - legs don't move without this
    entity.playerModel.setHeldItem(entity.heldItem);
    entity.playerModel.updateWalkingAnimation(delta);
  }

  /** Ambient bark on the same random 4-9s cadence singleplayer uses, and only within earshot - the server has no SoundManager, so idle cues never come over the wire. */
  function updateMobIdleSound(entity: RemoteEntity, delta: number): void {
    if (entity.idleSoundTimer === undefined) return;
    entity.idleSoundTimer -= delta;
    if (entity.idleSoundTimer > 0) return;
    entity.idleSoundTimer = nextIdleDelay();
    if (entity.mesh.position.distanceTo(camera.position) <= MOB_SOUND_RADIUS) {
      playMobSound(soundManager, entity.kind as MobKind, 'idle', 0.5);
    }
  }

  const messageEl = document.querySelector<HTMLElement>('#multiplayer-connect-message')!;
  function disconnect(reason: string): void {
    if (!running) return;
    running = false;
    setSingleplayerChatEnabled(true);
    setSingleplayerPauseMenuEnabled(true);
    leftHeld = false;
    touchMiningHeld = false;
    cancelMining();
    client.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('pointerlockchange', onPointerLockChange);
    window.removeEventListener('resize', onResize);
    touchControls?.destroy();
    document.removeEventListener('pointerdown', onFirstGesture);
    ambient.stopAll();
    worldMusic.stop();
    soundManager.stopAll();
    document.body.classList.remove('mp-touch');
    document.exitPointerLock();
    canvas.hidden = true;
    crosshair.hidden = true;
    hint.hidden = true;
    gameShell.style.display = previousGameShellDisplay;
    labelLayer.remove();
    hotbarEl.remove();
    hudEl.remove();
    deathEl.remove();
    fireOverlayEl.remove();
    underwaterOverlayEl.remove();
    backpackDoll.setActive(false);
    backpackEl.remove();
    tableEl.remove();
    ghostEl.remove();
    furnaceEl.remove();
    chatEl.remove();
    diagnosticsEl.remove();
    optionsEl.remove();
    if (localPlayerModel) {
      scene.remove(localPlayerModel.group);
      disposeGroupGeometries(localPlayerModel.group);
      if (localSkinMaterials) disposeSkinMaterials(localSkinMaterials);
    }
    for (const [, p] of remoteEntities) removeEntityAvatar(p);
    for (const entityId of [...groundItems.keys()]) removeGroundItem(entityId);
    for (const mesh of arrowMeshes.values()) scene.remove(mesh); // shared geometry/material, nothing to dispose per arrow
    arrowMeshes.clear();
    // Chunk geometries are real GPU resources (BufferGeometry) - renderer.dispose()
    // below doesn't free those on its own, so a reconnect in the same page
    // session would otherwise leak VRAM for every streamed-in chunk.
    for (const chunk of chunks.values()) chunk.dispose();
    // SkyRenderer builds a handful of its own GPU resources (star field
    // geometry, cloud/glow canvas textures, sun/moon planes) that - like the
    // chunk geometries above - renderer.dispose() below doesn't reach; a
    // reconnect in the same page session would otherwise leak a small but
    // real amount of VRAM per attempt instead of just per chunk.
    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.Sprite) {
        obj.geometry?.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) { mat.map?.dispose(); mat.alphaMap?.dispose(); mat.dispose(); }
      }
    });
    renderer.dispose();
    unlockPointerForGui();
    connectScreen.hidden = false;
    messageEl.textContent = reason;
    messageEl.classList.toggle('mp-error', reason !== 'Disconnected');
  }

  const client = new MpClient();
  client.connect(serverUrl, worldId, loadPlayToken(), {
    onWelcome: (msg) => {
      lastServerPos.set(msg.spawn.x, msg.spawn.y, msg.spawn.z);
      camera.position.copy(lastServerPos);
      joinedAtMs = performance.now();
      catchingUp = true;
      clientDayTime = msg.dayTime;
      applyDayNightState(clientDayTime);
      terrainReady = initTerrain(msg.worldSeed);
    },
    onRejected: (reason) => disconnect(`Rejected: ${reason}`),
    onState: (msg) => {
      if (catchingUp) {
        // The backlog is confirmed over (see catchingUp's doc comment) - one
        // full relight of whatever chunks already exist, using the NOW-
        // complete edit data those chunks' raw writes accumulated during the
        // freeze-free catch-up above, then a throttled remesh via the
        // existing relightQueue drain instead of one big-frame hitch.
        catchingUp = false;
        lightEngine.rebuildLoadedChunks();
        relightQueue.length = 0;
        for (const key of chunks.keys()) relightQueue.push(key);
      }
      // Same trick updateRemoteAnimation uses for every OTHER player, applied
      // to this one's own third-person body: a plain world-space delta since
      // the last server tick, computed before lastServerPos is overwritten
      // below - not a raw velocity, so it already accounts for anything that
      // changed the position besides walking (a knockback, a respawn).
      localMoveDeltaX = msg.self.pos.x - lastServerPos.x;
      localMoveDeltaZ = msg.self.pos.z - lastServerPos.z;
      lastServerPos.set(msg.self.pos.x, msg.self.pos.y, msg.self.pos.z);
      // Only real cadence we get position/velocity samples at is per server
      // tick (no local prediction yet - see the module doc comment), so
      // ViewBob is fed here instead of every animation frame.
      const nowMs = performance.now();
      const stateDt = lastStateTimeMs ? (nowMs - lastStateTimeMs) / 1000 : 0;
      lastStateTimeMs = nowMs;
      viewBob.update(stateDt, {
        horizontalDistance: Math.hypot(localMoveDeltaX, localMoveDeltaZ),
        horizontalSpeed: Math.hypot(msg.self.velocity.x, msg.self.velocity.z),
        verticalVelocity: msg.self.velocity.y,
        grounded: msg.self.grounded,
        sneaking: keys.has('ShiftLeft') || touchSneak,
        yaw, pitch,
      });
      hud.setHealth(msg.self.health);
      if (msg.self.health < lastSelfHealth) {
        soundManager.playRandom('player/Player_hurt', 3, 0.7);
        localPlayerModel?.hurt(); // same cue remote players already get, see makePlayerAvatar/onState's entity loop below
      }
      lastSelfHealth = msg.self.health;
      // `full` (bar hidden) once air reads 10 - "on dry land", same threshold
      // the emoji version used and the same one singleplayer's own Hud caller
      // (main.ts) applies for hiding the row entirely.
      hud.setAir(msg.self.air, msg.self.air >= 10);
      fireOverlayEl.classList.toggle('active', msg.self.onFire);
      const seen = new Set<number>();
      for (const e of msg.entities as EntitySnapshot[]) {
        seen.add(e.id);
        let op = remoteEntities.get(e.id);
        if (!op) {
          if (e.kind === 'player') {
            op = makePlayerAvatar(e.id, e.name ?? e.kind, null); // default look immediately, upgraded to the real skin below/onPlayerSkin as soon as it's known
            const knownSkin = playerSkins.get(e.id);
            if (knownSkin !== undefined) applySkinWhenReady(e.id, knownSkin);
          } else {
            op = makeMobAvatar(e.id, e.kind as MobKind, e.name ?? e.kind);
          }
          op.lastHealth = e.health;
          remoteEntities.set(e.id, op);
        } else {
          op.moveDeltaX = e.pos.x - op.mesh.position.x;
          op.moveDeltaZ = e.pos.z - op.mesh.position.z;
        }
        op.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
        if (!op.playerModel) op.mesh.rotation.y = e.yaw; // players: left to updateRemoteAnimation's eased setOrientation() every frame instead
        op.lastYaw = e.yaw;
        if (op.playerModel) {
          op.lastPitch = e.pitch ?? 0;
          op.sneaking = e.sneaking ?? false;
          op.heldItem = e.heldItem ?? null;
        }
        if (e.dying && op.dyingFor === undefined) {
          op.dyingFor = 0;
          op.mobModel?.setDying(true); // holds the red tint on for the whole topple instead of letting the hurt flash expire mid-fall
          // Same distance gate the idle bark above already uses (mob-manager.ts's
          // own inSoundRange) - without it, every connected client hears every
          // mob death/hurt in the world at full volume regardless of where
          // their own camera is, since everyone gets the same snapshot.
          if (op.mesh.position.distanceTo(camera.position) <= MOB_SOUND_RADIUS) playMobSound(soundManager, op.kind as MobKind, 'death', 0.8);
          smokeParticles.burst(new THREE.Vector3(e.pos.x, e.pos.y + 0.6, e.pos.z));
        }
        // Both model kinds carry the orange tint + flame overlay, and the
        // server now reports a burning PLAYER too (not just mobs), so this
        // has to reach either one.
        op.mobModel?.setOnFire(e.onFire);
        op.playerModel?.setOnFire(e.onFire);
        if (e.health < op.lastHealth) {
          op.playerModel?.hurt();
          op.mobModel?.hurt();
          if (!op.playerModel && op.mesh.position.distanceTo(camera.position) <= MOB_SOUND_RADIUS) {
            playMobSound(soundManager, op.kind as MobKind, 'hurt', 0.7);
          }
        }
        op.lastHealth = e.health;
      }
      for (const [id, op] of remoteEntities) {
        if (seen.has(id)) continue;
        // Dropping out of `entities` means gone for good. The death CUE isn't
        // here any more: the server now announces a kill up front by flagging
        // the mob `dying` and keeping it in the snapshot while it topples, so
        // the sound fires at the moment of the kill (above) instead of a beat
        // later when the body is finally removed.
        removeEntityAvatar(op);
        remoteEntities.delete(id);
      }

      syncArrows(msg.arrows);

      // --- ground items: same add/update/remove-by-absence pass as entities above ---
      const seenItems = new Set<number>();
      for (const snap of msg.droppedItems) {
        seenItems.add(snap.entityId);
        const existing = groundItems.get(snap.entityId);
        if (!existing) { addGroundItem(snap); continue; }
        existing.anchor.position.set(snap.pos.x, snap.pos.y, snap.pos.z);
      }
      for (const [entityId, item] of [...groundItems]) {
        if (seenItems.has(entityId)) continue;
        // Dropping out of the list means picked up or despawned. There's no
        // protocol event saying which (adding one just to drive a sound isn't
        // worth a message type), but the distinction that matters here is
        // only "was it MY pickup" - and that's answerable locally: an item
        // that vanished within arm's reach of this player was vacuumed up by
        // them, one that vanished across the map was someone else's or a
        // despawn. PICKUP_RANGE is 1.5 server-side; 2 leaves a little slack
        // for the lag between the snapshot that moved us and this one.
        if (item.anchor.position.distanceTo(camera.position) < 2) soundManager.playOne('player/Pop', 0.4);
        removeGroundItem(entityId);
      }
    },
    onBlockChanged: (msg) => applyBlockChange(msg.x, msg.y, msg.z, msg.blockId, msg.waterDistance, msg.silent),
    onEntityRemoved: (id) => {
      const op = remoteEntities.get(id);
      if (op) { removeEntityAvatar(op); remoteEntities.delete(id); }
    },
    onPlayerSkin: (playerId, skin) => {
      playerSkins.set(playerId, skin);
      if (remoteEntities.has(playerId)) applySkinWhenReady(playerId, skin);
    },
    onDied: (killedBy) => {
      isDead = true;
      keys.clear();       // whatever was held down shouldn't still be pressed on respawn
      bowDrawStart = null; // dying mid-draw must not fire the moment they come back
      deathCause.textContent = killedBy ? `Slain by ${killedBy}` : '';
      deathEl.hidden = false;
      document.exitPointerLock();
    },
    onDayTime: (elapsed) => { clientDayTime = elapsed; },
    onInventoryUpdate: (slots, selectedIndex) => {
      inventorySlots = slots;
      selectedSlotIndex = selectedIndex;
      announceHeldIfChanged();
      // Wait for the block/item atlas (see terrainReady's doc comment) so a
      // slot never renders before it can show its real texture.
      void (terrainReady ?? Promise.resolve()).then(() => {
        renderHotbar();
        if (backpackOpen) renderBackpack();
        if (tableOpen) renderTable();
      });
    },
    // The server still offers the older "craft straight from a recipe index"
    // shortcut, but this client drives the real grid instead, so there's
    // nothing to do with the affordable-recipe list any more.
    onCraftableRecipes: () => {},
    onCraftGridState: (side, inputs, output) => {
      craftSide = side;
      craftInputs = inputs;
      craftOutput = output;
      void (terrainReady ?? Promise.resolve()).then(() => {
        if (backpackOpen) renderBackpack();
        if (tableOpen) renderTable();
      });
    },
    onCraftGridClosed: () => {
      craftInputs = [];
      craftOutput = createEmptySlot();
    },
    onInvHeld: (item) => {
      heldItem = item;
      renderGhost();
    },
    // Same sound as singleplayer's Inventory.damageSelected() playing it
    // directly (main.ts:270,401) - the slot itself already went empty via
    // the inventoryUpdate sent alongside this.
    onToolBroke: () => soundManager.playOne('player/break', 0.8),
    onFurnaceState: (x, y, z, state) => {
      if (furnacePos && furnacePos.x === x && furnacePos.y === y && furnacePos.z === z) renderFurnace(state);
    },
    onChat: (from, text) => addChatLine(`<${from}> ${text}`),
    onPong: (clientTimeMs) => { pingMs = performance.now() - clientTimeMs; },
    onClose: (reason) => disconnect(reason),
  }, loadPlayerSkinDataUrl());

  let lastSend = 0;
  function sendInput(now: number): void {
    if (now - lastSend < SEND_INTERVAL_MS) return;
    lastSend = now;
    if (isDead) return; // the server ignores a dead player's input anyway; not sending it keeps the corpse from "walking" the moment they respawn
    // Typing swallows every keydown for the game (see chatInputEl's own
    // listener), but not a keyUP for a movement key that was ALREADY held
    // when chat opened - that key would otherwise stay stuck in `keys` and
    // keep moving the player for as long as they're chatting.
    if (chatOpen || optionsOpen) return;
    let moveX = touchMoveX, moveZ = touchMoveZ;
    if (keys.has('KeyW')) moveZ -= 1;
    if (keys.has('KeyS')) moveZ += 1;
    if (keys.has('KeyA')) moveX -= 1;
    if (keys.has('KeyD')) moveX += 1;
    moveX = THREE.MathUtils.clamp(moveX, -1, 1);
    moveZ = THREE.MathUtils.clamp(moveZ, -1, 1);
    // Same auto-clear as player.ts's own update(): stopping cancels sprint,
    // same as touchSprint's on-screen toggle button being its own separate
    // (still held-style) signal.
    if (moveX === 0 && moveZ === 0) sprintToggled = false;
    client.send({
      type: 'input',
      seq: ++seq,
      moveX, moveZ,
      wantJump: keys.has('Space') || touchJump,
      sprinting: sprintToggled || touchSprint,
      sneaking: keys.has('ShiftLeft') || touchSneak,
      yaw, pitch,
      dtMs: SEND_INTERVAL_MS,
    });
  }

  function updateLabels(): void {
    const v = new THREE.Vector3();
    for (const [, p] of remoteEntities) {
      p.mesh.getWorldPosition(v);
      v.y += p.labelOffsetY;
      v.project(camera);
      if (v.z > 1) { p.label.style.display = 'none'; continue; }
      p.label.style.display = 'block';
      p.label.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
      p.label.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    }
  }

  const VIEW_BOB_DEG = Math.PI / 180;
  /** Same transform as player.ts's applyViewBob() - camera must already be at the eye position/rotation for translateX/Y and rotateZ/X to compose correctly. */
  function applyViewBob(): void {
    const b = viewBob.phase;
    const sinb = Math.sin(b * Math.PI);
    const cosb = Math.cos(b * Math.PI);
    const { bob, tilt } = viewBob;
    camera.translateX(sinb * bob * 0.5);
    camera.translateY(-Math.abs(cosb * bob));
    camera.rotateZ(sinb * bob * 3 * VIEW_BOB_DEG);
    camera.rotateX(Math.abs(Math.cos(b * Math.PI - 0.2) * bob) * 5 * VIEW_BOB_DEG + tilt * VIEW_BOB_DEG);
  }

  let lastFrameTime = 0;
  function frame(now: number): void {
    if (!running) return;
    requestAnimationFrame(frame);
    // Same 0.1s spiral-of-death clamp main.ts's own animate() uses - a
    // backgrounded/minimized tab's first frame back can report a
    // multi-second gap, which would otherwise fling a remote player's
    // walk-cycle/orientation easing wildly off in one step.
    const delta = lastFrameTime === 0 ? 0 : Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    // Position is always the server's last confirmed value (no local
    // prediction yet - see the module doc comment); look direction is local
    // for a responsive camera despite network latency on movement itself.
    // First person: the camera IS the eye. Third person: pull the boom back
    // (thirdPersonCameraPosition, shared with singleplayer's own) and look at
    // the eye instead of sitting on it, same as player.ts's updateCamera().
    if (cameraMode === 0) {
      camera.position.copy(lastServerPos);
      camera.rotation.set(pitch, yaw, 0, 'YXZ');
      applyViewBob();
    } else {
      camera.position.copy(thirdPersonCameraPosition(lastServerPos, yaw, pitch, cameraMode === 2, isSolidAtLocal));
      camera.lookAt(lastServerPos);
    }
    if (localPlayerModel) {
      localPlayerModel.group.position.copy(lastServerPos);
      const moving = localMoveDeltaX * localMoveDeltaX + localMoveDeltaZ * localMoveDeltaZ > 0.0001;
      if (moving) localPlayerModel.startWalking(); else localPlayerModel.stopWalking();
      localPlayerModel.setOrientation(yaw, pitch, localMoveDeltaX, localMoveDeltaZ, delta);
      // Same order as main.ts:733-734 - before updateWalkingAnimation so the
      // crouch offset composes with the walk cycle instead of being
      // overwritten by it.
      localPlayerModel.setSneaking(keys.has('ShiftLeft') || touchSneak);
      localPlayerModel.updateSneak(delta);
      localPlayerModel.setAdjustments(ZERO_MODEL_ADJUSTMENTS); // legs (and the rest of the crouch shift) never move without this - see its doc comment
      localPlayerModel.setHeldItem(selectedItemId());
      localPlayerModel.updateWalkingAnimation(delta);
    }
    hand.setSlotById(selectedItemId());
    // Same visibility gate as main.ts's cameraDistance<=0.5 check - first
    // person only, and hidden behind any full-screen panel that already
    // takes the pointer.
    hand.setVisible(cameraMode === 0 && !backpackOpen && !tableOpen && !furnaceOpenState && !optionsOpen && !chatOpen && !isDead);
    hand.setLightLevel(lightEngine.getRawBrightness(Math.round(lastServerPos.x), Math.round(lastServerPos.y), Math.round(lastServerPos.z)) / 15);
    hand.update(delta, {
      phase: viewBob.phase,
      bob: viewBob.bob,
      tilt: viewBob.tilt,
      yaw, pitch,
      yawLag: viewBob.yawBob,
      pitchLag: viewBob.pitchBob,
    });
    sendInput(now);
    updateMining(delta);
    updateBlockHighlight();
    updateStreaming();
    updateLabels();
    for (const entity of remoteEntities.values()) updateRemoteAnimation(entity, delta);
    animateGroundItems(delta);
    particles?.update(delta, camera);
    smokeParticles.update(delta);
    updateChewing(delta);
    ambient.update(camera.position, delta);
    if (delta > 0) fps = 1 / delta;
    renderDiagnostics();
    updatePing(now);
    clientDayTime += delta;
    applyDayNightState(clientDayTime, delta);
    // After the day/night pass, so surfacing restores the sky for the CURRENT
    // time of day rather than a fixed daytime blue - and so `submerged` is
    // fresh for the next frame's applyDayNightState guard.
    submerged = underwater.update(currentSkyColor).isUnderwater;
    // Same -10 FOV dip singleplayer's PauseMenu.setUnderwater()/updateFov()
    // apply while submerged (pause-menu.ts:206-215) - UnderwaterManager
    // itself only handles the sky/fog/overlay tint, not FOV, in either client.
    const targetFov = baseFov - (submerged ? 10 : 0);
    if (camera.fov !== targetFov) { camera.fov = targetFov; camera.updateProjectionMatrix(); }
    for (let i = 0; i < RELIGHT_CHUNKS_PER_FRAME && relightQueue.length > 0; i++) {
      // rebuildDirty() alone only re-rebuilds subchunks already flagged dirty
      // by an actual block edit (chunk.ts:292-306) - a day/night skyDarken
      // step never marks anything dirty on its own, so without markAllDirty()
      // first this was a silent no-op for every chunk nobody had touched:
      // the sky/fog colour updated, but the terrain mesh's baked vertex
      // brightness never did, until SOMETHING else (an edit in that chunk)
      // incidentally forced a real rebuild. Same two-call pattern
      // rebuildAdjacentChunks() already uses just above.
      const chunk = chunks.get(relightQueue.shift()!);
      chunk?.markAllDirty();
      chunk?.rebuildDirty();
    }
    if (materials) materials.updateWaterAnimation(now / 1000);
    renderer.render(scene, camera);
    // Own depth range on top of the main scene, so the held item never clips
    // into terrain regardless of how close a wall is - same as main.ts's own
    // renderer.autoClear=false + clearDepth() + hand.render() + autoClear=true
    // sequence. Missing the autoClear toggle here meant hand.render()'s own
    // renderer.render() call auto-cleared the COLOR buffer too (WebGLRenderer's
    // default), wiping the just-drawn world to black behind the hand every
    // frame - invisible only while a panel hid the hand (setVisible(false)
    // skips rendering it entirely), which is why opening the inventory/pause
    // screen "fixed" it.
    renderer.autoClear = false;
    renderer.clearDepth();
    hand.render(renderer);
    renderer.autoClear = true;
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) lockPointer(canvas); });
}

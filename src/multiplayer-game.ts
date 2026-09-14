import * as THREE from 'three';
import { MpClient } from './net/mp-client';
import { BlockId, blockLightProperties, createBlockMaterials, type BlockMaterials } from './block';
import { Chunk, CHUNK_SIZE, CHUNK_HEIGHT } from './chunk';
import { TerrainNoise } from './terrain-noise';
import { lockPointer, unlockPointerForGui } from './is-touch';
import { TouchControls } from './touch-controls';
import { PlayerModel, createSkinMaterials, disposeSkinMaterials, type PlayerSkinMaterials } from './player-model';
import { loadPlayerSkinDataUrl } from './player-skin';
import { loadPlayToken } from './access-gate';
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
import { COOK_SECONDS } from './smelting';
import { foodValue, isBlock, ItemId } from './item';
import { makeStack } from './item-stack';
import { buildBlockMesh, buildItemMesh, disposeBlockMesh, tintByLight } from './block-preview';
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
const MOUSE_SENSITIVITY = 0.0022;
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
  const canvas = document.querySelector<HTMLCanvasElement>('#mp-canvas')!;
  const crosshair = document.querySelector<HTMLElement>('#mp-crosshair')!;
  const hint = document.querySelector<HTMLElement>('#mp-hint')!;
  const healthEl = document.querySelector<HTMLElement>('#mp-health')!;
  const airEl = document.querySelector<HTMLElement>('#mp-air')!;
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
  healthEl.hidden = false;
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

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
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

  function chunkCoordOf(x: number, z: number): [number, number] {
    return [Math.floor((x + 8) / CHUNK_SIZE), Math.floor((z + 8) / CHUNK_SIZE)];
  }
  function getBlock(x: number, y: number, z: number): BlockId {
    const [cx, cz] = chunkCoordOf(x, z);
    const chunk = chunks.get(`${cx},${cz}`);
    return chunk ? chunk.getBlock(x, y, z) : BlockId.AIR;
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
    lightEngine.initializeChunk(chunk);
    chunk.rebuildDirty();
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

  function applyBlockChange(x: number, y: number, z: number, id: BlockId): void {
    // Reactive, not optimistic: world-do.ts's setBlock() broadcasts to
    // EVERY session including whoever sent the edit, so playing a sound here
    // (once, for every edit - ours and everyone else's alike) instead of
    // also at the moment performInteraction() sends breakBlock/placeBlock
    // avoids doubling up our own break/place sound.
    if (performance.now() - joinedAtMs > 500) {
      const previousId = getBlock(x, y, z);
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
    if (chunk && chunk.setBlock(x, y, z, id)) chunk.rebuildDirty(Infinity, y);
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
    btn.disabled = true; // display-only - clicking a hotbar slot to move items only works from inside the backpack panel (below), same as singleplayer's hotbar row mirrored into #backpack
    hotbarEl.appendChild(btn);
    hotbarSlotEls.push(btn);
  }
  document.body.appendChild(hotbarEl);
  let inventorySlots: InventorySlot[] = Array.from({ length: TOTAL_SLOTS }, createEmptySlot);
  let selectedSlotIndex = 0;
  function renderHotbar(): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      renderSlot(hotbarSlotEls[i], inventorySlots[i] ?? createEmptySlot());
      hotbarSlotEls[i].classList.toggle('selected', i === selectedSlotIndex);
    }
  }
  renderHotbar();

  /**
   * Backpack (E): the other 27 slots, plus the hotbar row mirrored at the
   * top (same layout convention as singleplayer's #backpack). Click-based
   * move instead of real drag-and-drop: click a slot to pick it up
   * (highlighted), click another to send moveSlot (merge if same item,
   * otherwise swap - see world-do.ts's moveOrMergeSlot), click the same
   * slot again to cancel. A real drag/held-cursor UI is a nice-to-have
   * follow-up; this is the same end result with fewer moving parts to get
   * right over a network round-trip.
   */
  const backpackEl = document.createElement('div');
  backpackEl.id = 'mp-backpack';
  backpackEl.hidden = true;
  const backpackGrid = document.createElement('div');
  backpackGrid.id = 'mp-backpack-grid';
  backpackEl.appendChild(backpackGrid);
  document.body.appendChild(backpackEl);
  const backpackSlotEls: HTMLButtonElement[] = [];
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const btn = document.createElement('button');
    btn.className = 'inventory-slot';
    if (i === HOTBAR_SIZE) btn.classList.add('backpack-row-start'); // CSS line-break between the mirrored hotbar row and the backpack proper
    btn.addEventListener('click', () => onBackpackSlotClick(i));
    backpackGrid.appendChild(btn);
    backpackSlotEls.push(btn);
  }
  let backpackOpen = false;
  let pickedSlot: number | null = null;
  function renderBackpack(): void {
    for (let i = 0; i < TOTAL_SLOTS; i++) {
      renderSlot(backpackSlotEls[i], inventorySlots[i] ?? createEmptySlot());
      backpackSlotEls[i].classList.toggle('picked', i === pickedSlot);
    }
  }
  function onBackpackSlotClick(index: number): void {
    if (pickedSlot === null) {
      if (inventorySlots[index]?.id === null) return; // nothing to pick up
      pickedSlot = index;
    } else if (pickedSlot === index) {
      pickedSlot = null; // clicked the same slot again - cancel
    } else {
      client.send({ type: 'moveSlot', from: pickedSlot, to: index });
      pickedSlot = null;
    }
    renderBackpack();
  }
  function setBackpackOpen(open: boolean): void {
    backpackOpen = open;
    backpackEl.hidden = !open;
    pickedSlot = null;
    if (open) { renderBackpack(); unlockPointerForGui(); } else { lockPointer(canvas); }
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

  /**
   * The real crafting grid, replacing the old "pick from a list of what you
   * can afford" shortcut. C opens the 2x2 you carry; right-clicking a placed
   * crafting table opens the 3x3 (the server decides which - it checks the
   * block is really a table rather than trusting the request).
   *
   * Items move with the same two-click pick-then-place the backpack uses, not
   * a dragged cursor: each move is one self-contained message, so there's no
   * "held item" state to keep in sync across the network. The only extra is
   * that a pick now remembers WHICH grid it came from, since moves can cross
   * between the inventory and the cells.
   *
   * Everything shown here is server state: the cells live in the session, and
   * the result comes from the server running matchRecipe(), so this client
   * never needs the recipe list or the shape-matching rules.
   */
  const craftMenuEl = document.createElement('div');
  craftMenuEl.id = 'mp-craft-menu';
  craftMenuEl.hidden = true;
  const craftGridCells = document.createElement('div');
  craftGridCells.id = 'mp-craft-cells';
  const craftOutputSlot = document.createElement('button');
  craftOutputSlot.className = 'inventory-slot';
  craftOutputSlot.addEventListener('click', () => client.send({ type: 'craftTakeOutput' }));
  const craftInvEls: HTMLElement[] = [];
  const craftInvGrid = document.createElement('div');
  craftInvGrid.id = 'mp-craft-inventory';
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const btn = document.createElement('button');
    btn.className = 'inventory-slot';
    btn.addEventListener('click', () => onCraftSlotClick({ zone: 'inventory', index: i }));
    craftInvEls.push(btn);
    craftInvGrid.appendChild(btn);
  }
  const craftTopRow = document.createElement('div');
  craftTopRow.id = 'mp-craft-top';
  craftTopRow.append(craftGridCells, craftOutputSlot);
  craftMenuEl.append(craftTopRow, craftInvGrid);
  document.body.appendChild(craftMenuEl);

  let craftMenuOpen = false;
  let craftSide: 2 | 3 = 2;
  let craftInputs: InventorySlot[] = [];
  let craftOutput: InventorySlot = createEmptySlot();
  let craftCellEls: HTMLElement[] = [];
  /** Which slot is "picked up" for the next click, and which grid it lives in - null when nothing is held. */
  let craftPicked: CraftSlotRef | null = null;

  function rebuildCraftCells(side: 2 | 3): void {
    craftGridCells.innerHTML = '';
    craftGridCells.style.gridTemplateColumns = `repeat(${side}, auto)`;
    craftCellEls = [];
    for (let i = 0; i < side * side; i++) {
      const btn = document.createElement('button');
      btn.className = 'inventory-slot';
      btn.addEventListener('click', () => onCraftSlotClick({ zone: 'grid', index: i }));
      craftCellEls.push(btn);
      craftGridCells.appendChild(btn);
    }
  }

  const sameCraftRef = (a: CraftSlotRef | null, b: CraftSlotRef) => a !== null && a.zone === b.zone && a.index === b.index;

  function slotAt(ref: CraftSlotRef): InventorySlot | undefined {
    return ref.zone === 'grid' ? craftInputs[ref.index] : inventorySlots[ref.index];
  }

  function onCraftSlotClick(ref: CraftSlotRef): void {
    if (craftPicked === null) {
      if (slotAt(ref)?.id == null) return; // nothing there to pick up
      craftPicked = ref;
    } else if (sameCraftRef(craftPicked, ref)) {
      craftPicked = null; // clicked the same cell again - cancel
    } else {
      client.send({ type: 'craftMove', from: craftPicked, to: ref });
      craftPicked = null;
    }
    renderCraftMenu();
  }

  function renderCraftMenu(): void {
    if (craftCellEls.length !== craftSide * craftSide) rebuildCraftCells(craftSide);
    craftCellEls.forEach((el, i) => {
      renderSlot(el, craftInputs[i] ?? createEmptySlot());
      el.classList.toggle('picked', sameCraftRef(craftPicked, { zone: 'grid', index: i }));
    });
    craftInvEls.forEach((el, i) => {
      renderSlot(el, inventorySlots[i] ?? createEmptySlot());
      el.classList.toggle('picked', sameCraftRef(craftPicked, { zone: 'inventory', index: i }));
    });
    renderSlot(craftOutputSlot, craftOutput);
  }

  function setCraftMenuOpen(open: boolean, table: { x: number; y: number; z: number } | null = null): void {
    craftMenuOpen = open;
    craftMenuEl.hidden = !open;
    craftPicked = null;
    if (open) {
      client.send({ type: 'craftOpen', table });
      unlockPointerForGui();
    } else {
      // Tell the server too: it hands whatever was staged in the cells back
      // to the inventory, so closing the panel can't swallow items.
      client.send({ type: 'craftClose' });
      lockPointer(canvas);
    }
  }

  /**
   * Furnace GUI: right-click a placed furnace block to open it. Simplified
   * from a real drag-and-drop slot grid (same reasoning as the craft menu
   * above) - "Meter combustible"/"Meter para fundir" take the player's
   * currently SELECTED hotbar slot's whole stack into that furnace slot
   * instead of a per-item drag, and clicking the output slot collects it.
   */
  const furnaceEl = document.createElement('div');
  furnaceEl.id = 'mp-furnace';
  furnaceEl.hidden = true;
  const furnaceInputSlot = document.createElement('button');
  const furnaceFuelSlot = document.createElement('button');
  const furnaceOutputSlot = document.createElement('button');
  for (const btn of [furnaceInputSlot, furnaceFuelSlot, furnaceOutputSlot]) btn.className = 'inventory-slot';
  const furnaceInsertInputBtn = document.createElement('button');
  furnaceInsertInputBtn.textContent = 'Meter para fundir';
  const furnaceInsertFuelBtn = document.createElement('button');
  furnaceInsertFuelBtn.textContent = 'Meter combustible';
  const furnaceCookBar = document.createElement('div');
  furnaceCookBar.className = 'mp-furnace-bar';
  const furnaceCookFill = document.createElement('div');
  furnaceCookBar.appendChild(furnaceCookFill);
  const furnaceLitBar = document.createElement('div');
  furnaceLitBar.className = 'mp-furnace-bar';
  const furnaceLitFill = document.createElement('div');
  furnaceLitBar.appendChild(furnaceLitFill);
  const furnacePanel = document.createElement('div');
  furnacePanel.id = 'mp-furnace-panel';
  furnacePanel.append(
    furnaceInputSlot, furnaceCookBar, furnaceOutputSlot,
    furnaceFuelSlot, furnaceLitBar,
    furnaceInsertInputBtn, furnaceInsertFuelBtn,
  );
  furnaceEl.appendChild(furnacePanel);
  document.body.appendChild(furnaceEl);
  let furnacePos: { x: number; y: number; z: number } | null = null;
  let furnaceOpenState = false;
  function renderFurnace(state: { input: { id: number; count: number } | null; fuel: { id: number; count: number } | null; output: { id: number; count: number } | null; cookTime: number; litTime: number; litDuration: number }): void {
    renderSlot(furnaceInputSlot, state.input ? { id: state.input.id, name: '', count: state.input.count } : createEmptySlot());
    renderSlot(furnaceFuelSlot, state.fuel ? { id: state.fuel.id, name: '', count: state.fuel.count } : createEmptySlot());
    renderSlot(furnaceOutputSlot, state.output ? { id: state.output.id, name: '', count: state.output.count } : createEmptySlot());
    furnaceCookFill.style.width = `${Math.min(1, state.cookTime / COOK_SECONDS) * 100}%`;
    furnaceLitFill.style.width = `${state.litDuration > 0 ? (state.litTime / state.litDuration) * 100 : 0}%`;
  }
  function setFurnaceOpen(open: boolean, pos?: { x: number; y: number; z: number }): void {
    furnaceOpenState = open;
    furnaceEl.hidden = !open;
    if (open && pos) {
      furnacePos = pos;
      client.send({ type: 'furnaceOpen', x: pos.x, y: pos.y, z: pos.z });
      unlockPointerForGui();
    } else {
      if (furnacePos) client.send({ type: 'furnaceClose' });
      furnacePos = null;
      lockPointer(canvas);
    }
  }
  furnaceInsertInputBtn.addEventListener('click', () => {
    if (furnacePos) client.send({ type: 'furnaceInsert', ...furnacePos, target: 'input' });
  });
  furnaceInsertFuelBtn.addEventListener('click', () => {
    if (furnacePos) client.send({ type: 'furnaceInsert', ...furnacePos, target: 'fuel' });
  });
  furnaceOutputSlot.addEventListener('click', () => {
    if (furnacePos) client.send({ type: 'furnaceTakeOutput', ...furnacePos });
  });

  let yaw = 0;
  let pitch = 0;
  let seq = 0;
  let running = true;
  const lastServerPos = new THREE.Vector3(0, 2, 0);

  const DIGIT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];
  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === 'Escape') disconnect('Disconnected');
    if (e.code === 'KeyC') { if (backpackOpen) setBackpackOpen(false); if (furnaceOpenState) setFurnaceOpen(false); setCraftMenuOpen(!craftMenuOpen); return; }
    if (e.code === 'KeyE') {
      if (craftMenuOpen) setCraftMenuOpen(false);
      if (furnaceOpenState) { setFurnaceOpen(false); return; } // E closes the furnace instead of opening the backpack while it's up
      setBackpackOpen(!backpackOpen);
      return;
    }
    if (craftMenuOpen || backpackOpen || furnaceOpenState) return; // don't move/select slots while a menu has the pointer
    const digitIndex = DIGIT_CODES.indexOf(e.code);
    if (digitIndex !== -1) client.send({ type: 'selectSlot', index: digitIndex });
    if (e.code === 'KeyQ') {
      const dir = camera.getWorldDirection(new THREE.Vector3());
      client.send({ type: 'dropItem', dir: { x: dir.x, y: dir.y, z: dir.z } });
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * MOUSE_SENSITIVITY;
    pitch -= e.movementY * MOUSE_SENSITIVITY;
    pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  };
  document.addEventListener('mousemove', onMouseMove);

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

  function performInteraction(ndc: THREE.Vector2, action: 'break' | 'place' | 'attack'): boolean {
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
    const hit = hits.find((h) => h.distance <= REACH);
    if (!hit) return false;
    const entityId = hit.object.userData.entityId as number | undefined;
    if (action === 'attack') {
      // Mob ids are negative (ServerMobManager); player ids are positive -
      // PvP is deliberately not wired up yet (see world-do.ts's attack
      // handler), so this just doesn't send anything for a player target.
      if (entityId === undefined || entityId >= 0) return false;
      client.send({ type: 'attack', targetId: entityId });
      return true;
    }
    if (entityId !== undefined || !hit.face) return false;
    const normal = hit.face.normal;
    if (action === 'break') {
      const b = hit.point.clone().addScaledVector(normal, -0.01).round();
      client.send({ type: 'breakBlock', x: b.x, y: b.y, z: b.z });
    } else {
      // Right-clicking an existing FURNACE block opens its GUI instead of
      // placing a new block against it - same "existing block under the
      // crosshair" coordinate the break branch uses, not the neighbouring
      // spot a new block would land in.
      const existing = hit.point.clone().addScaledVector(normal, -0.01).round();
      if (getBlock(existing.x, existing.y, existing.z) === BlockId.FURNACE) {
        setFurnaceOpen(true, { x: existing.x, y: existing.y, z: existing.z });
        return true;
      }
      // A crafting table opens the 3x3 rather than getting a block placed
      // against it, same as singleplayer's own right-click on one.
      if (getBlock(existing.x, existing.y, existing.z) === BlockId.CRAFTING_TABLE) {
        setCraftMenuOpen(true, { x: existing.x, y: existing.y, z: existing.z });
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
    }
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
      // A left-click first tries an attack (mob under the crosshair); if that
      // misses, it falls back to breaking whatever block is under it instead.
      if (!performInteraction(CENTER_NDC, 'attack')) performInteraction(CENTER_NDC, 'break');
    } else if (e.button === 2) {
      if (holdingBow() && hasArrows()) bowDrawStart = performance.now();
      else if (!holdingBow()) performInteraction(CENTER_NDC, 'place');
    }
  };
  const onMouseUp = (e: MouseEvent) => { if (e.button === 2) releaseBow(); };
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
          yaw -= dx * MOUSE_SENSITIVITY;
          pitch -= dy * MOUSE_SENSITIVITY;
          pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
        },
        onTapPlace: () => { if (touchAimNdc) performInteraction(touchAimNdc, 'place'); },
        onBreakStart: () => { if (touchAimNdc) performInteraction(touchAimNdc, 'break'); },
        onBreakEnd: () => {}, // breaking is instant server-side (no mining time yet) - nothing to stop
        onAttackTry: () => (touchAimNdc ? performInteraction(touchAimNdc, 'attack') : false),
        onAimMove: (clientX, clientY) => {
          const rect = canvas.getBoundingClientRect();
          const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
          const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
          touchAimNdc = touchAimNdc ? touchAimNdc.set(ndcX, ndcY) : new THREE.Vector2(ndcX, ndcY);
        },
        onAimEnd: () => { touchAimNdc = null; },
        onInventory: () => {}, // no inventory in multiplayer yet - see the module doc comment
        onThirdPerson: () => {}, // no third-person camera in multiplayer yet
        onChat: () => {}, // no chat UI in multiplayer yet (chat messages only go to devtools console)
        onPause: () => disconnect('Disconnected'),
      }, document.body) // not #game-shell (default) - that's hidden entirely above, which would hide these controls too
    : null;

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  /** Every player's currently-known skin ("data: URL, or null for default), keyed by their entity id - populated from the server's playerSkin messages (see client.connect below), which can arrive before OR after that player's first state snapshot creates their avatar. */
  const playerSkins = new Map<number, string | null>();
  /** Decoded once per skin string and cached, since the same data: URL is re-sent to every client and shouldn't be re-decoded per remote avatar. `null` (the default skin) and a load failure both resolve to `null` - createSkinMaterials(null) already falls back to the built-in skin. */
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
      new THREE.MeshBasicMaterial({ visible: false }),
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
    label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
    labelLayer.appendChild(label);
    return {
      mesh: model.group, hitbox, label, labelOffsetY: 1.1, playerModel: model, skinMaterials: materials,
      lastHealth: Infinity, lastYaw: 0, moveDeltaX: 0, moveDeltaZ: 0, kind: 'player',
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
      new THREE.MeshBasicMaterial({ visible: false }),
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
      lastHealth: Infinity, lastYaw: 0, moveDeltaX: 0, moveDeltaZ: 0, kind,
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
    entity.playerModel.setOrientation(entity.lastYaw, 0, entity.moveDeltaX, entity.moveDeltaZ, delta);
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
    client.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('contextmenu', onContextMenu);
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
    healthEl.hidden = true;
    airEl.hidden = true;
    gameShell.style.display = previousGameShellDisplay;
    labelLayer.remove();
    hotbarEl.remove();
    deathEl.remove();
    fireOverlayEl.remove();
    underwaterOverlayEl.remove();
    craftMenuEl.remove();
    backpackEl.remove();
    furnaceEl.remove();
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
      clientDayTime = msg.dayTime;
      applyDayNightState(clientDayTime);
      void initTerrain(msg.worldSeed);
    },
    onRejected: (reason) => disconnect(`Rejected: ${reason}`),
    onState: (msg) => {
      lastServerPos.set(msg.self.pos.x, msg.self.pos.y, msg.self.pos.z);
      healthEl.textContent = '❤ '.repeat(Math.ceil(msg.self.health / 2)).trim() || '💀';
      if (msg.self.health < lastSelfHealth) soundManager.playRandom('player/Player_hurt', 3, 0.7);
      lastSelfHealth = msg.self.health;
      // Bubbles only while actually drowning - a full bar means "on dry land",
      // where singleplayer's HUD hides the row rather than showing 10 of 10.
      airEl.hidden = msg.self.air >= 10;
      if (!airEl.hidden) airEl.textContent = '🫧'.repeat(msg.self.air);
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
        if (e.dying && op.dyingFor === undefined) {
          op.dyingFor = 0;
          op.mobModel?.setDying(true); // holds the red tint on for the whole topple instead of letting the hurt flash expire mid-fall
          playMobSound(soundManager, op.kind as MobKind, 'death', 0.8);
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
          if (!op.playerModel) playMobSound(soundManager, op.kind as MobKind, 'hurt', 0.7);
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
    onBlockChanged: (msg) => applyBlockChange(msg.x, msg.y, msg.z, msg.blockId),
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
      renderHotbar();
      if (backpackOpen) renderBackpack();
      if (craftMenuOpen) renderCraftMenu();
    },
    // The server still offers the older "craft straight from a recipe index"
    // shortcut, but this client drives the real grid instead, so there's
    // nothing to do with the affordable-recipe list any more.
    onCraftableRecipes: () => {},
    onCraftGridState: (side, inputs, output) => {
      craftSide = side;
      craftInputs = inputs;
      craftOutput = output;
      if (craftMenuOpen) renderCraftMenu();
    },
    onCraftGridClosed: () => {
      craftInputs = [];
      craftOutput = createEmptySlot();
    },
    onFurnaceState: (x, y, z, state) => {
      if (furnacePos && furnacePos.x === x && furnacePos.y === y && furnacePos.z === z) renderFurnace(state);
    },
    onChat: (from, text) => console.log(`[chat] ${from}: ${text}`),
    onClose: (reason) => disconnect(reason),
  }, loadPlayerSkinDataUrl());

  let lastSend = 0;
  function sendInput(now: number): void {
    if (now - lastSend < SEND_INTERVAL_MS) return;
    lastSend = now;
    if (isDead) return; // the server ignores a dead player's input anyway; not sending it keeps the corpse from "walking" the moment they respawn
    let moveX = touchMoveX, moveZ = touchMoveZ;
    if (keys.has('KeyW')) moveZ -= 1;
    if (keys.has('KeyS')) moveZ += 1;
    if (keys.has('KeyA')) moveX -= 1;
    if (keys.has('KeyD')) moveX += 1;
    moveX = THREE.MathUtils.clamp(moveX, -1, 1);
    moveZ = THREE.MathUtils.clamp(moveZ, -1, 1);
    client.send({
      type: 'input',
      seq: ++seq,
      moveX, moveZ,
      wantJump: keys.has('Space') || touchJump,
      sprinting: keys.has('ControlLeft') || touchSprint,
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

  let lastFrameTime = 0;
  function frame(now: number): void {
    if (!running) return;
    requestAnimationFrame(frame);
    // Position is always the server's last confirmed value (no local
    // prediction yet - see the module doc comment); look direction is local
    // for a responsive camera despite network latency on movement itself.
    camera.position.copy(lastServerPos);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    sendInput(now);
    updateStreaming();
    updateLabels();
    // Same 0.1s spiral-of-death clamp main.ts's own animate() uses - a
    // backgrounded/minimized tab's first frame back can report a
    // multi-second gap, which would otherwise fling a remote player's
    // walk-cycle/orientation easing wildly off in one step.
    const delta = lastFrameTime === 0 ? 0 : Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;
    for (const entity of remoteEntities.values()) updateRemoteAnimation(entity, delta);
    animateGroundItems(delta);
    particles?.update(delta, camera);
    smokeParticles.update(delta);
    updateChewing(delta);
    ambient.update(camera.position, delta);
    clientDayTime += delta;
    applyDayNightState(clientDayTime, delta);
    // After the day/night pass, so surfacing restores the sky for the CURRENT
    // time of day rather than a fixed daytime blue - and so `submerged` is
    // fresh for the next frame's applyDayNightState guard.
    submerged = underwater.update(currentSkyColor).isUnderwater;
    for (let i = 0; i < RELIGHT_CHUNKS_PER_FRAME && relightQueue.length > 0; i++) {
      chunks.get(relightQueue.shift()!)?.rebuildDirty();
    }
    if (materials) materials.updateWaterAnimation(now / 1000);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) lockPointer(canvas); });
}

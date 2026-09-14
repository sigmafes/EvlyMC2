import * as THREE from 'three';
import { MpClient } from './net/mp-client';
import { BlockId, blockLightProperties, createBlockMaterials, type BlockMaterials } from './block';
import { Chunk, CHUNK_SIZE, CHUNK_HEIGHT } from './chunk';
import { TerrainNoise } from './terrain-noise';
import { lockPointer, unlockPointerForGui } from './is-touch';
import { TouchControls } from './touch-controls';
import { PlayerModel, createSkinMaterials, disposeSkinMaterials, type PlayerSkinMaterials } from './player-model';
import { loadPlayerSkinDataUrl } from './player-skin';
import { LightEngine, type LightWorld } from './light-engine';
import { computeDayNightState, resolveCycleTime, NIGHT_SKY_DARKEN } from './day-night-math';
import type { EntitySnapshot } from './net/protocol';

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
 * Still-limited scope (matches world-do.ts's own documented scope): mobs
 * render as plain colour-coded capsules, not their real
 * skinned models (that needs texture loading this client doesn't do per-mob
 * yet); melee combat only (left-click an entity's capsule - see onMouseDown),
 * no bow/ranged attack from the player and no PvP (world-do.ts rejects a
 * non-negative attack target); health is a plain heart-count string, not the
 * real HUD; no inventory/crafting/furnace; no client-side prediction (camera
 * POSITION always comes from the server's last `state` message - only look
 * direction is local, for responsiveness). Every one of
 * those is a real follow-up, not a corner cut by accident.
 */

const TICK_HZ = 20;
const SEND_INTERVAL_MS = 1000 / TICK_HZ;
const MOUSE_SENSITIVITY = 0.0022;
const PLACE_BLOCK_ID = BlockId.STONE;
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
  /** Only for kind:'player' - the real skinned/animated model (see makeEntityAvatar); mobs still get the placeholder capsule (ENTITY_COLOR) until real per-mob models are wired into the multiplayer client. */
  playerModel?: PlayerModel;
  /** This player's own skin materials (see createSkinMaterials) - kept so onEntityRemoved/disconnect can dispose them; undefined for a mob. */
  skinMaterials?: PlayerSkinMaterials;
  /** Health as of the last `state` tick - a drop since then triggers the player model's hurt-flash (mobs don't bother, no visual feedback to flash on a capsule anyway). */
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
};

/** Rough colour-coding per MOB kind, until real per-mob models/skins are wired into the multiplayer client (out of scope for this pass - see the module doc comment). Players get a real PlayerModel instead - see makeEntityAvatar. */
const ENTITY_COLOR: Record<string, number> = {
  player: 0x3a7bd5,
  pig: 0xe7a0a0,
  cow: 0x6b4a2f,
  sheep: 0xe8e8e0,
  zombie: 0x3f7d3f,
  skeleton: 0xcfcfc0,
};

export function startMultiplayer(serverUrl: string, worldId: string, playerName: string): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#mp-canvas')!;
  const crosshair = document.querySelector<HTMLElement>('#mp-crosshair')!;
  const hint = document.querySelector<HTMLElement>('#mp-hint')!;
  const healthEl = document.querySelector<HTMLElement>('#mp-health')!;
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
  function applyDayNightState(elapsed: number): void {
    const cycleTime = resolveCycleTime(elapsed, 0);
    const { skyDarken } = computeDayNightState(cycleTime);
    if (lightEngine.setSkyDarken(skyDarken)) {
      relightQueue.length = 0;
      for (const key of chunks.keys()) relightQueue.push(key);
    }
    const skyColor = DAY_SKY_COLOR.clone().lerp(NIGHT_SKY_COLOR, skyDarken / NIGHT_SKY_DARKEN);
    scene.background = skyColor;
    fog.color.copy(skyColor);
  }

  function applyBlockChange(x: number, y: number, z: number, id: BlockId): void {
    edits.set(`${x},${y},${z}`, id);
    const [cx, cz] = chunkCoordOf(x, z);
    const chunk = chunks.get(`${cx},${cz}`);
    if (chunk && chunk.setBlock(x, y, z, id)) chunk.rebuildDirty(Infinity, y);
  }

  const remoteEntities = new Map<number, RemoteEntity>();
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:901;';
  document.body.appendChild(labelLayer);

  let yaw = 0;
  let pitch = 0;
  let seq = 0;
  let running = true;
  const lastServerPos = new THREE.Vector3(0, 2, 0);

  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === 'Escape') disconnect('Disconnected');
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
  function performInteraction(ndc: THREE.Vector2, action: 'break' | 'place' | 'attack'): boolean {
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
      const p = hit.point.clone().addScaledVector(normal, 0.5).round();
      client.send({ type: 'placeBlock', x: p.x, y: p.y, z: p.z, blockId: PLACE_BLOCK_ID, face: 0 });
    }
    return true;
  }

  const CENTER_NDC = new THREE.Vector2(0, 0);
  const onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) { lockPointer(canvas); return; }
    if (e.button === 0) {
      // A left-click first tries an attack (mob under the crosshair); if that
      // misses, it falls back to breaking whatever block is under it instead.
      if (!performInteraction(CENTER_NDC, 'attack')) performInteraction(CENTER_NDC, 'break');
    } else if (e.button === 2) {
      performInteraction(CENTER_NDC, 'place');
    }
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  canvas.addEventListener('mousedown', onMouseDown);
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
   * skins can render at once without stomping each other. Mobs still get the
   * placeholder capsule below until real per-mob models are wired in (out of
   * scope here - see the module doc comment).
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
      lastHealth: Infinity, lastYaw: 0, moveDeltaX: 0, moveDeltaZ: 0,
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

  /** Placeholder avatar for a MOB - a colour-coded capsule, until real per-mob models/skins are wired into the multiplayer client (out of scope for this pass - see the module doc comment). A mob's `pos` is FEET height (mob-manager.ts convention, unchanged since Fase 1), so the capsule sits centred above it - the opposite of a player's eye-height origin. */
  function makeMobAvatar(id: number, kind: string, name: string): RemoteEntity {
    const height = kind === 'zombie' || kind === 'skeleton' ? 1.9 : 1.3;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, Math.max(height - 0.6, 0.2), 4, 8),
      new THREE.MeshLambertMaterial({ color: ENTITY_COLOR[kind] ?? 0xffffff }),
    );
    body.position.y = height / 2;
    body.userData.entityId = id; // read by onMouseDown to tell an attack target apart from terrain
    mesh.add(body);
    scene.add(mesh);
    const label = document.createElement('div');
    label.textContent = name;
    label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
    labelLayer.appendChild(label);
    return {
      mesh, hitbox: body, label, labelOffsetY: height + 0.3,
      lastHealth: Infinity, lastYaw: 0, moveDeltaX: 0, moveDeltaZ: 0,
    };
  }

  /** Every Mesh's geometry under `root` - a player model is ~10 boxes (body parts + their overlay shells + the hitbox), each its own BufferGeometry created fresh per PlayerModel instance (never shared, unlike singleplayer's one-off local model), so leaving these behind on every join/leave/skin-rebuild would leak real GPU memory over a long session. Materials are handled separately (disposeSkinMaterials, or a mob capsule's own one-off material) since which material(s) a mesh owns vs. shares varies by avatar kind. */
  function disposeGroupGeometries(root: THREE.Object3D): void {
    root.traverse((obj) => { if (obj instanceof THREE.Mesh) obj.geometry.dispose(); });
  }

  function removeEntityAvatar(entity: RemoteEntity): void {
    scene.remove(entity.mesh);
    entity.label.remove();
    disposeGroupGeometries(entity.mesh);
    if (entity.skinMaterials) disposeSkinMaterials(entity.skinMaterials);
    else (entity.hitbox.material as THREE.Material).dispose(); // mob capsule - its own one-off MeshLambertMaterial, not shared
  }

  /** Advances one remote player's walk-cycle/orientation animation - see moveDeltaX/Z's doc comment for why this reads a value computed once per tick rather than the entity's raw position each frame. Call every render frame, not just on a `state` message, so the swing stays smooth between the server's 20Hz updates. */
  function updateRemoteAnimation(entity: RemoteEntity, delta: number): void {
    if (!entity.playerModel) return;
    const moving = entity.moveDeltaX * entity.moveDeltaX + entity.moveDeltaZ * entity.moveDeltaZ > 0.0001;
    if (moving) entity.playerModel.startWalking(); else entity.playerModel.stopWalking();
    entity.playerModel.setOrientation(entity.lastYaw, 0, entity.moveDeltaX, entity.moveDeltaZ, delta);
    entity.playerModel.updateWalkingAnimation(delta);
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
    canvas.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('resize', onResize);
    touchControls?.destroy();
    document.body.classList.remove('mp-touch');
    document.exitPointerLock();
    canvas.hidden = true;
    crosshair.hidden = true;
    hint.hidden = true;
    healthEl.hidden = true;
    gameShell.style.display = previousGameShellDisplay;
    labelLayer.remove();
    for (const [, p] of remoteEntities) removeEntityAvatar(p);
    // Chunk geometries are real GPU resources (BufferGeometry) - renderer.dispose()
    // below doesn't free those on its own, so a reconnect in the same page
    // session would otherwise leak VRAM for every streamed-in chunk.
    for (const chunk of chunks.values()) chunk.dispose();
    renderer.dispose();
    unlockPointerForGui();
    connectScreen.hidden = false;
    messageEl.textContent = reason;
    messageEl.classList.toggle('mp-error', reason !== 'Disconnected');
  }

  const client = new MpClient();
  client.connect(serverUrl, worldId, playerName, {
    onWelcome: (msg) => {
      lastServerPos.set(msg.spawn.x, msg.spawn.y, msg.spawn.z);
      camera.position.copy(lastServerPos);
      clientDayTime = msg.dayTime;
      applyDayNightState(clientDayTime);
      void initTerrain(msg.worldSeed);
    },
    onRejected: (reason) => disconnect(`Rejected: ${reason}`),
    onState: (msg) => {
      lastServerPos.set(msg.self.pos.x, msg.self.pos.y, msg.self.pos.z);
      healthEl.textContent = '❤ '.repeat(Math.ceil(msg.self.health / 2)).trim() || '💀';
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
            op = makeMobAvatar(e.id, e.kind, e.name ?? e.kind);
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
        if (op.playerModel && e.health < op.lastHealth) op.playerModel.hurt();
        op.lastHealth = e.health;
      }
      for (const [id, op] of remoteEntities) {
        if (seen.has(id)) continue;
        removeEntityAvatar(op);
        remoteEntities.delete(id);
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
    onDayTime: (elapsed) => { clientDayTime = elapsed; },
    onChat: (from, text) => console.log(`[chat] ${from}: ${text}`),
    onClose: (reason) => disconnect(reason),
  }, loadPlayerSkinDataUrl());

  let lastSend = 0;
  function sendInput(now: number): void {
    if (now - lastSend < SEND_INTERVAL_MS) return;
    lastSend = now;
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
    clientDayTime += delta;
    applyDayNightState(clientDayTime);
    for (let i = 0; i < RELIGHT_CHUNKS_PER_FRAME && relightQueue.length > 0; i++) {
      chunks.get(relightQueue.shift()!)?.rebuildDirty();
    }
    if (materials) materials.updateWaterAnimation(now / 1000);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) lockPointer(canvas); });
}

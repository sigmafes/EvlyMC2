import * as THREE from 'three';
import { MpClient } from './net/mp-client';
import { BlockId, createBlockMaterials, type BlockMaterials } from './block';
import { Chunk, CHUNK_SIZE } from './chunk';
import { TerrainNoise } from './terrain-noise';
import { lockPointer, unlockPointerForGui } from './is-touch';
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
};

/** Rough colour-coding per entity kind, until real per-mob models/skins are wired into the multiplayer client (out of scope for this pass - see the module doc comment). */
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

  canvas.hidden = false;
  crosshair.hidden = false;
  hint.hidden = false;
  healthEl.hidden = false;
  menu.hidden = true;
  connectScreen.hidden = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7fb8ff);
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
    chunk.rebuildDirty();
    chunks.set(key, chunk);
    rebuildChunkMeshList();
  }

  function unloadChunk(key: string): void {
    const chunk = chunks.get(key);
    if (!chunk) return;
    chunk.dispose();
    chunks.delete(key);
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

  // Same block-position-from-hit formula as raycast.ts's resolveBlockPosition
  // (minus its fire-plane special case, not relevant here): nudge the hit
  // point slightly INTO the face along its normal before rounding, so it
  // lands on the block that was actually hit rather than its neighbour.
  const raycaster = new THREE.Raycaster();
  const onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) { lockPointer(canvas); return; }
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    // Entity hitboxes take priority over terrain at the same/closer distance -
    // attacking a mob standing right against a wall shouldn't accidentally
    // break the wall instead just because intersectObjects happened to order
    // it second. Both lists go through in one call so `hits` is already
    // sorted by distance; explicitly preferring an entity within REACH over
    // a same-ray terrain hit further away.
    const entityHitboxes = [...remoteEntities.values()].map((r) => r.hitbox);
    const hits = raycaster.intersectObjects([...chunkMeshes, ...entityHitboxes], false);
    const hit = hits.find((h) => h.distance <= REACH);
    if (!hit) return;
    const entityId = hit.object.userData.entityId as number | undefined;
    if (e.button === 0 && entityId !== undefined) {
      // Mob ids are negative (ServerMobManager); player ids are positive -
      // PvP is deliberately not wired up yet (see world-do.ts's attack
      // handler), so this just doesn't send anything for a player target.
      if (entityId < 0) client.send({ type: 'attack', targetId: entityId });
      return;
    }
    if (!hit.face) return;
    const normal = hit.face.normal;
    if (e.button === 0) {
      const b = hit.point.clone().addScaledVector(normal, -0.01).round();
      client.send({ type: 'breakBlock', x: b.x, y: b.y, z: b.z });
    } else if (e.button === 2 && entityId === undefined) {
      const p = hit.point.clone().addScaledVector(normal, 0.5).round();
      client.send({ type: 'placeBlock', x: p.x, y: p.y, z: p.z, blockId: PLACE_BLOCK_ID, face: 0 });
    }
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  /**
   * Rough placeholder avatar for any remote entity (another player or a
   * mob) - a colour-coded capsule, not the real skinned player/mob models
   * (those need texture loading this lightweight client doesn't do yet, see
   * the module doc comment). `kind` decides both colour and where the mesh
   * origin sits: a player's `pos` is EYE height (protocol.ts/player-physics.ts
   * convention) so the capsule hangs below it, while a mob's `pos` is FEET
   * height (mob-manager.ts convention, unchanged since Fase 1) so the
   * capsule sits centred above it instead - getting this backwards would
   * plant one of the two either floating or waist-deep in the ground.
   */
  function makeEntityAvatar(id: number, kind: string, name: string): RemoteEntity {
    const isPlayer = kind === 'player';
    const height = isPlayer ? 1.8 : kind === 'zombie' || kind === 'skeleton' ? 1.9 : 1.3;
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, Math.max(height - 0.6, 0.2), 4, 8),
      new THREE.MeshLambertMaterial({ color: ENTITY_COLOR[kind] ?? 0xffffff }),
    );
    body.position.y = isPlayer ? -0.9 : height / 2;
    body.userData.entityId = id; // read by onMouseDown to tell an attack target apart from terrain
    mesh.add(body);
    scene.add(mesh);
    const label = document.createElement('div');
    label.textContent = name;
    label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
    labelLayer.appendChild(label);
    return { mesh, hitbox: body, label, labelOffsetY: isPlayer ? 1.1 : height + 0.3 };
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
    document.exitPointerLock();
    canvas.hidden = true;
    crosshair.hidden = true;
    hint.hidden = true;
    healthEl.hidden = true;
    gameShell.style.display = previousGameShellDisplay;
    labelLayer.remove();
    for (const [, p] of remoteEntities) { scene.remove(p.mesh); p.label.remove(); }
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
        if (!op) { op = makeEntityAvatar(e.id, e.kind, e.name ?? e.kind); remoteEntities.set(e.id, op); }
        op.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
        op.mesh.rotation.y = e.yaw;
      }
      for (const [id, op] of remoteEntities) {
        if (seen.has(id)) continue;
        scene.remove(op.mesh); op.label.remove(); remoteEntities.delete(id);
      }
    },
    onBlockChanged: (msg) => applyBlockChange(msg.x, msg.y, msg.z, msg.blockId),
    onEntityRemoved: (id) => {
      const op = remoteEntities.get(id);
      if (op) { scene.remove(op.mesh); op.label.remove(); remoteEntities.delete(id); }
    },
    onChat: (from, text) => console.log(`[chat] ${from}: ${text}`),
    onClose: (reason) => disconnect(reason),
  });

  let lastSend = 0;
  function sendInput(now: number): void {
    if (now - lastSend < SEND_INTERVAL_MS) return;
    lastSend = now;
    let moveX = 0, moveZ = 0;
    if (keys.has('KeyW')) moveZ -= 1;
    if (keys.has('KeyS')) moveZ += 1;
    if (keys.has('KeyA')) moveX -= 1;
    if (keys.has('KeyD')) moveX += 1;
    client.send({
      type: 'input',
      seq: ++seq,
      moveX, moveZ,
      wantJump: keys.has('Space'),
      sprinting: keys.has('ControlLeft'),
      sneaking: keys.has('ShiftLeft'),
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
    if (materials) materials.updateWaterAnimation(now / 1000);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) lockPointer(canvas); });
}

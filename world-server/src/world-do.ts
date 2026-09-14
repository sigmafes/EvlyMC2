import * as THREE from 'three';
import { PlayerPhysics } from '../../src/player-physics';
import type { BlockCollider } from '../../src/chunk';
import type {
  ClientMessage, ServerMessage, EntitySnapshot, Vec3,
} from '../../src/net/protocol';
import { PROTOCOL_VERSION, isClientMessageType } from '../../src/net/protocol';
import { BlockId } from '../../src/block';
import { ServerTerrain } from './terrain';
import { WATER_LEVEL } from '../../src/chunk';
import { ServerMobManager } from './mobs';
import type { MobKind } from '../../src/mob-manager';
import { DAY_LENGTH, computeDayNightState, resolveCycleTime } from '../../src/day-night-math';

export interface Env {
  WORLD_DO: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const MAX_DT_S = 0.1; // same spiral-of-death cap main.ts uses on the client
const PLAYER_MAX_HEALTH = 20; // LCE/singleplayer's 10 hearts x2 - see player-health.ts
const PLAYER_MELEE_RANGE = 4; // matches interaction.ts's own melee reach
const PLAYER_MELEE_DAMAGE = 4; // a plain fixed "punch" - no tool/weapon damage tiers server-side yet

/**
 * Per-connection state. One per joined player. `physics` is the exact same
 * PlayerPhysics class the client uses for local prediction (player-physics.ts
 * has no THREE.Scene/DOM dependency - see the Fase 1 analysis) - the server
 * runs it as the actual authority, the client's own copy is only a guess to
 * smooth over network latency until Fase 6 adds reconciliation.
 */
type Session = {
  ws: WebSocket;
  id: number;
  name: string;
  physics: PlayerPhysics;
  yaw: number;
  pitch: number;
  /** Latest movement intent received via an 'input' message - applied once per tick, not once per message, so an input flood can't speed up simulation. */
  intent: { moveX: number; moveZ: number; wantJump: boolean; sprinting: boolean; sneaking: boolean };
  lastSeq: number;
  health: number;
  /** The skin PNG (data: URL) this player joined with, or null for the built-in default - see onJoin. */
  skin: string | null;
};

/**
 * Fase 5 of the multiplayer migration plan: the world server itself, as a
 * Cloudflare Durable Object - one instance per world (see index.ts, which
 * routes /world/:worldId to `idFromName(worldId)`).
 *
 * CURRENT SCOPE (see the plan write-up for what's still ahead):
 * - Real authoritative movement: every connected player's position comes
 *   from a server-side PlayerPhysics instance, never from a claimed x/y/z.
 * - Real terrain (ServerTerrain/terrain.ts - the same deterministic Chunk/
 *   TerrainNoise generator the client uses, headless) drives collision, not
 *   a placeholder flat plane.
 * - Real block break/place, persisted in Durable Object storage and
 *   broadcast to everyone.
 * - Mobs (ServerMobManager/mobs.ts) spawned on the real terrain, running
 *   mob-ai.ts/mob-physics.ts unmodified.
 * - Combat: melee (attackMob) and hostile mobs hurting the nearest player
 *   (hurtPlayer, wired through ServerMobManager.update()'s per-mob
 *   MobAiDeps). A skeleton's shot is a guaranteed instant hit for now - no
 *   real arrow entity with travel time synced over the network yet. Death
 *   just resets health and teleports back to spawn, no death screen/
 *   animation/drops.
 * - Chat, broadcast to everyone.
 *
 * Still ahead: inventory/crafting/furnace, a real projectile for the
 * skeleton's arrow, PvP, terrain streaming past the static chunk grid
 * (multiplayer-game.ts's WORLD_RADIUS_CHUNKS), and death/respawn feedback
 * beyond a silent teleport.
 */
export class WorldDO implements DurableObject {
  private readonly sessions = new Map<WebSocket, Session>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** Sparse block edits, "x,y,z" -> BlockId (BlockId.AIR for a broken block). Persisted to DO storage under the same key. */
  private readonly edits = new Map<string, BlockId>();
  private editsLoaded = false;
  /** Real terrain (same deterministic Chunk/TerrainNoise generator the client uses) - see terrain.ts. Seeded once, from the first request's worldId. */
  private terrain: ServerTerrain | null = null;
  private worldSeed = 0;
  private readonly mobs = new ServerMobManager();
  private mobsSpawned = false;
  /**
   * Authoritative day/night clock (day-night-math.ts - the same pure cycle
   * math singleplayer's DayNightCycle wraps with scene/fog/lightEngine side
   * effects, here run headless). Starts at noon, same default as
   * singleplayer's own DayNightCycle. Every connected client free-runs an
   * identical copy locally between corrections (see multiplayer-game.ts) so
   * the sky doesn't visibly stutter waiting on network round-trips - this
   * field is the one true version they're periodically resynced to.
   */
  private dayNightElapsed = DAY_LENGTH / 2;
  private lastBroadcastSkyDarken = -1;
  private lastDayTimeBroadcast = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.editsLoaded) {
      const stored = await this.state.storage.list<BlockId>({ prefix: 'edit:' });
      for (const [key, value] of stored) this.edits.set(key.slice('edit:'.length), value);
      this.editsLoaded = true;
    }
    if (!this.terrain) {
      // index.ts forwards the original request unchanged (see its comment) -
      // re-parse the same /world/:id path here to derive a stable per-world
      // seed, so re-visiting the same worldId always regenerates the same
      // terrain (nothing about the terrain itself is persisted - only edits are).
      const match = new URL(request.url).pathname.match(/^\/world\/([A-Za-z0-9_-]{1,64})$/);
      this.worldSeed = hashSeed(match?.[1] ?? 'default');
      this.terrain = new ServerTerrain(this.worldSeed);
    }
    if (!this.mobsSpawned) {
      this.spawnInitialMobs();
      this.mobsSpawned = true;
    }

    const origin = request.headers.get('Origin') ?? '';
    const allowed = this.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
    if (origin && !allowed.includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private handleSocket(ws: WebSocket): void {
    ws.addEventListener('message', (event) => {
      let msg: ClientMessage;
      try {
        const raw = JSON.parse(String(event.data));
        if (typeof raw?.type !== 'string' || !isClientMessageType(raw.type)) return;
        msg = raw as ClientMessage;
      } catch {
        return; // malformed frame - ignore rather than crash the connection
      }
      this.onMessage(ws, msg);
    });
    ws.addEventListener('close', () => this.onDisconnect(ws));
    ws.addEventListener('error', () => this.onDisconnect(ws));
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket already gone */ }
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    const payload = JSON.stringify(msg);
    for (const [ws] of this.sessions) {
      if (ws === exclude) continue;
      try { ws.send(payload); } catch { /* drop silently, close event will clean it up */ }
    }
  }

  private onMessage(ws: WebSocket, msg: ClientMessage): void {
    if (msg.type === 'join') {
      this.onJoin(ws, msg);
      return;
    }

    const session = this.sessions.get(ws);
    if (!session) return; // anything before 'join' is ignored

    switch (msg.type) {
      case 'input':
        if (msg.seq <= session.lastSeq) return; // stale/duplicate, out of order
        session.lastSeq = msg.seq;
        session.yaw = msg.yaw;
        session.pitch = msg.pitch;
        session.intent = {
          moveX: THREE.MathUtils.clamp(msg.moveX, -1, 1),
          moveZ: THREE.MathUtils.clamp(msg.moveZ, -1, 1),
          wantJump: msg.wantJump,
          sprinting: msg.sprinting,
          sneaking: msg.sneaking,
        };
        session.physics.setSneaking(msg.sneaking);
        break;
      case 'breakBlock':
        this.setBlock(msg.x, msg.y, msg.z, BlockId.AIR);
        break;
      case 'placeBlock':
        this.setBlock(msg.x, msg.y, msg.z, msg.blockId);
        break;
      case 'chat':
        this.broadcast({ type: 'chat', from: session.name, text: msg.text });
        break;
      case 'attack':
        // Mob ids are always negative (ServerMobManager), session ids always
        // positive (this.nextId starts at 1) - rejecting a non-negative
        // target is a cheap way to disable PvP for this first pass without
        // needing a separate protocol field for it.
        if (msg.targetId < 0) this.attackMob(session, msg.targetId);
        break;
      // 'selectSlot' / 'useItem' / 'shootBow' / 'ping': inventory and bow
      // combat are follow-up work (see the class doc comment) - accepted
      // here so a client sending them doesn't error, but intentionally not
      // acted on yet.
      default:
        break;
    }
  }

  private onJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): void {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.send(ws, { type: 'rejected', reason: `protocol mismatch: server is v${PROTOCOL_VERSION}` });
      ws.close();
      return;
    }

    const id = this.nextId++;
    // Real terrain now (ServerTerrain, seeded from the worldId) - spawn point
    // is a real dry-land column found by findLandSpawn() (see its doc
    // comment), not a hardcoded (0,0) that might land in the middle of an
    // ocean. (+2.25 = +0.5 block-top + 1.75 player-physics.ts eyeHeight - a
    // fixed flat-world y=2 here previously put the player's feet 0.25 blocks
    // INSIDE the ground, which cascaded into the "1.8 in one tick" bug from
    // the first smoke test.)
    const [spawnX, spawnZ] = this.findLandSpawn();
    const spawn: Vec3 = { x: spawnX, y: this.findSpawnEyeY(spawnX, spawnZ), z: spawnZ };
    let physics!: PlayerPhysics;
    const getBlocks = () => this.getBlocksNear(physics.state.position);
    // isWater wires up swimming (buoyancy/stroke-up, see player-physics.ts) -
    // without it a player just free-falls through water blocks like air,
    // which is what made a spawn that happens to land underwater
    // unswimmable. isSolidBlockAt (6th param) lets it scan an arbitrary
    // range to escape if ever embedded in terrain, same as singleplayer.
    physics = new PlayerPhysics(
      getBlocks, undefined,
      (x, y, z) => this.isWaterAt(x, y, z),
      undefined, undefined,
      (x, y, z) => this.isSolidAt(x, y, z),
    );
    physics.setSpawn(spawn.x, spawn.y, spawn.z);

    // Cap absurdly large payloads (a well-behaved client only ever sends a
    // 64x64 PNG data URL, a few KB) - a malformed/hostile one shouldn't be
    // able to bloat every other client's memory via the playerSkin broadcast
    // below or the storage kept here for late joiners.
    const skin = typeof msg.skin === 'string' && msg.skin.length <= 200_000 ? msg.skin : null;

    const session: Session = {
      ws, id, name: msg.playerName || `Player${id}`, physics,
      yaw: 0, pitch: 0,
      intent: { moveX: 0, moveZ: 0, wantJump: false, sprinting: false, sneaking: false },
      lastSeq: 0,
      health: PLAYER_MAX_HEALTH,
      skin,
    };
    this.sessions.set(ws, session);

    this.send(ws, { type: 'welcome', playerId: id, worldSeed: this.worldSeed, spawn, tickRateHz: TICK_HZ, dayTime: this.dayNightElapsed });
    // Catch this client up on every edit made before it connected - our
    // placeholder world has no chunk system yet (see the class doc comment),
    // so there's no chunkData to send; replaying each edit as its own
    // blockChanged is simple and correct at this world's current tiny scale.
    for (const [key, id2] of this.edits) {
      const [x, y, z] = key.split(',').map(Number);
      this.send(ws, { type: 'blockChanged', x, y, z, blockId: id2 });
    }
    // Catch this client up on every already-connected player's skin, then
    // tell everyone else about this new player's - same backlog-replay
    // pattern as the edits loop just above.
    for (const [otherWs, other] of this.sessions) {
      if (otherWs === ws) continue;
      this.send(ws, { type: 'playerSkin', playerId: other.id, skin: other.skin });
    }
    this.broadcast({ type: 'playerSkin', playerId: id, skin }, ws);
    this.broadcast({ type: 'chat', from: 'server', text: `${session.name} joined` }, ws);
    this.ensureTicking();
  }

  private onDisconnect(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    if (!session) return;
    this.sessions.delete(ws);
    this.broadcast({ type: 'entityRemoved', id: session.id, reason: 'disconnect' });
    this.broadcast({ type: 'chat', from: 'server', text: `${session.name} left` });
    if (this.sessions.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private ensureTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    this.tickCount++;
    const dt = Math.min(TICK_MS / 1000, MAX_DT_S);

    this.dayNightElapsed += dt;
    const cycleTime = resolveCycleTime(this.dayNightElapsed, 0);
    const { skyDarken } = computeDayNightState(cycleTime);
    const flooredSkyDarken = Math.floor(skyDarken);
    // Resync every client's local clock (multiplayer-game.ts free-runs its
    // own copy between corrections, see day-night-math.ts's doc comment)
    // the instant the integer skyDarken step changes, so every player's sky
    // starts darkening/lightening at the same moment instead of drifting
    // apart client to client - plus a periodic correction regardless, so a
    // client that's drifted for some other reason (a stalled tab, a late
    // join) doesn't stay off forever.
    const dayTimeDue = flooredSkyDarken !== this.lastBroadcastSkyDarken || this.dayNightElapsed - this.lastDayTimeBroadcast >= 10;
    if (dayTimeDue) {
      this.lastBroadcastSkyDarken = flooredSkyDarken;
      this.lastDayTimeBroadcast = this.dayNightElapsed;
      this.broadcast({ type: 'dayTime', elapsed: this.dayNightElapsed });
    }

    for (const [, session] of this.sessions) {
      const direction = new THREE.Vector3(session.intent.moveX, 0, session.intent.moveZ);
      if (direction.lengthSq() > 0) direction.normalize();
      direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), session.yaw);
      session.physics.updatePhysics(direction, session.intent.wantJump, session.intent.sprinting, dt);
    }

    this.mobs.update(dt, {
      isSolid: (x, y, z) => this.isSolidAt(x, y, z),
      isWater: (x, y, z) => this.isWaterAt(x, y, z),
      players: [...this.sessions.values()].map((s) => ({ id: s.id, pos: s.physics.state.position })),
      onAttackPlayer: (playerId, damage) => this.hurtPlayer(playerId, damage),
      onShootArrow: (playerId, damage) => this.hurtPlayer(playerId, damage),
    });

    const entities: EntitySnapshot[] = [
      ...[...this.sessions.values()].map((s) => ({
        id: s.id,
        kind: 'player' as const,
        pos: { x: s.physics.state.position.x, y: s.physics.state.position.y, z: s.physics.state.position.z },
        yaw: s.yaw,
        health: s.health,
        maxHealth: PLAYER_MAX_HEALTH,
        onFire: false,
        dying: false,
        name: s.name,
      })),
      ...this.mobs.snapshots(),
    ];

    for (const [ws, session] of this.sessions) {
      const p = session.physics.state;
      this.send(ws, {
        type: 'state',
        tick: this.tickCount,
        ackSeq: session.lastSeq,
        self: {
          pos: { x: p.position.x, y: p.position.y, z: p.position.z },
          velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
          yaw: session.yaw,
          pitch: session.pitch,
          grounded: p.grounded,
          health: session.health,
        },
        // Every other player - not this connection's own entry (it already has `self`).
        entities: entities.filter((e) => e.id !== session.id),
      });
    }
  }

  /** Player melee attack on a mob - checked server-side (reach), never trusted from the client. */
  private attackMob(attacker: Session, targetId: number): void {
    const mobPos = this.mobs.getPos(targetId);
    if (!mobPos) return; // already dead/gone
    if (attacker.physics.state.position.distanceTo(mobPos) > PLAYER_MELEE_RANGE) return;
    this.mobs.damage(targetId, PLAYER_MELEE_DAMAGE, attacker.physics.state.position);
  }

  /**
   * Damage from a mob (melee or "shot") to a specific player. No fall
   * damage/drowning/fire tracked server-side yet - this is currently the
   * only source of player damage. On death: reset health and teleport back
   * to spawn immediately (no death screen/animation - purely a position +
   * health reset, see the class doc comment for what's still missing).
   */
  private hurtPlayer(playerId: number, damage: number): void {
    for (const session of this.sessions.values()) {
      if (session.id !== playerId) continue;
      session.health = Math.max(0, session.health - damage);
      if (session.health <= 0) {
        session.health = PLAYER_MAX_HEALTH;
        const [sx, sz] = this.findLandSpawn();
        session.physics.setSpawn(sx, this.findSpawnEyeY(sx, sz), sz);
        this.broadcast({ type: 'chat', from: 'server', text: `${session.name} died` });
      }
      return;
    }
  }

  private setBlock(x: number, y: number, z: number, id: BlockId): void {
    const key = `${x},${y},${z}`;
    this.edits.set(key, id);
    void this.state.storage.put(`edit:${key}`, id);
    this.broadcast({ type: 'blockChanged', x, y, z, blockId: id });
  }

  private isSolidAt(x: number, y: number, z: number): boolean {
    const edit = this.edits.get(`${x},${y},${z}`);
    if (edit !== undefined) return edit !== BlockId.AIR;
    return this.terrain!.isSolid(x, y, z);
  }

  /** Edits take priority over generated terrain, same as isSolidAt - so a player who fills in a lake (or digs a new pool) gets correct swimming behaviour there too, not just on untouched terrain. */
  private isWaterAt(x: number, y: number, z: number): boolean {
    const edit = this.edits.get(`${x},${y},${z}`);
    if (edit !== undefined) return edit === BlockId.WATER;
    return this.terrain!.getBlock(x, y, z) === BlockId.WATER;
  }

  /** Solid-block AABBs near `pos`, in the exact {id,x,y,z,collider:Box3} shape PlayerPhysics expects (chunk.ts's BlockCollider). */
  private getBlocksNear(pos: THREE.Vector3): BlockCollider[] {
    const colliders: BlockCollider[] = [];
    const cx = Math.round(pos.x), cy = Math.round(pos.y), cz = Math.round(pos.z);
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          if (!this.isSolidAt(x, y, z)) continue;
          colliders.push({
            id: BlockId.STONE,
            x, y, z,
            collider: new THREE.Box3(
              new THREE.Vector3(x - 0.5, y - 0.5, z - 0.5),
              new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
            ),
          });
        }
      }
    }
    return colliders;
  }

  /** Scans down from a safe height for the first solid block at (x,z), so a fresh player's spawn actually sits on the real terrain surface instead of a hardcoded height. If that surface is underwater (a lake/ocean floor), spawns at the water's surface instead of its floor - swimming now works (isWater is wired into PlayerPhysics, see onJoin), but there's no reason to make every fresh spawn start with an unrequested swim up from the bottom. */
  private findSpawnEyeY(x: number, z: number): number {
    for (let y = 140; y >= 0; y--) {
      if (this.isSolidAt(x, y, z)) {
        const groundY = y <= WATER_LEVEL ? WATER_LEVEL : y;
        return groundY + 2.25; // +0.5 (block top) + 1.75 (player-physics.ts's eyeHeight)
      }
    }
    return 2.25; // no solid ground found in range (shouldn't happen) - fall back to the old flat-world constant
  }

  /**
   * Finds a dry-land (x,z) column near the origin for a fresh/respawning
   * player, instead of always trying (0,0) - which, depending on the seed,
   * can be the middle of an ocean (findSpawnEyeY alone only kept a spawn
   * like that from being stuck underwater by surfacing it at the water
   * line, not by finding actual ground). Walks an outward square spiral,
   * testing terrain.surfaceHeight() - a cheap raw noise sample, no chunk
   * generation - at each column, and returns the first one above sea level.
   * Falls back to (0,0) if nothing within range qualifies (e.g. a seed that
   * is entirely ocean for a very long stretch - vanishingly unlikely with
   * this noise, but a spawn has to return something).
   */
  private findLandSpawn(): [x: number, z: number] {
    const STEP = 8;
    const MAX_RING = 20; // 20*8 = 160 blocks out, plenty for any real coastline
    // isLand mirrors chunk.ts's OWN isWaterBody predicate exactly
    // (surfaceY = Math.floor(getTerrainHeight(x,z)); isWaterBody = surfaceY
    // <= WATER_LEVEL) - comparing the raw float straight to WATER_LEVEL
    // without the floor let a column like 63.4 pass this check (63.4 > 63)
    // while the actual generated chunk still floored it to 63 and rendered
    // it as water, which is exactly the "spawned in the ocean" bug this
    // function exists to prevent in the first place.
    const isLand = (x: number, z: number) => Math.floor(this.terrain!.surfaceHeight(x, z)) > WATER_LEVEL;
    if (isLand(0, 0)) return [0, 0];
    for (let ring = 1; ring <= MAX_RING; ring++) {
      const r = ring * STEP;
      for (let x = -r; x <= r; x += STEP) {
        for (let z = -r; z <= r; z += STEP) {
          if (Math.abs(x) !== r && Math.abs(z) !== r) continue; // perimeter of this ring only
          if (isLand(x, z)) return [x, z];
        }
      }
    }
    return [0, 0];
  }

  /** A handful of animals + a couple of hostiles scattered around spawn, once per DO instance lifetime - not persisted (see mobs.ts's class doc comment: no death/drops yet, so nothing would need saving anyway). */
  private spawnInitialMobs(): void {
    const kinds: MobKind[] = ['pig', 'cow', 'sheep', 'pig', 'cow', 'zombie', 'skeleton'];
    for (const kind of kinds) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 6 + Math.random() * 14;
      const x = Math.round(Math.cos(angle) * radius);
      const z = Math.round(Math.sin(angle) * radius);
      const y = this.findSpawnEyeY(x, z) - 2.25 + 0.5; // feet-level: same ground-surface scan as the player spawn, converted from eye-height back to feet
      this.mobs.spawn(kind, new THREE.Vector3(x, y, z), Math.random() * Math.PI * 2);
    }
  }
}

/** Small deterministic string hash - same worldId always derives the same terrain seed. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

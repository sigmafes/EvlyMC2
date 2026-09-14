import * as THREE from 'three';
import { PlayerPhysics } from '../../src/player-physics';
import type { BlockCollider } from '../../src/chunk';
import type {
  ClientMessage, ServerMessage, EntitySnapshot, Vec3,
} from '../../src/net/protocol';
import { PROTOCOL_VERSION, isClientMessageType } from '../../src/net/protocol';
import { BlockId } from '../../src/block';

export interface Env {
  WORLD_DO: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
}

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const MAX_DT_S = 0.1; // same spiral-of-death cap main.ts uses on the client

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
};

/**
 * Fase 5 of the multiplayer migration plan: the world server itself, as a
 * Cloudflare Durable Object - one instance per world (see index.ts, which
 * routes /world/:worldId to `idFromName(worldId)`).
 *
 * SCOPE OF THIS FIRST VERSION (intentional, see the plan write-up):
 * - Real authoritative movement: every connected player's position comes
 *   from a server-side PlayerPhysics instance, never from a claimed x/y/z.
 * - Real block break/place, persisted in Durable Object storage and
 *   broadcast to everyone.
 * - Chat, broadcast to everyone.
 * - Collision is a single flat ground plane (solid at y<=0) plus whatever
 *   blocks have been placed/broken, NOT the full terrain generator
 *   (worldgen/*, chunk.ts's cave/ore/tree passes) - those live in `Chunk`,
 *   which today also owns THREE.Scene/mesh construction in its constructor
 *   and can't be instantiated headless yet. Separating Chunk's block DATA
 *   (the Uint8Array + generation passes) from its MESH construction is real
 *   follow-up work, not done here - this DO proves the networking/
 *   authority model end-to-end first, on a simple world, so that follow-up
 *   plugs into a server that already works.
 * - No mobs yet, for the same reason (MobManager's AI/physics are headless
 *   since Fase 1, but spawning/despawning logic assumes the client's
 *   getSkyExposure/getBlockId/chunk-loaded callbacks, which need the real
 *   terrain above to mean anything).
 */
export class WorldDO implements DurableObject {
  private readonly sessions = new Map<WebSocket, Session>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** Sparse block edits, "x,y,z" -> BlockId (BlockId.AIR for a broken block). Persisted to DO storage under the same key. */
  private readonly edits = new Map<string, BlockId>();
  private editsLoaded = false;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.editsLoaded) {
      const stored = await this.state.storage.list<BlockId>({ prefix: 'edit:' });
      for (const [key, value] of stored) this.edits.set(key.slice('edit:'.length), value);
      this.editsLoaded = true;
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
      // 'selectSlot' / 'useItem' / 'attack' / 'shootBow' / 'ping': inventory,
      // combat and mob interaction are follow-up work (see the class doc
      // comment) - accepted here so a client sending them doesn't error, but
      // intentionally not acted on yet.
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
    const spawn: Vec3 = { x: 0, y: 2, z: 0 };
    let physics!: PlayerPhysics;
    const getBlocks = () => this.getBlocksNear(physics.state.position);
    physics = new PlayerPhysics(getBlocks);
    physics.setSpawn(spawn.x, spawn.y, spawn.z);

    const session: Session = {
      ws, id, name: msg.playerName || `Player${id}`, physics,
      yaw: 0, pitch: 0,
      intent: { moveX: 0, moveZ: 0, wantJump: false, sprinting: false, sneaking: false },
      lastSeq: 0,
      health: 20,
    };
    this.sessions.set(ws, session);

    this.send(ws, { type: 'welcome', playerId: id, worldSeed: 0, spawn, tickRateHz: TICK_HZ });
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

    for (const [, session] of this.sessions) {
      const direction = new THREE.Vector3(session.intent.moveX, 0, session.intent.moveZ);
      if (direction.lengthSq() > 0) direction.normalize();
      direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), session.yaw);
      session.physics.updatePhysics(direction, session.intent.wantJump, session.intent.sprinting, dt);
    }

    const entities: EntitySnapshot[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      kind: 'player' as const,
      pos: { x: s.physics.state.position.x, y: s.physics.state.position.y, z: s.physics.state.position.z },
      yaw: s.yaw,
      health: s.health,
      maxHealth: 20,
      onFire: false,
      dying: false,
      name: s.name,
    }));

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

  private setBlock(x: number, y: number, z: number, id: BlockId): void {
    const key = `${x},${y},${z}`;
    this.edits.set(key, id);
    void this.state.storage.put(`edit:${key}`, id);
    this.broadcast({ type: 'blockChanged', x, y, z, blockId: id });
  }

  private isSolidAt(x: number, y: number, z: number): boolean {
    const edit = this.edits.get(`${x},${y},${z}`);
    if (edit !== undefined) return edit !== BlockId.AIR;
    // Placeholder world: a single flat ground plane. Real terrain (deterministic
    // from a seed, same as the client's terrain-noise.ts) is follow-up work -
    // see the class doc comment.
    return y <= 0;
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
}

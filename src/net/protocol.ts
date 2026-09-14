import type { BlockId } from '../block';
import type { InventorySlot } from '../inventory';
import type { MobKind } from '../mob-manager';
import type { FurnaceState } from '../block-data';

/**
 * Fase 4 of the multiplayer migration plan: the wire contract between a
 * client and a future world server (a Cloudflare Durable Object - see
 * Fase 5), fixed here as real TypeScript types before any transport exists.
 * Nothing in the game imports this yet - it's a design artifact that
 * compiles and can be typo-checked/refined now, so Fase 5/6 build against a
 * contract instead of inventing it ad hoc while also wiring up sockets.
 *
 * Ground rules baked into the shape below:
 * - The server is authoritative for everything except the exact input the
 *   player just pressed (movement/camera intent) - it owns world state,
 *   entities, inventory, and decides what actually happened.
 * - Every message is a plain, JSON-serializable object (a discriminated
 *   union on `type`) - simplest to debug; a binary encoding can replace the
 *   wire format later without touching any gameplay code, since nothing
 *   above this file would need to change.
 * - `EntitySnapshot` reuses the exact shape mob-manager.ts's `Mob.pos`
 *   already produces post-Fase-1 (a plain {x,y,z}, not a mesh transform) -
 *   the client/server split didn't need a new position representation
 *   because Fase 1 already built the right one.
 */

export const PROTOCOL_VERSION = 1;

export type Vec3 = { x: number; y: number; z: number };

/** Anything the client renders as a moving body in the world: a mob, or another player. */
export type EntityKind = MobKind | 'player';

export type EntitySnapshot = {
  /** Server-assigned, stable for the entity's whole lifetime in this world. */
  id: number;
  kind: EntityKind;
  pos: Vec3;
  yaw: number;
  health: number;
  maxHealth: number;
  onFire: boolean;
  /** Playing its death animation - client keeps rendering it (toppling) until entityRemoved. */
  dying: boolean;
  /** Only present for kind:'player' - display name for name tags/chat attribution. */
  name?: string;
};

// --- Client -> Server --------------------------------------------------

export type ClientMessage =
  | {
      type: 'join'; worldId: string; playerName: string; protocolVersion: number;
      /** The 64x64 skin PNG this client currently has selected (player-skin.ts),
       * as a data: URL - `null`/absent if using the built-in default. Sent once
       * at join, not kept in sync afterward (see world-do.ts's onJoin doc
       * comment): changing skin mid-session in another player's view is a
       * real follow-up, not something this first pass covers. */
      skin?: string | null;
    }
  /**
   * Movement/look intent for one client-side simulation step, not a
   * position - the server re-simulates this itself (same PlayerPhysics
   * class the client predicts with) rather than trusting a claimed x/y/z,
   * so a modified client can't just claim to be somewhere it isn't.
   * `seq` lets the client discard/replay its own prediction once the
   * matching `state.ackSeq` comes back (standard client-side prediction +
   * server reconciliation) - not implemented yet, but the field exists now
   * so Fase 6 doesn't need a protocol version bump to add it.
   */
  | {
      type: 'input';
      seq: number;
      moveX: number; // -1..1, local (pre-yaw-rotation) strafe axis - same convention as player.ts's `direction` before applyAxisAngle
      moveZ: number; // -1..1, local forward(-)/back(+) axis
      wantJump: boolean;
      sprinting: boolean;
      sneaking: boolean;
      yaw: number;
      pitch: number;
      dtMs: number; // this input's own client-side frame delta, so the server advances physics by the same amount the client predicted
    }
  | { type: 'breakBlock'; x: number; y: number; z: number }
  | { type: 'placeBlock'; x: number; y: number; z: number; blockId: BlockId; face: number }
  | { type: 'selectSlot'; index: number }
  | { type: 'useItem'; slotIndex: number }
  /** Q - drops the whole stack currently in the selected hotbar slot. No world item entity yet (see world-do.ts's dropItem handler doc comment) - the stack just leaves the inventory. */
  | { type: 'dropItem' }
  /**
   * Craft one of the recipes the server last told this client it can
   * afford (`craftableRecipes`) - `recipeIndex` is RECIPES' own array
   * index (src/crafting.ts), re-validated server-side on arrival rather
   * than trusted (see world-do.ts's handleCraft doc comment). Simplified
   * from singleplayer's drag-and-drop 2x2/3x3 grid: the player picks a
   * recipe from a list of what they can currently make instead of
   * physically arranging ingredients in a grid over the network - see
   * multiplayer-game.ts's craft menu doc comment for why.
   */
  | { type: 'craft'; recipeIndex: number }
  /** Backpack (E) slot click: move/merge whatever is in `from` into `to` - same-id stacks merge (up to maxStack, leftover stays in `from`), otherwise the two slots swap. Both are indices into the same 36-slot inventory (0..8 hotbar, 9..35 backpack) - there's no separate "held item cursor" state to track over the network, each click is a complete, self-contained move. */
  | { type: 'moveSlot'; from: number; to: number }
  /** Right-clicking a placed furnace block opens its GUI - the server starts including this position in the periodic `furnaceState` pushes to this session (see world-do.ts's Session.openFurnace) until furnaceClose. */
  | { type: 'furnaceOpen'; x: number; y: number; z: number }
  | { type: 'furnaceClose' }
  /** Moves the player's currently SELECTED hotbar slot's whole stack into that furnace's input or fuel slot (merging if it already holds the same item) - simplified from a real per-slot drag the same way the craft menu simplifies the crafting grid (see protocol.ts's `craft` doc comment). */
  | { type: 'furnaceInsert'; x: number; y: number; z: number; target: 'input' | 'fuel' }
  /** Collects the furnace's finished output stack into the player's inventory. */
  | { type: 'furnaceTakeOutput'; x: number; y: number; z: number }
  | { type: 'attack'; targetId: number }
  | { type: 'shootBow'; power: number; dir: Vec3 }
  | { type: 'chat'; text: string }
  | { type: 'ping'; clientTimeMs: number };

// --- Server -> Client --------------------------------------------------

export type ServerMessage =
  /** `dayTime`: the world's current position in the day/night cycle (seconds - see day-night-math.ts), so a joining client can seed its own local clock instead of always starting at noon. */
  | { type: 'welcome'; playerId: number; worldSeed: number; spawn: Vec3; tickRateHz: number; dayTime: number }
  /** Join refused - protocol mismatch, whitelist, world at capacity, etc. Connection closes after this. */
  | { type: 'rejected'; reason: string }
  /**
   * The main per-tick (or per-N-ticks) update: this client's own
   * authoritative state (for reconciling its local prediction) plus every
   * other entity currently worth sending it (mobs + other players in
   * range - "in range" is a server-side interest-management decision, not
   * modeled here).
   */
  | {
      type: 'state';
      tick: number;
      /** Last input `seq` this snapshot already reflects - anything the client sent after this still needs reconciling locally. */
      ackSeq: number;
      self: { pos: Vec3; velocity: Vec3; yaw: number; pitch: number; grounded: boolean; health: number };
      entities: EntitySnapshot[];
    }
  /** Sparse block edits for one chunk - same [localIndex, blockId] shape chunk-edits.ts already persists, just shipped instead of read from IndexedDB. */
  | { type: 'chunkData'; cx: number; cz: number; edits: [index: number, blockId: BlockId][] }
  | { type: 'blockChanged'; x: number; y: number; z: number; blockId: BlockId }
  | { type: 'inventoryUpdate'; slots: InventorySlot[]; selectedIndex: number }
  | { type: 'entityRemoved'; id: number; reason: 'death' | 'despawn' | 'disconnect' }
  /** Another player's skin - sent once when they join (and replayed for every already-connected player right after `welcome`, so a client catches up on everyone already in the world). `skin: null` means the built-in default. */
  | { type: 'playerSkin'; playerId: number; skin: string | null }
  /** Resyncs the client's local day/night clock to the server's authoritative one (day-night-math.ts) - sent whenever the integer skyDarken step changes (so a transition starts on every client at the same moment) and periodically besides, to correct any drift in a client that free-runs the clock locally between corrections (see multiplayer-game.ts). */
  | { type: 'dayTime'; elapsed: number }
  /** Every RECIPES (src/crafting.ts) index this player currently has ingredients for, sent whenever the inventory changes - drives the craft menu's list (see multiplayer-game.ts). `out` is included so the client can render the result icon without needing its own copy of RECIPES. */
  | { type: 'craftableRecipes'; recipes: { index: number; out: { id: number; count: number } }[] }
  /** Pushed periodically (every tick, while the session has this furnace open via furnaceOpen) so the GUI's cook/fuel gauges animate smoothly - see world-do.ts's Session.openFurnace. */
  | { type: 'furnaceState'; x: number; y: number; z: number; state: FurnaceState }
  | { type: 'chat'; from: string; text: string }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number };

/** Narrow an unknown decoded payload to a ClientMessage by its `type` tag - use on the server after `JSON.parse`ing a raw WebSocket frame. */
export function isClientMessageType(type: string): type is ClientMessage['type'] {
  return (
    [
      'join', 'input', 'breakBlock', 'placeBlock', 'selectSlot', 'useItem', 'dropItem', 'craft', 'moveSlot',
      'furnaceOpen', 'furnaceClose', 'furnaceInsert', 'furnaceTakeOutput',
      'attack', 'shootBow', 'chat', 'ping',
    ] as const
  ).includes(type as ClientMessage['type']);
}

/** Same idea for the client, decoding a frame from the server. */
export function isServerMessageType(type: string): type is ServerMessage['type'] {
  return (
    [
      'welcome', 'rejected', 'state', 'chunkData', 'blockChanged',
      'inventoryUpdate', 'entityRemoved', 'playerSkin', 'dayTime', 'craftableRecipes', 'furnaceState', 'chat', 'pong',
    ] as const
  ).includes(type as ServerMessage['type']);
}

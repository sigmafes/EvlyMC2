import * as THREE from 'three';
import { PlayerPhysics } from './game/player-physics';
import type { BlockCollider } from '../../src/chunk';
import type {
  ClientMessage, ServerMessage, EntitySnapshot, Vec3, CraftSlotRef,
} from '../../src/net/protocol';
import { PROTOCOL_VERSION, isClientMessageType } from '../../src/net/protocol';
import { BlockId, blockLightProperties, isSolidBlock, isOrientable } from '../../src/block';
import { ServerTerrain } from './terrain';
import { WATER_LEVEL } from '../../src/chunk';
import { ServerMobManager } from './mobs';
import { DAY_LENGTH, NIGHT_SKY_DARKEN, computeDayNightState, resolveCycleTime, cycleTimeFor, type TimePhase } from './game/day-night-math';
import { createEmptyInventory, createEmptySlot, describeSlot, addToInventory, removeFromSlot, removeItemsAnywhere, countInInventory, moveOrMergeSlot, moveOrMergeBetween, TOTAL_SLOTS } from './game/inventory';
import { getDrops } from '../../src/drops';
import { breakTime } from '../../src/block-hardness';
import { isBlock, maxStackOf, foodValue, ITEMS } from '../../src/item';
import { isTool, maxDurability } from '../../src/tools';
import { armorSlotFor, totalArmorValue, reduceDamageByArmor, armorHurtAmount, armorDurability } from '../../src/armor';
import { BLOCK_CATALOG } from '../../src/creative-palette';
import { LeavesManager } from '../../src/leaves-manager';
import type { MobKind } from './game/mob-manager';
import type { InventorySlot } from '../../src/inventory';
import { RECIPES, matchRecipe, type Recipe } from '../../src/crafting';
import { FurnaceManager } from '../../src/furnace';
import {
  emptyFurnace, emptyChest, facingTowardPlayer, defaultControlFlags, DEFAULT_HOLOGRAM_SHOW_DISTANCE,
  type FurnaceState, type ChestState, type BlockData, type ControlFlags,
  type MessageEntry, type MessageColor, type MessageConfig, type HologramConfig,
} from '../../src/block-data';
import { isStairs, isSlab } from '../../src/block-shapes';
import { ServerDroppedItems } from './game/dropped-items';
import { ServerArrows, powerToSpeed } from './game/arrow-projectiles';
import { ActiveRegion, chunkCoordOf } from './game/active-region';
import { createMobSpawning, type MobSpawning } from './game/mob-spawning';
import { WaterEngine, LavaEngine } from './game/water-engine';
import { FireEngine } from './game/fire-engine';
import type { FluidWorld } from './game/fluid-world';
import { SKELETON_SHOT_POWER } from './game/mob-ai';
import { PlayerAir } from '../../src/player-air';
import { ItemId } from '../../src/item';
import { verifyAuthToken } from '../../src/net/auth-token';
import type { MobRecord } from './mobs';

export interface Env {
  WORLD_DO: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
  /**
   * Shared HMAC secret, the same value the access worker signs play tokens
   * with (`wrangler secret put AUTH_SECRET` on both). Without it this server
   * cannot tell one player from another, so it refuses every join rather than
   * falling back to trusting whatever name it was handed.
   */
  AUTH_SECRET?: string;
}

const MOBS_KEY = 'mobs';
/** Seconds between routine mob roster writes - see WorldDO.mobsDirty for why this is deliberately slow. */
const MOB_SAVE_INTERVAL = 30;
const FURNACES_KEY = 'furnaces';
/** Seconds between routine furnace writes. A furnace's cook progress changes every tick, so it is never written on change - only on this cadence, plus whenever items go in or out. */
const FURNACE_SAVE_INTERVAL = 30;
/** Seconds between routine per-player writes while connected. Disconnecting always writes immediately, so this only bounds how much is lost if the DO is evicted mid-session. */
const PLAYER_SAVE_INTERVAL = 30;

/**
 * What survives a player leaving and coming back. Mirrors singleplayer's
 * PlayerSave (player-store.ts) minus the day/night clock, which is per-world
 * here and already persisted separately.
 */
type PlayerRecord = {
  slots: InventorySlot[];
  selectedIndex: number;
  /** [helmet, chestplate, leggings, boots] - absent on saves from before armor existed. */
  armor?: InventorySlot[];
  health: number;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
};

/**
 * Storage key for a player's save.
 *
 * IMPORTANT, and the reason this is a named function rather than an inline
 * template: identity here is nothing but the `playerName` the client typed in.
 * The world server has no authentication of its own - the login in
 * access-worker/ is a separate service this Worker never hears from - so
 * anyone who joins under your name inherits your inventory and position.
 *
 * That is acceptable for a world you share with people you know, and NOT
 * acceptable for a public one. Closing it needs the access worker to issue
 * something verifiable (a signed token) and `join` to carry it, which is a
 * real piece of work across two services rather than a tweak here.
 */
const playerKey = (name: string) => `player:${name.trim().toLowerCase()}`;

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
/** How many recent ticks the pacing average covers - 100 at 20Hz is the last 5 seconds, long enough to ride out one slow tick but short enough to react while you're watching. */
const TICK_SAMPLE_COUNT = 100;
const MAX_DT_S = 0.1; // same spiral-of-death cap main.ts uses on the client
const PLAYER_MAX_HEALTH = 20; // LCE/singleplayer's 10 hearts x2 - see player-health.ts
const PLAYER_MELEE_RANGE = 4; // matches interaction.ts's own melee reach
const PLAYER_MELEE_DAMAGE = 4; // a plain fixed "punch" - no tool/weapon damage tiers server-side yet
/** Matches interaction.ts's ATTACK_COOLDOWN - minimum gap between this player's own accepted melee hits, enforced here since the client-side cooldown alone is trivially bypassable. */
const PLAYER_ATTACK_COOLDOWN_MS = 300;
/** Matches main.ts's PLAYER_KNOCKBACK_SPEED/UP - the shove a hostile hit gives the player, applied via PlayerPhysics.applyKnockback (ported but never actually called until now). */
const PLAYER_KNOCKBACK_SPEED = 5;
const PLAYER_KNOCKBACK_UP = 4;
/** Matches player-health.ts's post-hit `invuln` window - how long hurtPlayer() ignores further non-environmental damage after a hit. */
const PLAYER_HURT_INVULN_MS = 300;

// Environmental damage, mirroring singleplayer's own main.ts loop so falling,
// drowning and burning cost the same in both modes.
const FALL_SAFE_DISTANCE = 3.5;  // blocks you can drop without a scratch
const LAVA_TICK_INTERVAL = 0.5;  // seconds between lava damage ticks
const LAVA_TICK_DAMAGE = 2;
const FIRE_TICK_INTERVAL = 0.5;
const FIRE_TICK_DAMAGE = 1;
const DROWN_DAMAGE = 2;
/** Seconds to finish a bite - LCE's 32 ticks, same as singleplayer's interaction.ts. */
const EAT_DURATION = 1.6;
/** A skeleton's arrow hits for a flat amount, independent of its shot speed - same value singleplayer's own spawn call passes. */
const SKELETON_ARROW_DAMAGE = 2;
/** Side of the square of chunks around the world spawn where players can't hurt each other. Odd so it centres on the spawn chunk. */
const SPAWN_PROTECTION_CHUNKS = 3;
/** After leaving the flames a player keeps burning for this many 1-damage ticks, one second apart - same pattern as a mob's onFire. */
const PLAYER_FIRE_AFTERBURN_TICKS = 8;
const PLAYER_FIRE_TICK_INTERVAL = 1;

/** Every Admin+-exclusive mp block (block.ts's own doc comments) - placing, breaking or configuring any of these needs isAdminOrOwner(). */
const ADMIN_BLOCK_IDS = new Set<BlockId>([BlockId.CONTROL_BLOCK, BlockId.TP_BLOCK, BlockId.MESSAGE_BLOCK, BlockId.HOLOGRAM_BLOCK]);
/** Max messages a MESSAGE_BLOCK can hold - anything past this in a messageBlockSet is silently dropped. */
const MAX_MESSAGE_BLOCK_ENTRIES = 5;
/** Every valid MessageColor, for validating a messageBlockSet/hologramBlockSet's claimed color rather than trusting it blindly. */
const MESSAGE_COLORS: MessageColor[] = ['white', 'red', 'green', 'blue', 'yellow', 'orange', 'cyan', 'pink', 'purple'];

/** Every mob /summon can spawn - mirrors mob-manager.ts's MobKind union, listed out because that type itself can't be iterated at runtime. */
const MOB_KINDS: MobKind[] = ['pig', 'cow', 'sheep', 'zombie', 'skeleton'];

/** Same list src/chat-commands.ts's /time validates against. */
const TIME_PHASES = ['day', 'night', 'sunset', 'sunrise'] as const;

/**
 * Four-tier rank hierarchy (replaces the old fixed ADMIN_NAMES/MOD_ADMIN_NAMES
 * allowlists): 'sigmafes' is the hardcoded owner override (this exact account
 * name, case-insensitive - never stored, never demotable via /rank), then
 * Admin/Mod/User are per-account ranks persisted to storage (see
 * this.playerRanks) and assigned with /rank. A brand new player who has
 * never been granted a rank is 'User' by default.
 *
 * Admin: moderation commands (mute/ban/unban/kick) AND the special commands
 * (give/time/seed/fly/clean/tp/rank Mod-or-User).
 * Mod: moderation commands only.
 * User: nothing.
 * sigmafes: every command everywhere, unconditionally.
 */
type PlayerRank = 'Admin' | 'Mod' | 'User';
const PLAYER_RANKS: PlayerRank[] = ['Admin', 'Mod', 'User'];
const OWNER_NAME = 'sigmafes';

/** Same normalisation as src/chat-commands.ts's /give, duplicated (not imported) because that file pulls in THREE/Chat/DOM-adjacent types this headless server doesn't have. */
function slugifyItemName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

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
  intent: { moveX: number; moveZ: number; wantJump: boolean; sprinting: boolean; sneaking: boolean; restricted: boolean };
  lastSeq: number;
  health: number;
  /** The skin PNG (data: URL) this player joined with, or null for the built-in default - see onJoin. */
  skin: string | null;
  /** Arm-width setting (slim/classic) this player joined with - see onJoin and protocol.ts's `join`/`playerSkin` doc comments. */
  slim: boolean;
  /** cape.ts CapeOption id (or null for none) this player joined with - see onJoin and protocol.ts's `join`/`playerSkin` doc comments. */
  cape: string | null;
  /** Server-authoritative inventory - see game/inventory.ts's doc comment for why it's a hand-rolled minimal helper set instead of importing src/inventory.ts's own (DOM-heavy) Inventory class. */
  inventory: InventorySlot[];
  selectedSlot: number;
  /** [helmet, chestplate, leggings, boots] - LCE's own ArmorItem slot order. */
  armor: InventorySlot[];
  /** Fractional remainder carried between hits - see armor.ts's reduceDamageByArmor doc comment. */
  armorSpill: number;
  /** Position of the furnace GUI this session currently has open, or null - drives which furnace's state gets pushed to it every tick (see the class's tick() and sendFurnaceState()). */
  openFurnace: { x: number; y: number; z: number } | null;
  /** Position of the chest GUI this session currently has open, or null - unlike openFurnace this doesn't need a per-tick push (a chest has no cook/burn gauge to animate), just a resend whenever ITS OWN OR ANOTHER VIEWER'S mutation changes it - see flushIfChest(). */
  openChest: { x: number; y: number; z: number } | null;
  /** Breath, run by src/player-air.ts unmodified (pure LCE tick math, no DOM) - drains while the head is submerged and deals drowning damage when it runs out. */
  air: PlayerAir;
  /** Seconds of contact accumulated toward the next lava/fire damage tick. Separate counters because lava and fire hit for different amounts, exactly as in singleplayer's own loop. */
  lavaTimer: number;
  fireTimer: number;
  /** After-burn: how many 1-damage ticks are still owed after leaving the flames, and the timer driving them. */
  fireTicksLeft: number;
  fireTickTimer: number;
  /** Currently burning - goes out on the wire in this player's EntitySnapshot so everyone else sees the flames. */
  onFire: boolean;
  /** Dead and waiting on the death screen: frozen at 0 health, no physics, no input, and no longer a target for anything, until they send `respawn`. */
  dead: boolean;
  /** The crafting grid this player currently has open, or null. `side` is 2 (carried) or 3 (standing at a table); `inputs` is side*side cells that live here, NOT in the inventory, until the grid is closed. */
  craft: { side: 2 | 3; inputs: InventorySlot[] } | null;
  /**
   * Cursor-follows-mouse inventory item, server-held equivalent of
   * singleplayer's Inventory class's own `heldItem`/`heldFrom` fields (see
   * protocol.ts's invPickUp/invPlace/invCancel doc comment). `heldFrom` is
   * where it came from, so closing the panel or a right-click on empty space
   * (invCancel) can put it back / merge it there instead of destroying it.
   */
  heldItem: InventorySlot | null;
  heldFrom: CraftSlotRef | null;
  /** Mid-bite: which slot is being eaten, what was in it, and how long it's been going. Null when not eating. */
  eating: { slotIndex: number; itemId: number; elapsed: number } | null;
  /**
   * The dig in progress, or null. `itemId` is captured at `breakStart` and
   * never re-read - switching hotbar slots mid-dig doesn't retroactively
   * speed up or slow down it, matching singleplayer's own interaction.ts
   * (see protocol.ts's breakStart doc comment). Nothing ever needs to clear
   * this on its own: a `breakBlock` that doesn't match consumes and discards
   * it, and a new `breakStart` just overwrites it.
   */
  mining: { x: number; y: number; z: number; itemId: number | null; startedAtMs: number } | null;
  /** This player's own 16-slot animal/hostile-surface/hostile-cave spawner (game/mob-spawning.ts, Fase 9) - independent ids/spawn-rolls/cooldowns per player, all writing into the one shared ServerMobManager roster. Created on join, discarded on disconnect. */
  mobSpawning: MobSpawning;
  /** `Date.now()` of this session's last accepted melee attack - server-side rate limit for attackMob/attackPlayer, since the client's own attackCooldown (interaction.ts) is trivially bypassable by a modified client sending 'attack' messages directly. */
  lastAttackAtMs: number;
  /** `Date.now()` until which hurtPlayer() ignores non-environmental damage - the server-side mirror of player-health.ts's `invuln` i-frames, which singleplayer had but this server never enforced at all. */
  invulnUntilMs: number;
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
 * - Mobs (ServerMobManager/mobs.ts) running mob-ai.ts/mob-physics.ts
 *   unmodified, spawned by each connected player's OWN 16-slot spawner
 *   (game/mob-spawning.ts, Fase 9) - independent spawn rolls/cooldowns per
 *   player, all landing in the one shared roster everyone sees and can fight.
 * - Combat: melee against mobs (attackMob) and against other players
 *   (attackPlayer, gated by spawn protection), hostile mobs hurting the
 *   nearest player, and real arrows with travel time for both the player's
 *   bow and a skeleton's shot. Death holds the player at 0 health until they
 *   ask to respawn, so the client has something to put a death screen on.
 * - Chat, broadcast to everyone.
 * - Inventory/crafting/furnace, all server-held and authoritative.
 * - Dropped items as real ground entities (game/dropped-items.ts): breaking a
 *   block or throwing a stack with Q spawns one that falls, collides and is
 *   vacuumed up by whoever walks over it.
 * - Mob death: a topple window, then loot rolled from mob-drops.ts. The mob
 *   roster is persisted to DO storage (see mobsDirty).
 * - Environmental damage (applyEnvironmentDamage): falling, drowning
 *   (src/player-air.ts, imported unmodified) and lava/fire with after-burn.
 * - A bounded simulation region (game/active-region.ts): only chunks within
 *   a fixed radius of a connected player are ticked at all. Everything else
 *   freezes in place rather than running unwatched - the main lever on this
 *   DO's CPU bill. Mob AI already respects it; water and fire will too.
 *
 * - Dynamic water, lava and fire (game/water-engine.ts, game/fire-engine.ts),
 *   simulated in full but only inside the active region. Every cell they
 *   change ships as an ordinary block edit, so the client needs no notion of
 *   a fluid simulation at all.
 *
 * - A real 2x2/3x3 crafting grid, eating (with the same 1.6s bite
 *   singleplayer makes you spend), and cross-session persistence of
 *   inventory, position and furnaces.
 *
 * Note on persistence: a player's save is keyed by the NAME they joined with,
 * because that is the only identity this Worker has - see playerKey().
 */
export class WorldDO implements DurableObject {
  private readonly sessions = new Map<WebSocket, Session>();
  /** Sockets whose join is mid-verification, so a flood of `join` messages can't create several sessions on one connection. */
  private readonly joining = new Set<WebSocket>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  /** Tick-pacing samples - see recordTickInterval() for why this measures the gap between ticks rather than the work inside one. */
  private lastTickAtMs: number | null = null;
  private readonly tickIntervals = new Array<number>(TICK_SAMPLE_COUNT).fill(0);
  private tickIntervalIndex = 0;
  private tickSamplesFilled = 0;
  /** Sparse block edits, "x,y,z" -> BlockId (BlockId.AIR for a broken block). Persisted to DO storage under the same key. */
  private readonly edits = new Map<string, BlockId>();
  private editsLoaded = false;
  /**
   * Orientation (facing/half/axis) for a placed block that needs it - the
   * server-side counterpart of singleplayer's World/BlockDataStore, minus
   * the furnace/lit fields (those already have their own dedicated
   * `furnaceState`/FurnaceManager plumbing). Persisted under the
   * `blockdata:` prefix, loaded alongside `edits` in fetch(). A cell is
   * only ever present here while the block currently occupying it actually
   * needs orientation - overwritten or removed like any other edit, see
   * setBlock()'s handling below.
   */
  private readonly blockData = new Map<string, BlockData>();
  /**
   * Moderation state - lowercased names, persisted to DO storage
   * (`ban:<name>`/`mute:<name>`) alongside edits, loaded in fetch(). A ban
   * rejects the join outright (see onJoin); a mute silently drops that
   * player's chat messages before they're broadcast. The value is the
   * expiry as an epoch-ms timestamp, or `Infinity` for a permanent ban/mute
   * (no /unmute exists yet - it wasn't asked for, only /unban - so a timed
   * mute expiring on its own or a permanent one are the only ways a mute
   * ever lifts). Storage.put can serialise Infinity directly (structured
   * clone, not JSON), so no separate "permanent" sentinel is needed.
   */
  private readonly bannedNames = new Map<string, number>();
  private readonly mutedNames = new Map<string, number>();
  /** Per-account rank, lowercased names, persisted under `rank:<name>` - see PlayerRank's own doc comment. Absent means the default 'User', so a brand new account needs no entry written at all. */
  private readonly playerRanks = new Map<string, PlayerRank>();
  /**
   * Every active CONTROL_BLOCK zone (two placed control blocks sharing the
   * same controlId, see BlockData.controlId's own doc comment) - a plain
   * rectangular XZ bounding box between the pair, spanning every Y (a
   * vertical column, not just the blocks' own layer), so a lobby built
   * upward inside the marked footprint is protected floor to sky the same
   * way a claimed area in most survival servers is. Rebuilt from scratch
   * (rebuildControlZones) whenever a control block is placed, broken, or
   * (re)configured - cheap enough (there are only ever a handful of control
   * blocks in a world) to not need incremental updates.
   */
  private controlZones: (ControlFlags & { minX: number; maxX: number; minZ: number; maxZ: number })[] = [];
  /** Per-block runtime countdown/cycle-position for every configured MESSAGE_BLOCK, keyed by `${x},${y},${z}` - not persisted (a restart just starts each one's cycle over from its first message), ticked in tick() and pruned in setBlock() when the block itself goes away. */
  private readonly messageBlockTimers = new Map<string, { elapsed: number; index: number }>();
  /** Real terrain (same deterministic Chunk/TerrainNoise generator the client uses) - see terrain.ts. Seeded once, from the first request's worldId. */
  private terrain: ServerTerrain | null = null;
  private worldSeed = 0;
  private readonly mobs = new ServerMobManager();
  /** Oak leaf decay - LeavesManager is pure (only a getBlock callback, no THREE/DOM), so it's imported straight from src/ same as breakTime/getDrops, no headless fork needed. */
  private readonly leaves = new LeavesManager();
  /**
   * LeavesManager.update() walks its ENTIRE watched set and, for each leaf,
   * runs a 9x9x9 flood fill (connectedToLog()) to check it's still attached
   * to a log - real work, not a cheap poll. Running that at the tick's full
   * 20Hz (as a first pass did) meant a freshly-chopped forest (onLogRemoved
   * can add well over a thousand candidate cells per log) re-ran that flood
   * fill for every one of them 20 times a SECOND, a genuine CPU spike -
   * exactly the "lag pico + bloques rompiéndose solos" symptom reported,
   * and severe enough to risk the Durable Object being killed mid-tick
   * before its fire-and-forget storage.put() for an already-broadcast
   * decay had actually persisted (a decayed leaf silently reappearing the
   * next session, since nothing durable ever recorded it left). Throttled
   * to once a second instead - decay's own chance-per-second math
   * (DECAY_RATE_PER_SECOND * delta) is exactly as accurate fed 1.0 once a
   * second as 0.05 twenty times, so this changes nothing about how fast
   * a canopy clears, only how often the expensive check runs.
   */
  private leavesTickAccum = 0;
  /**
   * Items lying on the ground (game/dropped-items.ts - a headless fork of
   * singleplayer's DroppedItems, same physics constants). Not persisted to DO
   * storage yet: an item that's been on the ground longer than its 60s despawn
   * wouldn't survive anyway, and player-facing persistence is Fase 12's job.
   */
  private readonly droppedItems = new ServerDroppedItems();
  /** Arrows in flight or stuck in walls (game/arrow-projectiles.ts). Not persisted: every one either lands, is recovered, or despawns within a minute. */
  private readonly arrows = new ServerArrows();
  /** Which chunks are worth simulating this tick - see game/active-region.ts. */
  private readonly activeRegion = new ActiveRegion();
  /**
   * The world as the fluid/fire engines see it. Their `setBlock` goes through
   * this.setBlock(), so every cell a flow or a flame changes is persisted and
   * broadcast as an ordinary block edit - which is why none of this needed a
   * protocol message of its own. `isInsideWorld` is always true: the server's
   * terrain is generated from noise and has no horizontal bounds.
   */
  private readonly fluidWorld: FluidWorld = {
    getBlock: (x, y, z) => this.getBlockAt(x, y, z),
    // silent: true - every call through here is the water/lava/fire engine's
    // own simulation ticking (spreading, retracting, burning out), never a
    // direct player action, same reasoning as leaf decay's silent removals
    // (see setBlock's own doc comment). Without this, a source cut off mid-
    // pond made every one of its now-retracting flow cells play the "place
    // water" sound (block-sounds.ts's WATER dig entry is literally named
    // 'water_place') as they turned back to air, one after another.
    setBlock: (x, y, z, id) => this.setBlock(x, y, z, id, true),
    isInsideWorld: () => true,
  };
  private readonly water = new WaterEngine(this.fluidWorld);
  private readonly lava = new LavaEngine(this.fluidWorld);
  private readonly fire = new FireEngine(this.fluidWorld);
  /**
   * Furnace smelting state, keyed "x,y,z" - separate from `edits` (which only
   * tracks the BlockId itself) since a furnace's input/fuel/output/cook
   * progress is per-instance state a plain block id can't hold. In-memory
   * only for now (unlike edits, not persisted to DO storage) - a furnace
   * mid-smelt loses its progress if this DO instance is evicted for
   * inactivity. Real persistence would mirror the edits map's storage.put
   * pattern; skipped for this first pass.
   */
  private readonly furnaces = new Map<string, FurnaceState>();
  /** Same FurnaceManager class singleplayer's furnace.ts runs (pure logic, no DOM) - see this.tick()'s call to it. */
  private readonly furnaceManager = new FurnaceManager({
    eachFurnace: (cb) => {
      for (const [key, s] of this.furnaces) {
        const [x, y, z] = key.split(',').map(Number);
        cb(x, y, z, s);
      }
    },
    setFurnaceState: (x, y, z, s) => {
      const key = `${x},${y},${z}`;
      if (s) this.furnaces.set(key, s); else this.furnaces.delete(key);
    },
    // Merges into the same `blockData` map/persistence/broadcast a placed
    // stair/slab/etc uses (Fase 5) - a furnace's `lit` flag is real
    // BlockData now, not a purely-cosmetic value with nowhere to go.
    setBlockData: (x, y, z, patch) => {
      const key = `${x},${y},${z}`;
      const merged: BlockData = { ...this.blockData.get(key), ...patch };
      this.blockData.set(key, merged);
      void this.state.storage.put(`blockdata:${key}`, merged);
      // silent: true - a furnace flipping its flame on/off isn't a player
      // action and shouldn't replay a place/dig sound, same reasoning as
      // every other non-player-initiated setBlock() broadcast in this file.
      this.broadcast({ type: 'blockChanged', x, y, z, blockId: this.getBlockAt(x, y, z), silent: true, data: merged });
    },
  });
  private mobsSpawned = false;
  /**
   * Mob persistence bookkeeping. Positions change every tick, so writing them
   * through on every change would mean 20 storage writes a second forever -
   * the single most expensive thing this DO could do for the least benefit.
   * Instead the whole roster is written on a slow cadence (MOB_SAVE_INTERVAL)
   * and whenever something structural happens (a death, a spawn): the worst
   * case after an eviction is that mobs reappear up to that many seconds
   * back along their wander path, which nobody can tell apart from them
   * having simply walked there.
   */
  private mobsDirty = false;
  private mobSaveAccum = 0;
  /** Same slow-cadence pattern as the mobs, for furnaces and for connected players - see MOB_SAVE_INTERVAL's note on why writing on every change would be the wrong trade. */
  private furnacesDirty = false;
  private furnaceSaveAccum = 0;
  private playerSaveAccum = 0;
  private furnacesLoaded = false;
  /** Every player save in this world, keyed by playerKey() - kept in memory so onJoin can stay synchronous. */
  private readonly playerSaves = new Map<string, PlayerRecord>();
  private playersLoaded = false;
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
  /** Last skyDarken this.tick() computed - kept as a field purely so isNight() (mob-spawning's day/night gate) doesn't need to recompute the whole cycle a second time. */
  private lastSkyDarken = 0;
  private lastBroadcastSkyDarken = -1;
  private lastDayTimeBroadcast = 0;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.editsLoaded) {
      const stored = await this.state.storage.list<BlockId>({ prefix: 'edit:' });
      for (const [key, value] of stored) this.edits.set(key.slice('edit:'.length), value);
      const storedData = await this.state.storage.list<BlockData>({ prefix: 'blockdata:' });
      for (const [key, value] of storedData) this.blockData.set(key.slice('blockdata:'.length), value);
      // Pre-existing entries from before timed bans/mutes existed stored a
      // plain `true`, not an expiry - treated as permanent (Infinity) here,
      // matching what "listed at all" used to mean.
      const storedBans = await this.state.storage.list<number | true>({ prefix: 'ban:' });
      for (const [key, expiry] of storedBans) this.bannedNames.set(key.slice('ban:'.length), typeof expiry === 'number' ? expiry : Infinity);
      const storedMutes = await this.state.storage.list<number | true>({ prefix: 'mute:' });
      for (const [key, expiry] of storedMutes) this.mutedNames.set(key.slice('mute:'.length), typeof expiry === 'number' ? expiry : Infinity);
      const storedRanks = await this.state.storage.list<PlayerRank>({ prefix: 'rank:' });
      for (const [key, rank] of storedRanks) this.playerRanks.set(key.slice('rank:'.length), rank);
      this.editsLoaded = true;
      // Adopt any FIRE block that outlived the engine that lit it. Engine
      // state is in-memory, so a DO that gets evicted mid-blaze wakes up with
      // the burning blocks still persisted but nothing tracking them - and
      // only tracked cells ever age out, so without this they would burn for
      // the rest of the world's life.
      for (const [key, value] of this.edits) {
        if (value !== BlockId.FIRE) continue;
        const [x, y, z] = key.split(',').map(Number);
        this.fire.adopt(x, y, z);
      }
      this.rebuildControlZones();
    }
    if (!this.terrain) {
      // index.ts forwards the original request unchanged (see its comment) -
      // re-parse the same /world/:id path here to derive a stable per-world
      // seed, so re-visiting the same worldId always regenerates the same
      // terrain (nothing about the terrain itself is persisted - only edits are).
      // Either route carries the same world id, and /stats can be the first
      // request this instance ever sees - deriving the seed from only /world
      // would leave a stats-first wake-up generating an entirely different
      // world than the one players then join.
      const match = new URL(request.url).pathname.match(/^\/(?:world|stats)\/([A-Za-z0-9_-]{1,64})$/);
      this.worldSeed = hashSeed(match?.[1] ?? 'default');
      this.terrain = new ServerTerrain(this.worldSeed);
    }
    if (!this.playersLoaded) {
      // Preloaded here rather than fetched inside onJoin, which is synchronous:
      // making it async would leave a window where the client's first `input`
      // messages arrive before the session exists and get dropped. A world
      // has a handful of players, so this is a small read.
      const stored = await this.state.storage.list<PlayerRecord>({ prefix: 'player:' });
      for (const [key, value] of stored) this.playerSaves.set(key, value);
      this.playersLoaded = true;
    }
    if (!this.furnacesLoaded) {
      const saved = await this.state.storage.get<[string, FurnaceState][]>(FURNACES_KEY);
      for (const [key, state] of saved ?? []) this.furnaces.set(key, state);
      this.furnacesLoaded = true;
    }
    if (!this.mobsSpawned) {
      // Restore whatever was alive when this DO was last evicted. A world
      // that has genuinely never been visited starts with none at all now -
      // there's no fixed initial batch any more (Fase 9): the moment the
      // first player's own per-player spawner runs its first update(), every
      // one of its 16 slots is empty with a zero cooldown, so it fills up
      // from nothing within the first few ticks anyway, same cold-start
      // singleplayer itself has on a fresh world.
      const saved = await this.state.storage.get<MobRecord[]>(MOBS_KEY);
      if (saved && saved.length > 0) this.mobs.restore(saved);
      this.mobsSpawned = true;
    }

    // Load report, for working out how many players this world can actually
    // hold (see recordTickInterval). Plain GET, no WebSocket upgrade, so it
    // has to be answered before the upgrade check below.
    //
    // Deliberately unauthenticated for now - it exposes only counts, nothing
    // about who is playing. Worth revisiting before a public deploy though:
    // requesting it WAKES the Durable Object, so anyone who knows a world id
    // could keep one billable just by polling this.
    if (new URL(request.url).pathname.startsWith('/stats/')) {
      // CORS wide open (not gated by ALLOWED_ORIGINS like the WebSocket
      // upgrade below) - this is the same "deliberately unauthenticated,
      // exposes only counts" endpoint the comment above already covers, and
      // main-menu.ts's own server list (mp-servers.ts's fetchServerStatus)
      // calls it directly from the browser as a plain fetch(), which a
      // missing Access-Control-Allow-Origin would otherwise just silently
      // block from ever reading the response.
      return new Response(JSON.stringify(this.stats(), null, 2), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
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
      void this.onJoin(ws, msg);
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
          restricted: msg.restricted,
        };
        session.physics.setSneaking(msg.sneaking);
        break;
      case 'breakStart':
        this.handleBreakStart(session, msg.x, msg.y, msg.z);
        break;
      case 'breakBlock':
        this.handleBreakBlock(session, msg.x, msg.y, msg.z);
        break;
      case 'breakCancel':
        // Purely cosmetic, same trust level as `swing` - a bystander's break
        // overlay clears a little early or late at worst, it can't affect
        // real block state (only breakBlock, re-validated server-side
        // against session.mining, actually breaks anything).
        this.broadcast({ type: 'entityBreakCancel', id: session.id }, ws);
        break;
      case 'placeBlock':
        this.handlePlaceBlock(session, msg.x, msg.y, msg.z, msg.normal, msg.clickY, msg.yaw);
        break;
      case 'selectSlot':
        if (msg.index >= 0 && msg.index < session.inventory.length) {
          session.selectedSlot = msg.index;
          this.sendInventory(session);
        }
        break;
      case 'dropItem':
        this.handleDropItem(session, msg.dir, msg.all);
        break;
      case 'craft':
        this.handleCraft(session, msg.recipeIndex);
        break;
      case 'craftOpen':
        this.openCraftGrid(session, msg.table);
        break;
      case 'craftClose':
        this.closeCraftGrid(session);
        break;
      case 'craftMove':
        this.handleCraftMove(session, msg.from, msg.to);
        break;
      case 'craftTakeOutput':
        this.handleCraftTakeOutput(session);
        break;
      case 'invPickUp':
        this.handleInvPickUp(session, msg.from, msg.half);
        break;
      case 'invPlace':
        this.handleInvPlace(session, msg.to, msg.one);
        break;
      case 'invCancel':
        this.handleInvCancel(session);
        break;
      case 'moveSlot':
        if (
          msg.from >= 0 && msg.from < TOTAL_SLOTS &&
          msg.to >= 0 && msg.to < TOTAL_SLOTS
        ) {
          moveOrMergeSlot(session.inventory, msg.from, msg.to);
          this.sendInventory(session);
        }
        break;
      case 'furnaceOpen':
        // Anyone can peek at any furnace's contents - same trust level as
        // breakBlock/placeBlock already have (no ownership/claims system).
        if (this.getBlockAt(msg.x, msg.y, msg.z) !== BlockId.FURNACE) return;
        session.openFurnace = { x: msg.x, y: msg.y, z: msg.z };
        this.sendFurnaceState(session);
        break;
      case 'furnaceClose':
        // Same reasoning as closeCraftGrid's own cancel: whatever's on the
        // cursor has to go back to its real slot (or the furnace's) before
        // the furnace stops being addressable, not just rely on the client
        // having already sent invCancel itself.
        this.handleInvCancel(session);
        session.openFurnace = null;
        break;
      case 'furnaceInsert':
        this.handleFurnaceInsert(session, msg.x, msg.y, msg.z, msg.target);
        break;
      case 'furnaceTakeOutput':
        this.handleFurnaceTakeOutput(session, msg.x, msg.y, msg.z);
        break;
      case 'chestOpen':
        // Same trust level as furnaceOpen - anyone can peek at any chest.
        if (this.getBlockAt(msg.x, msg.y, msg.z) !== BlockId.CHEST) return;
        session.openChest = { x: msg.x, y: msg.y, z: msg.z };
        this.sendChestState(session);
        // Cosmetic-only lid animation for everyone else nearby, same trust
        // level as `swing`/`breakStart` - it can't affect real game state,
        // only local animation on other clients (see ChestRenderer).
        this.broadcast({ type: 'entityChestOpen', x: msg.x, y: msg.y, z: msg.z }, session.ws);
        break;
      case 'chestClose': {
        // Same reasoning as furnaceClose: whatever's on the cursor has to go
        // back before the chest stops being addressable.
        this.handleInvCancel(session);
        const wasOpen = session.openChest;
        session.openChest = null;
        if (wasOpen) this.broadcast({ type: 'entityChestClose', x: wasOpen.x, y: wasOpen.y, z: wasOpen.z }, session.ws);
        break;
      }
      case 'controlBlockOpen':
        this.handleControlBlockOpen(session, msg.x, msg.y, msg.z);
        break;
      case 'controlBlockSet':
        this.handleControlBlockSet(session, msg.x, msg.y, msg.z, msg.controlId, msg.flags);
        break;
      case 'tpBlockOpen':
        this.handleTpBlockOpen(session, msg.x, msg.y, msg.z);
        break;
      case 'tpBlockSet':
        this.handleTpBlockSet(session, msg.x, msg.y, msg.z, msg.target);
        break;
      case 'messageBlockOpen':
        this.handleMessageBlockOpen(session, msg.x, msg.y, msg.z);
        break;
      case 'messageBlockSet':
        this.handleMessageBlockSet(session, msg.x, msg.y, msg.z, msg.messages, msg.intervalSeconds, msg.random);
        break;
      case 'hologramBlockOpen':
        this.handleHologramBlockOpen(session, msg.x, msg.y, msg.z);
        break;
      case 'hologramBlockSet':
        this.handleHologramBlockSet(session, msg.x, msg.y, msg.z, msg.text, msg.color, msg.height, msg.showDistance);
        break;
      case 'chat':
        // A command is parsed and answered by the SERVER, never the client -
        // same trust boundary as breakBlock/placeBlock. Anyone connected can
        // use one (see Fase 6 of PLAN-MULTIPLAYER-BUGFIXES.md); there's no
        // creative mode or permission system in this project to gate it with.
        if (msg.text.startsWith('/')) this.handleChatCommand(session, msg.text.slice(1));
        // A muted player's own message is silently dropped - not even
        // echoed back to them - same as a real chat mute rather than a
        // visible "you can't talk" wall that just confirms the mute worked.
        else if (!this.isMuted(session.name)) this.broadcast({ type: 'chat', from: session.name, text: msg.text });
        break;
      case 'attack':
        // Mob ids are always negative (ServerMobManager), session ids always
        // positive (this.nextId starts at 1), so the sign picks the branch.
        if (session.dead) break;
        if (msg.targetId < 0) this.attackMob(session, msg.targetId);
        else this.attackPlayer(session, msg.targetId);
        break;
      case 'swing':
        // Purely cosmetic - see protocol.ts's doc comment. Not gated on
        // session.dead: a client-side swing already played locally before
        // this arrives regardless, so dropping it here would just desync
        // everyone else's view of an animation that already happened.
        this.broadcast({ type: 'entitySwing', id: session.id }, ws);
        break;
      case 'respawn':
        this.handleRespawn(session);
        break;
      case 'useItem':
        this.handleUseItem(session, msg.slotIndex);
        break;
      case 'quickEquipArmor':
        this.handleQuickEquipArmor(session);
        break;
      case 'shootBow':
        this.handleShootBow(session, msg.power, msg.dir);
        break;
      case 'ping':
        this.send(ws, { type: 'pong', clientTimeMs: msg.clientTimeMs, serverTimeMs: Date.now() });
        break;
      default:
        break;
    }
  }

  /**
   * Records that a dig started, with whatever's SELECTED right now captured
   * fixed for the whole thing (see Session.mining's doc comment). No-op on
   * air or on a block breakTime() says is unbreakable (Infinity) - there's
   * nothing to time, and it keeps a stray breakStart from ever validating a
   * breakBlock against Infinity later (mining.startedAtMs would just sit
   * there unconsumed instead, harmless either way, but this is clearer).
   */
  private handleBreakStart(session: Session, x: number, y: number, z: number): void {
    const id = this.getBlockAt(x, y, z);
    if (id === BlockId.AIR) return;
    // Water is never a mineable target (src/raycast.ts's own DDA walk skips
    // it - a normal client's crosshair can't even land on it), and it has 0
    // hardness (block-hardness.ts), so without this a modified client could
    // still "mine" it instantly. Lava isn't excluded here either way - same
    // as singleplayer, whose raycast only skips water, not lava.
    if (id === BlockId.WATER) return;
    const itemId = session.inventory[session.selectedSlot].id;
    const { time } = breakTime(id, itemId);
    if (!Number.isFinite(time)) return;
    session.mining = { x, y, z, itemId, startedAtMs: Date.now() };
    // Bystanders only ever saw the OWN player's crack overlay/chip sound/
    // mine sound (local-only in multiplayer-game.ts's updateMining()) -
    // this is what lets every other client run the same overlay animation
    // for someone else's dig instead of the block just silently vanishing
    // once it's actually broken, with nothing shown while it was in
    // progress.
    this.broadcast({ type: 'entityBreakStart', id: session.id, x, y, z, totalMs: Math.round(time * 1000) }, session.ws);
  }

  /**
   * Applies a dig the client says finished. Re-derives the real duration
   * from breakTime() using the item captured at breakStart - never a
   * duration or a canHarvest flag the client claims - and checks enough
   * real time has actually elapsed for THIS position before allowing it.
   * `mining` is consumed (set null) unconditionally so a duplicate/stale
   * breakBlock can't re-validate against the same recorded start twice.
   *
   * The 0.8 multiplier is slack for latency and frame jitter between the
   * client's local timer finishing and this message arriving - strict
   * enough that a modified client sending breakBlock right after breakStart
   * still gets rejected, loose enough that no legitimate dig ever is.
   */
  /**
   * Spends `amount` uses on the player's currently SELECTED tool (a no-op
   * for anything that isn't a tool - maxDurability() returns 0 for those,
   * same guard singleplayer's Inventory.damageSelected() has), breaking it
   * (emptying the slot) once its damage reaches maxDurability(). Mirrors
   * that same method exactly, just reading/writing session.inventory
   * instead of a client-local array, and sending `toolBroke` instead of
   * playing the sound directly (this is server-side, no SoundManager here).
   */
  private damageTool(session: Session, amount: number): void {
    const slot = session.inventory[session.selectedSlot];
    const uses = maxDurability(slot.id);
    if (uses <= 0) return;
    const damage = (slot.damage ?? 0) + amount;
    if (damage >= uses) {
      session.inventory[session.selectedSlot] = createEmptySlot();
      this.send(session.ws, { type: 'toolBroke' });
    } else {
      slot.damage = damage;
    }
    this.sendInventory(session);
  }

  /** Same 6-neighbor check as src/world.ts's own private hasWaterNeighbor(). */
  private hasWaterNeighbor(x: number, y: number, z: number): boolean {
    return (
      this.getBlockAt(x + 1, y, z) === BlockId.WATER ||
      this.getBlockAt(x - 1, y, z) === BlockId.WATER ||
      this.getBlockAt(x, y + 1, z) === BlockId.WATER ||
      this.getBlockAt(x, y - 1, z) === BlockId.WATER ||
      this.getBlockAt(x, y, z + 1) === BlockId.WATER ||
      this.getBlockAt(x, y, z - 1) === BlockId.WATER
    );
  }

  private handleBreakBlock(session: Session, x: number, y: number, z: number): void {
    const brokenId = this.getBlockAt(x, y, z);
    const mining = session.mining;
    session.mining = null;
    if (brokenId === BlockId.AIR) return;
    if (!mining || mining.x !== x || mining.y !== y || mining.z !== z) return;
    const isAdmin = this.isAdminOrOwner(session.name);
    // Grief protection: a zone with grief off can't be broken into by
    // anyone below Admin, full stop - checked before the admin-block
    // bypass below too, so a non-admin can't sneak past it that way either.
    if (!isAdmin && this.controlZoneAt(x, z)?.grief === false) return;
    // Admin blocks are hardness 0 (client-side canMineClient() treats
    // anything else as truly unbreakable and never even starts a dig - see
    // block-hardness.ts's own comment on this) so they instamine for
    // anyone who reaches here, but only an Admin+ actually gets to remove
    // one; anyone else's breakBlock for one of these silently no-ops.
    if (ADMIN_BLOCK_IDS.has(brokenId)) {
      if (!isAdmin) return;
      this.setBlockFromPlayer(x, y, z, BlockId.AIR);
      return;
    }

    const { time, canHarvest } = breakTime(brokenId, mining.itemId);
    const elapsedSeconds = (Date.now() - mining.startedAtMs) / 1000;
    if (elapsedSeconds < time * 0.8) return;

    // Surgical fix ported from src/world.ts's World.remove() - procedurally-
    // generated ocean/river water is never registered as a source with
    // WaterEngine (only player-placed/reloaded-from-edits water is), so the
    // sim has no idea a hole just opened up next to it. Rather than
    // simulating the whole ocean server-side, immediately fill this one
    // cell with water (as a real, now-tracked source) whenever it borders
    // existing water, instead of leaving it AIR forever.
    // Spill the chest's contents before the block (and its data) are gone -
    // same reasoning as singleplayer's interaction.ts finishMining(), just
    // ported here since this server never runs that client code at all.
    if (brokenId === BlockId.CHEST) {
      const c = this.blockData.get(`${x},${y},${z}`)?.chest;
      for (const slot of c?.items ?? []) {
        if (slot?.id != null && slot.count > 0) this.droppedItems.spawn(slot.id, slot.count, new THREE.Vector3(x, y, z));
      }
    }

    const newId = brokenId !== BlockId.WATER && this.hasWaterNeighbor(x, y, z) ? BlockId.WATER : BlockId.AIR;
    this.setBlockFromPlayer(x, y, z, newId);
    // The drop lands as a real ground entity at the block's centre (matching
    // singleplayer, whose interaction.ts routes every drop through
    // DroppedItems.spawn) rather than teleporting straight into the
    // breaker's inventory - so a block broken across the room has to
    // actually be walked over, and anyone can pick it up, not just whoever
    // dug it.
    for (const drop of getDrops(brokenId, canHarvest)) {
      this.droppedItems.spawn(drop.id, drop.count, new THREE.Vector3(x, y, z));
    }
    // One use per block actually broken - same as interaction.ts's
    // finishMining(), which spends it on whatever's SELECTED right now, not
    // necessarily the item captured at breakStart (mining.itemId) if the
    // player swapped mid-dig.
    this.damageTool(session, 1);
  }

  /**
   * Server-side port of src/block-placement-rules.ts's PLACEMENT_SETUP_RULES
   * - same categories, same math, just fed the wire-friendly (normal,
   * clickY, yaw) inputs placeBlock's protocol doc comment describes instead
   * of a THREE-based RaycastHit/PlayerController. `placedHalfIsTop` folds
   * in here too since nothing else needs it standalone.
   */
  private computePlacementData(id: BlockId, normal: Vec3, clickY: number, yaw: number): BlockData | undefined {
    if (isOrientable(id)) {
      return { facing: facingTowardPlayer(yaw) };
    }
    if (isStairs(id) || isSlab(id)) {
      const half: 'top' | 'bottom' = normal.y > 0.5 ? 'bottom' : normal.y < -0.5 ? 'top' : clickY > 0.5 ? 'top' : 'bottom';
      if (isStairs(id)) {
        const away = facingTowardPlayer(yaw);
        return { facing: ((away + 2) & 3) as 0 | 1 | 2 | 3, half };
      }
      return { half };
    }
    if (id === BlockId.OAK_LOG) {
      const axis = Math.abs(normal.x) > 0.5 ? 'x' : Math.abs(normal.z) > 0.5 ? 'z' : 'y';
      return { axis };
    }
    if (id === BlockId.TORCH && Math.abs(normal.y) < 0.5) {
      const facing = normal.x > 0.5 ? 1 : normal.x < -0.5 ? 3 : normal.z > 0.5 ? 0 : 2;
      return { facing: facing as 0 | 1 | 2 | 3 };
    }
    return undefined;
  }

  /**
   * Places whatever block is in the player's currently SELECTED slot,
   * ignoring any blockId the client's placeBlock message claims - the
   * inventory (server-held) is what's actually authoritative on what a
   * player has to place, not a value a modified client could just lie
   * about. No-op (silently) if the slot is empty or not a block - except
   * flint and steel, ported from block-placement-rules.ts's USE_HANDLERS:
   * it ignites the target air cell instead of placing anything.
   */
  private handlePlaceBlock(session: Session, x: number, y: number, z: number, normal: Vec3, clickY: number, yaw: number): void {
    const slot = session.inventory[session.selectedSlot];
    if (slot.id === ItemId.FLINT_AND_STEEL) {
      if (this.getBlockAt(x, y, z) === BlockId.AIR) {
        this.setBlock(x, y, z, BlockId.FIRE);
        this.damageTool(session, 1);
      }
      return;
    }
    if (slot.id === null || !isBlock(slot.id)) return;
    // Admin+ only, regardless of how the slot got this block (even /give is
    // already Admin-gated, but this is the actual enforcement point - a
    // client can't place one just by claiming to hold it).
    if (ADMIN_BLOCK_IDS.has(slot.id) && !this.isAdminOrOwner(session.name)) return;
    // Same self-collision guard as singleplayer's BlockPlacer.placeBlock()
    // (block-placer.ts:38, via player.intersectsBlock - player-physics.ts's
    // overlapsHorizontally/overlapsVertically): never let a player wedge a
    // SOLID block into the space their own body currently occupies. Liquids
    // are the one exception there too (`isLiquid || !playerIntersectsBlock`)
    // - water/lava ARE placeable blocks in this game (no separate bucket
    // item), so a player standing in the spot they're placing water/lava
    // into (e.g. flooding the ground under their own feet) isn't blocked.
    const isLiquid = slot.id === BlockId.WATER || slot.id === BlockId.LAVA;
    if (!isLiquid && session.physics.intersectsBlock(x, y, z)) return;
    this.setBlockFromPlayer(x, y, z, slot.id, this.computePlacementData(slot.id, normal, clickY, yaw));
    removeFromSlot(slot, 1);
    this.sendInventory(session);
  }

  /** Right-click on a CONTROL_BLOCK - Admin+ only, denied (not silently ignored) otherwise so the client can tell the difference from "this isn't actually a control block". */
  private handleControlBlockOpen(session: Session, x: number, y: number, z: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.CONTROL_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const data = this.blockData.get(`${x},${y},${z}`);
    this.send(session.ws, { type: 'controlBlockState', x, y, z, controlId: data?.controlId ?? 0, flags: data?.controlFlags ?? defaultControlFlags() });
  }

  /** Saves this control block's link id + flags, mirrors them onto its paired block (if one with the same id already exists), and rebuilds the active zone list. */
  private handleControlBlockSet(session: Session, x: number, y: number, z: number, controlId: number, flags: ControlFlags): void {
    if (this.getBlockAt(x, y, z) !== BlockId.CONTROL_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const id = Math.trunc(controlId);
    if (!Number.isFinite(id) || id < 0) return;
    const data: BlockData = { controlId: id, controlFlags: flags };
    this.blockData.set(`${x},${y},${z}`, data);
    void this.state.storage.put(`blockdata:${x},${y},${z}`, data);
    // Find the paired block (same controlId, a different CONTROL_BLOCK cell)
    // and mirror the same flags onto it too - a zone has one set of flags,
    // not one per physical block, so whichever end an Admin edits from
    // should always update BOTH.
    for (const [key, blockId] of this.edits) {
      if (blockId !== BlockId.CONTROL_BLOCK || key === `${x},${y},${z}`) continue;
      const other = this.blockData.get(key);
      if (other?.controlId !== id) continue;
      const otherData: BlockData = { controlId: id, controlFlags: flags };
      this.blockData.set(key, otherData);
      void this.state.storage.put(`blockdata:${key}`, otherData);
    }
    this.rebuildControlZones();
    this.send(session.ws, { type: 'controlBlockState', x, y, z, controlId: id, flags });
  }

  /** Right-click on a TP_BLOCK - Admin+ only, same denial trust level as handleControlBlockOpen above. Defaults the panel to the pad's OWN position (a harmless no-op teleport) rather than leaving it blank when nothing has been configured yet. */
  private handleTpBlockOpen(session: Session, x: number, y: number, z: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.TP_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const target = this.blockData.get(`${x},${y},${z}`)?.tpTarget ?? { x, y, z };
    this.send(session.ws, { type: 'tpBlockState', x, y, z, target });
  }

  private handleTpBlockSet(session: Session, x: number, y: number, z: number, target: Vec3): void {
    if (this.getBlockAt(x, y, z) !== BlockId.TP_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    if (![target.x, target.y, target.z].every(Number.isFinite)) return;
    const data: BlockData = { tpTarget: { x: target.x, y: target.y, z: target.z } };
    this.blockData.set(`${x},${y},${z}`, data);
    void this.state.storage.put(`blockdata:${x},${y},${z}`, data);
    this.send(session.ws, { type: 'tpBlockState', x, y, z, target: data.tpTarget! });
  }

  /** Right-click on a MESSAGE_BLOCK - Admin+ only. */
  private handleMessageBlockOpen(session: Session, x: number, y: number, z: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.MESSAGE_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const cfg = this.blockData.get(`${x},${y},${z}`)?.messageConfig;
    this.send(session.ws, { type: 'messageBlockState', x, y, z, messages: cfg?.messages ?? [], intervalSeconds: cfg?.intervalSeconds ?? 10, random: cfg?.random ?? false });
  }

  private handleMessageBlockSet(session: Session, x: number, y: number, z: number, messages: MessageEntry[], intervalSeconds: number, random: boolean): void {
    if (this.getBlockAt(x, y, z) !== BlockId.MESSAGE_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const trimmed = messages.slice(0, MAX_MESSAGE_BLOCK_ENTRIES)
      .filter((m) => typeof m.text === 'string' && MESSAGE_COLORS.includes(m.color))
      .map((m) => ({ text: m.text.slice(0, 200), color: m.color }));
    const seconds = Number.isFinite(intervalSeconds) ? Math.max(1, Math.min(3600, intervalSeconds)) : 10;
    const cfg: MessageConfig = { messages: trimmed, intervalSeconds: seconds, random: !!random };
    const key = `${x},${y},${z}`;
    const data: BlockData = { messageConfig: cfg };
    this.blockData.set(key, data);
    void this.state.storage.put(`blockdata:${key}`, data);
    // (Re)start the cycle from the top rather than preserving mid-cycle
    // progress - a reconfigured block's message list may not even have as
    // many entries as its old `index` pointed at.
    this.messageBlockTimers.set(key, { elapsed: 0, index: 0 });
    this.send(session.ws, { type: 'messageBlockState', x, y, z, messages: cfg.messages, intervalSeconds: cfg.intervalSeconds, random: cfg.random });
  }

  /** Advances every configured MESSAGE_BLOCK's cycle and broadcasts whichever message comes due - called once per tick (not per-session, unlike applyEnvironmentDamage), since a message block's own cycle has nothing to do with any particular player. */
  private tickMessageBlocks(dt: number): void {
    for (const [key, timer] of this.messageBlockTimers) {
      const cfg = this.blockData.get(key)?.messageConfig;
      if (!cfg || cfg.messages.length === 0) continue;
      timer.elapsed += dt;
      if (timer.elapsed < cfg.intervalSeconds) continue;
      timer.elapsed = 0;
      const i = cfg.random ? Math.floor(Math.random() * cfg.messages.length) : timer.index % cfg.messages.length;
      timer.index = i + 1;
      const entry = cfg.messages[i];
      this.broadcast({ type: 'chat', from: 'server', text: entry.text, color: entry.color });
    }
  }

  /** Right-click on a HOLOGRAM_BLOCK - Admin+ only. */
  private handleHologramBlockOpen(session: Session, x: number, y: number, z: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.HOLOGRAM_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    const cfg = this.blockData.get(`${x},${y},${z}`)?.hologramConfig;
    this.send(session.ws, {
      type: 'hologramBlockState', x, y, z,
      text: cfg?.text ?? '', color: cfg?.color ?? 'white', height: cfg?.height ?? 1,
      showDistance: cfg?.showDistance ?? DEFAULT_HOLOGRAM_SHOW_DISTANCE,
    });
  }

  private handleHologramBlockSet(session: Session, x: number, y: number, z: number, text: string, color: MessageColor, height: number, showDistance: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.HOLOGRAM_BLOCK) return;
    if (!this.isAdminOrOwner(session.name)) { this.send(session.ws, { type: 'controlBlockDenied' }); return; }
    if (!MESSAGE_COLORS.includes(color)) return;
    const cfg: HologramConfig = {
      text: String(text).slice(0, 200), color,
      height: Number.isFinite(height) ? THREE.MathUtils.clamp(height, 0, 10) : 1,
      showDistance: Number.isFinite(showDistance) ? THREE.MathUtils.clamp(showDistance, 1, 256) : DEFAULT_HOLOGRAM_SHOW_DISTANCE,
    };
    const key = `${x},${y},${z}`;
    const data: BlockData = { hologramConfig: cfg };
    this.blockData.set(key, data);
    void this.state.storage.put(`blockdata:${key}`, data);
    // Everyone needs to see the new text/color/height, not just whoever
    // configured it - piggyback on the same blockChanged broadcast a real
    // block edit already uses (silent: true, since nothing actually
    // changed about the block itself, just its side-table data).
    this.broadcast({ type: 'blockChanged', x, y, z, blockId: BlockId.HOLOGRAM_BLOCK, silent: true, data });
  }

  /**
   * Q - throws the selected slot's item(s) out in front of the player as a
   * real ground entity, mirroring singleplayer's own Q handler (main.ts's
   * onDropSelected: spawn 0.6 blocks along the look direction, 0.2 below eye
   * level, thrown along that direction). The client's claimed `dir` is only
   * used for the throw arc - it can't move the player or reach further than
   * their own position, so there's nothing to validate beyond normalising it.
   * `all` mirrors that same onDropSelected(ctrlKey): plain Q (all=false)
   * drops a single item, Ctrl+Q (all=true) drops the whole stack.
   */
  private handleDropItem(session: Session, dir: Vec3, all: boolean): void {
    const slot = session.inventory[session.selectedSlot];
    if (slot.id === null) return;
    const held = slot.count ?? 0;
    if (held <= 0) return;
    const count = all ? held : 1;

    const look = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (look.lengthSq() > 0) look.normalize();
    const from = session.physics.state.position.clone().addScaledVector(look, 0.6);
    from.y -= 0.2;

    this.droppedItems.spawn(slot.id, count, from, look);
    removeFromSlot(slot, count);
    this.sendInventory(session);
  }

  /**
   * Release the bow. The arrow has to actually be in the player's inventory -
   * checked and spent here rather than trusted from the client, same as every
   * other inventory-backed action. Mirrors singleplayer's own shootBowFn,
   * including its *4 on the draw power (a fully-drawn shot was falling short
   * of vanilla's reach without it).
   */
  private handleShootBow(session: Session, power: number, dir: Vec3): void {
    if (removeItemsAnywhere(session.inventory, ItemId.ARROW, 1) < 1) return;

    const look = new THREE.Vector3(dir.x, dir.y, dir.z);
    if (look.lengthSq() < 1e-6) return;
    look.normalize();
    const from = session.physics.state.position.clone().addScaledVector(look, 0.5);
    const draw = THREE.MathUtils.clamp(power, 0, 1);
    this.arrows.spawn(from, look.multiplyScalar(powerToSpeed(draw * 4)), {
      ownerId: session.id,
      crit: draw >= 1,
    });
    // Same as main.ts's shootBowFn: inventory.damageSelected(1) - the bow is
    // always a tool (tools.ts's TIER_BOW), so this also covers the
    // sendInventory() the arrow removal above still needs.
    this.damageTool(session, 1);
  }

  /**
   * A skeleton's shot. `targetPos` already carries mob-ai.ts's own arc
   * compensation, computed against SKELETON_SHOT_POWER - so that constant has
   * to stay the speed used here too, or the arrow lands somewhere the AI
   * never aimed. Damage is fixed rather than speed-derived, so the skeleton's
   * deliberately-buffed shot speed doesn't also buff how hard it hits.
   */
  private spawnSkeletonArrow(fromPos: THREE.Vector3, targetPos: THREE.Vector3): void {
    const dir = targetPos.clone().sub(fromPos);
    const dist = dir.length();
    if (dist < 1e-6) return;
    dir.normalize().multiplyScalar(powerToSpeed(SKELETON_SHOT_POWER));
    this.arrows.spawn(fromPos, dir, { ownerId: null, fixedDamage: SKELETON_ARROW_DAMAGE });
  }

  private sendInventory(session: Session): void {
    this.send(session.ws, { type: 'inventoryUpdate', slots: session.inventory, selectedIndex: session.selectedSlot, armor: session.armor });
    this.sendCraftableRecipes(session);
  }

  /** Every RECIPES index this player can currently afford - recomputed and resent alongside every inventoryUpdate (sendInventory), since crafting affordability can only change when the inventory does. */
  private sendCraftableRecipes(session: Session): void {
    const recipes: { index: number; out: { id: number; count: number } }[] = [];
    for (let i = 0; i < RECIPES.length; i++) {
      const recipe = RECIPES[i];
      if (this.canAfford(session.inventory, recipe)) recipes.push({ index: i, out: recipe.out });
    }
    this.send(session.ws, { type: 'craftableRecipes', recipes });
  }

  /** Ingredient id -> how many the pattern/shapeless list needs, collapsing duplicates (e.g. a pickaxe's 3 planks count as needing 3 of that id, not 3 separate 1-of checks). */
  private recipeIngredientCounts(recipe: Recipe): Map<number, number> {
    const counts = new Map<number, number>();
    const add = (id: number | null) => { if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1); };
    if (recipe.kind === 'shapeless') recipe.input.forEach(add);
    else recipe.pattern.forEach((row) => row.forEach(add));
    return counts;
  }

  private canAfford(inventory: InventorySlot[], recipe: Recipe): boolean {
    for (const [id, count] of this.recipeIngredientCounts(recipe)) {
      if (countInInventory(inventory, id) < count) return false;
    }
    return true;
  }

  /**
   * Crafts RECIPES[recipeIndex] (src/crafting.ts - the exact same recipe
   * list and shape-matching singleplayer's crafting-grid.ts uses) if the
   * player can actually afford it - re-checked here rather than trusted
   * from the `craftableRecipes` list the client picked from, since that
   * list is just a UI convenience and a modified client could send any
   * index. Simplified from singleplayer's real 2x2/3x3 grid (see
   * protocol.ts's `craft` message doc comment for why): ingredients are
   * pulled from wherever they're stacked in the inventory rather than from
   * specific grid cells the player arranged by hand.
   */
  private handleCraft(session: Session, recipeIndex: number): void {
    const recipe = RECIPES[recipeIndex];
    if (!recipe || !this.canAfford(session.inventory, recipe)) return;
    for (const [id, count] of this.recipeIngredientCounts(recipe)) {
      removeItemsAnywhere(session.inventory, id, count);
    }
    addToInventory(session.inventory, recipe.out.id, recipe.out.count);
    this.sendInventory(session);
  }

  /**
   * Start eating whatever is in `slotIndex`, if it's food. Deliberately NOT
   * instant: the bite takes EAT_DURATION to land, the same 1.6s singleplayer
   * makes you spend. That timing is the whole cost of eating - now that PvP
   * exists, healing to full mid-fight with no wind-up would be a real balance
   * difference between the two modes, not a cosmetic one.
   *
   * One request commits to the whole bite (there's no "released the button"
   * message); it's cancelled by changing slots, by the food leaving the slot,
   * or by dying - see finishEating().
   */
  /** Right-click-to-equip (LCE ArmorItem::useOn) - server-authoritative twin of singleplayer's Inventory.quickEquipArmor(). No-op if the selected item isn't armor. */
  private handleQuickEquipArmor(session: Session): void {
    if (session.dead) return;
    const selected = session.inventory[session.selectedSlot];
    const slot = armorSlotFor(selected.id);
    if (slot === null) return;
    const previous = session.armor[slot];
    session.armor[slot] = { ...selected };
    session.inventory[session.selectedSlot] = previous.id === null ? createEmptySlot() : previous;
    this.sendInventory(session);
  }

  private handleUseItem(session: Session, slotIndex: number): void {
    if (session.dead) return;
    if (slotIndex < 0 || slotIndex >= session.inventory.length) return;
    const slot = session.inventory[slotIndex];
    if (slot.id === null || foodValue(slot.id) <= 0) return;
    if (session.eating?.slotIndex === slotIndex) return; // already chewing this one
    session.eating = { slotIndex, itemId: slot.id, elapsed: 0 };
    // Cosmetic-only, same trust level as `swing`/`entitySwing` - everyone
    // else's client plays the same crumb-particle burst the eater already
    // shows itself locally (see multiplayer-game.ts's startChewing).
    this.broadcast({ type: 'entityEat', id: session.id, itemId: slot.id }, session.ws);
  }

  /** Advance a bite in progress, healing and consuming one item once it completes. */
  private updateEating(session: Session, dt: number): void {
    const eating = session.eating;
    if (!eating) return;

    // Anything that means they're no longer holding that exact food cancels
    // the bite rather than healing them for something they no longer have.
    const slot = session.inventory[eating.slotIndex];
    if (session.dead || session.selectedSlot !== eating.slotIndex || slot?.id !== eating.itemId) {
      session.eating = null;
      return;
    }

    eating.elapsed += dt;
    if (eating.elapsed < EAT_DURATION) return;

    session.health = Math.min(PLAYER_MAX_HEALTH, session.health + foodValue(eating.itemId));
    removeFromSlot(slot, 1);
    session.eating = null;
    this.sendInventory(session);
  }

  // --- Real crafting grid (Fase 10) ------------------------------------
  // The cells live in the session, not in the inventory, exactly like
  // singleplayer's CraftingGrid holds its own slots. The server owns the
  // whole thing: it derives the result with matchRecipe() (the same pure
  // shape-matching singleplayer runs) so the client never needs the recipe
  // list to render what the cells currently make.

  private openCraftGrid(session: Session, table: { x: number; y: number; z: number } | null): void {
    // A 3x3 is only granted by an actual crafting table block - checked here
    // rather than trusted, or any client could just ask for the big grid.
    const side: 2 | 3 = table && this.getBlockAt(table.x, table.y, table.z) === BlockId.CRAFTING_TABLE ? 3 : 2;
    if (session.craft) this.closeCraftGrid(session); // never leak the previous grid's contents
    session.craft = { side, inputs: Array.from({ length: side * side }, () => createEmptySlot()) };
    this.sendCraftGrid(session);
  }

  /** Hand every cell back to the inventory before dropping the grid - closing a GUI must never destroy what was staged in it. */
  private closeCraftGrid(session: Session): void {
    if (!session.craft) return;
    // Same reasoning as the grid's own cells below: whatever's on the cursor
    // when the panel closes has to go back, not vanish - mirrors
    // singleplayer's toggleBackpack() calling restoreHeld() on close. Done
    // BEFORE nulling session.craft, in case it came from a 'grid' cell.
    this.handleInvCancel(session);
    for (const slot of session.craft.inputs) {
      if (slot.id !== null) addToInventory(session.inventory, slot.id, slot.count ?? 0);
    }
    session.craft = null;
    this.send(session.ws, { type: 'craftGridClosed' });
    this.sendInventory(session);
  }

  private craftOutputFor(session: Session): InventorySlot {
    if (!session.craft) return createEmptySlot();
    const { side, inputs } = session.craft;
    const result = matchRecipe(inputs.map((s) => s.id), side, side);
    if (!result) return createEmptySlot();
    const out = createEmptySlot();
    const desc = describeSlot(result.id);
    out.id = result.id;
    out.name = desc.name;
    out.sideTexture = desc.sideTexture;
    out.count = result.count;
    return out;
  }

  private sendCraftGrid(session: Session): void {
    if (!session.craft) return;
    this.send(session.ws, {
      type: 'craftGridState',
      side: session.craft.side,
      inputs: session.craft.inputs,
      output: this.craftOutputFor(session),
    });
  }

  private handleCraftMove(session: Session, from: CraftSlotRef, to: CraftSlotRef): void {
    if (!session.craft) return;
    const arrayFor = (ref: CraftSlotRef) => (ref.zone === 'grid' ? session.craft!.inputs : session.inventory);
    const inRange = (ref: CraftSlotRef) => ref.index >= 0 && ref.index < arrayFor(ref).length;
    if (!inRange(from) || !inRange(to)) return;
    if (from.zone === to.zone && from.index === to.index) return;

    moveOrMergeBetween(arrayFor(from), from.index, arrayFor(to), to.index);
    this.sendInventory(session);
    this.sendCraftGrid(session);
  }

  private slotArrayFor(session: Session, ref: CraftSlotRef): InventorySlot[] {
    if (ref.zone === 'grid') return session.craft?.inputs ?? [];
    if (ref.zone === 'furnaceInput' || ref.zone === 'furnaceFuel') return this.furnaceSlotArray(session, ref.zone);
    if (ref.zone === 'chest') return this.chestSlotArray(session);
    if (ref.zone === 'armor') return session.armor;
    return session.inventory;
  }

  /**
   * A furnace's input/fuel slot, wrapped as a 1-element InventorySlot[] so
   * handleInvPickUp/Place/Cancel below can treat it exactly like any other
   * slot array - furnace.ts's own FurnaceState only stores {id,count}
   * (SlotRef), not the name/texture renderSlot() needs, so describeSlot()
   * (the same helper session.inventory's own slots already use) fills that
   * in. Empty when no furnace is open or the block there stopped being one
   * (walked away, someone broke it) - the caller's own index-in-range check
   * then naturally no-ops, same as any other out-of-range ref.
   */
  private furnaceSlotArray(session: Session, zone: 'furnaceInput' | 'furnaceFuel'): InventorySlot[] {
    if (!session.openFurnace) return [];
    const { x, y, z } = session.openFurnace;
    if (this.getBlockAt(x, y, z) !== BlockId.FURNACE) return [];
    const furnace = this.getOrCreateFurnace(x, y, z);
    const ref = zone === 'furnaceInput' ? furnace.input : furnace.fuel;
    if (ref === null) return [createEmptySlot()];
    const desc = describeSlot(ref.id);
    return [{ id: ref.id, name: desc.name, sideTexture: desc.sideTexture, count: ref.count }];
  }

  /** Writes a furnaceSlotArray() result back into the real FurnaceState after handleInvPickUp/Place/Cancel mutated it - a no-op for any other zone. */
  private flushIfFurnace(session: Session, ref: CraftSlotRef, arr: InventorySlot[]): void {
    if (ref.zone !== 'furnaceInput' && ref.zone !== 'furnaceFuel') return;
    if (!session.openFurnace || arr.length === 0) return;
    const { x, y, z } = session.openFurnace;
    if (this.getBlockAt(x, y, z) !== BlockId.FURNACE) return;
    const furnace = this.getOrCreateFurnace(x, y, z);
    const slot = arr[0];
    const patch = slot.id === null ? null : { id: slot.id, count: slot.count ?? 0 };
    if (ref.zone === 'furnaceInput') furnace.input = patch; else furnace.fuel = patch;
    this.furnacesDirty = true; // items moving in or out is worth writing straight away, same as handleFurnaceInsert
    this.sendFurnaceState(session);
  }

  private sendHeld(session: Session): void {
    this.send(session.ws, { type: 'invHeld', item: session.heldItem });
  }

  /** Left-click-empty-handed (half=false) or right-click-empty-handed (half=true, takes ceil(count/2)) on a slot - see protocol.ts's invPickUp doc comment. Mirrors inventory.ts's pickUpFrom(). */
  private handleInvPickUp(session: Session, from: CraftSlotRef, half: boolean): void {
    if (session.heldItem) return; // already holding something - a well-behaved client never sends this then
    if (from.zone === 'grid' && !session.craft) return;
    const arr = this.slotArrayFor(session, from);
    if (from.index < 0 || from.index >= arr.length) return;
    const slot = arr[from.index];
    if (slot.id === null) return;
    const total = slot.count ?? 1;
    const take = half ? Math.ceil(total / 2) : total;
    session.heldItem = { ...slot, count: take };
    session.heldFrom = from;
    removeFromSlot(slot, take);
    this.flushIfFurnace(session, from, arr);
    this.flushIfChest(session, from, arr);
    this.sendInventory(session);
    this.sendCraftGrid(session);
    this.sendHeld(session);
  }

  /** Left-click (one=false, merge/swap the whole held stack) or right-click/paint-drag (one=true, deposit exactly one) onto a slot - see protocol.ts's invPlace doc comment. Mirrors inventory.ts's placeHeld()/depositOne(). */
  private handleInvPlace(session: Session, to: CraftSlotRef, one: boolean): void {
    const held = session.heldItem;
    if (!held) return;
    if (to.zone === 'grid' && !session.craft) return;
    // Server-authoritative version of inventory.ts's canAccept - a modified
    // client claiming a sword goes in the helmet slot gets refused here
    // regardless of what it rendered locally.
    if (to.zone === 'armor' && armorSlotFor(held.id) !== to.index) return;
    const arr = this.slotArrayFor(session, to);
    if (to.index < 0 || to.index >= arr.length) return;
    const dst = arr[to.index];

    if (one) {
      if (dst.id === null) {
        arr[to.index] = { ...held, count: 1 };
      } else if (dst.id === held.id && (dst.count ?? 0) < maxStackOf(dst.id)) {
        dst.count = (dst.count ?? 0) + 1;
      } else {
        return; // nowhere to put exactly one here - held stays as-is, nothing to broadcast
      }
      held.count = (held.count ?? 1) - 1;
      if ((held.count ?? 0) <= 0) { session.heldItem = null; session.heldFrom = null; }
    } else if (dst.id === held.id && maxStackOf(dst.id) > 1) {
      const moved = Math.min(maxStackOf(dst.id) - (dst.count ?? 0), held.count ?? 0);
      if (moved > 0) dst.count = (dst.count ?? 0) + moved;
      held.count = (held.count ?? 0) - moved;
      if ((held.count ?? 0) <= 0) { session.heldItem = null; session.heldFrom = null; }
      // else destination was already full - held keeps whatever didn't fit, same as placeHeld()'s early return
    } else if (dst.id === null) {
      arr[to.index] = held;
      session.heldItem = null;
      session.heldFrom = null;
    } else {
      // Different item occupying the target - swap. The displaced stack goes
      // back to wherever the held one came from - unlike singleplayer's
      // creative pickUp() there's no "infinite palette" source here, so
      // heldFrom is always set by the time anything is actually held.
      const previous = { ...dst };
      arr[to.index] = held;
      const from = session.heldFrom;
      if (from) {
        const fromArr = this.slotArrayFor(session, from);
        if (from.index >= 0 && from.index < fromArr.length) fromArr[from.index] = previous;
        this.flushIfFurnace(session, from, fromArr);
        this.flushIfChest(session, from, fromArr);
      }
      session.heldItem = null;
      session.heldFrom = null;
    }

    this.flushIfFurnace(session, to, arr);
    this.flushIfChest(session, to, arr);
    this.sendInventory(session);
    this.sendCraftGrid(session);
    this.sendHeld(session);
  }

  /** Put the held stack back where it came from (merging if it fits), for a right-click on empty space or the panel closing - see protocol.ts's invCancel doc comment. Mirrors inventory.ts's restoreHeld(). */
  private handleInvCancel(session: Session): void {
    const held = session.heldItem;
    const from = session.heldFrom;
    session.heldItem = null;
    session.heldFrom = null;
    if (held && from) {
      const arr = this.slotArrayFor(session, from);
      if (from.index >= 0 && from.index < arr.length) {
        const dest = arr[from.index];
        if (dest.id === null) {
          arr[from.index] = held;
        } else if (dest.id === held.id) {
          const moved = Math.min(maxStackOf(dest.id) - (dest.count ?? 0), held.count ?? 0);
          dest.count = (dest.count ?? 0) + moved;
          // Leftover beyond what fit back is lost, same as singleplayer's
          // restoreHeld() ("A different block sitting there, or overflow, is
          // dropped" - this server has no ground-drop fallback for it here).
        }
        this.flushIfFurnace(session, from, arr);
        this.flushIfChest(session, from, arr);
      }
    }
    this.sendInventory(session);
    this.sendCraftGrid(session);
    this.sendHeld(session);
  }

  /** Taking the result consumes ONE item from every occupied cell, same as singleplayer's consumeCraft() - not the whole stack, so holding a full grid crafts repeatedly. */
  private handleCraftTakeOutput(session: Session): void {
    if (!session.craft) return;
    const output = this.craftOutputFor(session);
    if (output.id === null) return;
    // Refuse rather than destroy the result if there's nowhere to put it.
    if (addToInventory(session.inventory, output.id, output.count ?? 0) < (output.count ?? 0)) return;
    for (const slot of session.craft.inputs) removeFromSlot(slot, 1);
    this.sendInventory(session);
    this.sendCraftGrid(session);
  }

  private furnaceKey(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private getOrCreateFurnace(x: number, y: number, z: number): FurnaceState {
    const key = this.furnaceKey(x, y, z);
    let state = this.furnaces.get(key);
    if (!state) {
      state = emptyFurnace();
      this.furnaces.set(key, state);
    }
    return state;
  }

  private sendFurnaceState(session: Session): void {
    if (!session.openFurnace) return;
    const { x, y, z } = session.openFurnace;
    this.send(session.ws, { type: 'furnaceState', x, y, z, state: this.getOrCreateFurnace(x, y, z) });
  }

  /**
   * A chest's 27 slots, backed by BlockData (this.blockData/`blockdata:`
   * storage) instead of furnace's own separate non-persisted `furnaces` Map -
   * unlike losing a furnace's mid-smelt progress on a DO eviction (a real,
   * documented, accepted gap - see the FurnaceManager wiring above), losing
   * a player's whole stored inventory would be a much worse bug, so this one
   * is written through to durable storage immediately on every change.
   */
  private getOrCreateChest(x: number, y: number, z: number): ChestState {
    const key = `${x},${y},${z}`;
    const existing = this.blockData.get(key)?.chest;
    if (existing) return existing;
    const fresh = emptyChest();
    this.mergeChestData(x, y, z, fresh);
    return fresh;
  }

  private mergeChestData(x: number, y: number, z: number, chest: ChestState): void {
    const key = `${x},${y},${z}`;
    const merged: BlockData = { ...this.blockData.get(key), chest };
    this.blockData.set(key, merged);
    void this.state.storage.put(`blockdata:${key}`, merged);
  }

  /** Same idea as furnaceSlotArray() but all 27 generic slots at once - a chest has no per-slot semantics to enforce. */
  private chestSlotArray(session: Session): InventorySlot[] {
    if (!session.openChest) return [];
    const { x, y, z } = session.openChest;
    if (this.getBlockAt(x, y, z) !== BlockId.CHEST) return [];
    const chest = this.getOrCreateChest(x, y, z);
    return chest.items.map((ref) => {
      if (ref === null) return createEmptySlot();
      const desc = describeSlot(ref.id);
      return { id: ref.id, name: desc.name, sideTexture: desc.sideTexture, count: ref.count };
    });
  }

  /** Writes a chestSlotArray() result back into the real ChestState after handleInvPickUp/Place/Cancel mutated it, and re-pushes to EVERY session currently viewing this same chest (not just the one that just acted) - a real second viewer sees the change live, same as vanilla, without needing a per-tick push (see openChest's doc comment). */
  private flushIfChest(session: Session, ref: CraftSlotRef, arr: InventorySlot[]): void {
    if (ref.zone !== 'chest') return;
    if (!session.openChest || arr.length === 0) return;
    const { x, y, z } = session.openChest;
    if (this.getBlockAt(x, y, z) !== BlockId.CHEST) return;
    const chest = this.getOrCreateChest(x, y, z);
    chest.items = arr.map((slot) => (slot.id === null ? null : { id: slot.id, count: slot.count ?? 0 }));
    this.mergeChestData(x, y, z, chest);
    for (const [, s] of this.sessions) {
      if (s.openChest && s.openChest.x === x && s.openChest.y === y && s.openChest.z === z) this.sendChestState(s);
    }
  }

  private sendChestState(session: Session): void {
    if (!session.openChest) return;
    const { x, y, z } = session.openChest;
    this.send(session.ws, { type: 'chestState', x, y, z, state: this.getOrCreateChest(x, y, z) });
  }

  /**
   * Moves the player's SELECTED hotbar slot's whole stack into the
   * furnace's input or fuel slot. Same item already there -> merge (up to
   * maxStack, leftover stays in the player's slot); different item -> the
   * furnace's current occupant goes back into the player's inventory first
   * (never silently destroyed) before the new stack goes in.
   */
  private handleFurnaceInsert(session: Session, x: number, y: number, z: number, target: 'input' | 'fuel'): void {
    if (this.getBlockAt(x, y, z) !== BlockId.FURNACE) return;
    const held = session.inventory[session.selectedSlot];
    if (held.id === null) return;
    const furnace = this.getOrCreateFurnace(x, y, z);
    const slot = furnace[target];

    if (slot && slot.id === held.id) {
      const max = maxStackOf(slot.id);
      const room = max - slot.count;
      if (room <= 0) return;
      const moved = Math.min(room, held.count ?? 0);
      slot.count += moved;
      removeFromSlot(held, moved);
    } else {
      if (slot) addToInventory(session.inventory, slot.id, slot.count); // give back whatever was there, never destroy it
      furnace[target] = { id: held.id, count: held.count ?? 0 };
      removeFromSlot(held, Infinity);
    }
    this.furnacesDirty = true; // items moving in or out is worth writing straight away, unlike cook progress
    this.sendInventory(session);
    this.sendFurnaceState(session);
  }

  private handleFurnaceTakeOutput(session: Session, x: number, y: number, z: number): void {
    if (this.getBlockAt(x, y, z) !== BlockId.FURNACE) return;
    const furnace = this.getOrCreateFurnace(x, y, z);
    if (!furnace.output) return;
    addToInventory(session.inventory, furnace.output.id, furnace.output.count);
    furnace.output = null;
    this.furnacesDirty = true;
    this.sendInventory(session);
    this.sendFurnaceState(session);
  }

  /**
   * Async because the join token has to be verified (HMAC, see
   * net/auth-token.ts). That's local crypto with no network call, so the
   * window before the session exists is sub-millisecond - at worst the
   * client's first `input` lands a tick early and is ignored, which costs it
   * 50ms of standing still and nothing else.
   */
  private async onJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): Promise<void> {
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.send(ws, { type: 'rejected', reason: `protocol mismatch: server is v${PROTOCOL_VERSION}` });
      ws.close();
      return;
    }

    // Claim the socket BEFORE the await: two join messages arriving back to
    // back would otherwise both get past the verification and build two
    // sessions on one connection.
    if (this.joining.has(ws) || this.sessions.has(ws)) return;
    this.joining.add(ws);

    // Identity comes from the signed token and nowhere else. No secret
    // configured means this server cannot tell players apart, so it refuses
    // everyone rather than silently going back to trusting a typed-in name.
    if (!this.env.AUTH_SECRET) {
      this.send(ws, { type: 'rejected', reason: 'server is missing AUTH_SECRET - see world-server README' });
      ws.close();
      return;
    }
    const verifiedName = typeof msg.token === 'string' ? await verifyAuthToken(msg.token, this.env.AUTH_SECRET) : null;
    if (!verifiedName) {
      this.send(ws, { type: 'rejected', reason: 'Log in again - your session has expired' });
      ws.close();
      return;
    }
    if (this.isBanned(verifiedName)) {
      this.send(ws, { type: 'rejected', reason: 'You are banned from this world' });
      ws.close();
      return;
    }
    // One connection per account name at a time - a second tab/device
    // logging in as the same name would otherwise get its own session
    // (same inventory record, since playerSaves is keyed by name) fighting
    // the first one over the same saved state every tick.
    if (this.sessionByName(verifiedName)) {
      this.send(ws, { type: 'rejected', reason: `${verifiedName} is already playing in this world` });
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
    // Returning player: pick up exactly where they left off - position,
    // inventory, health and selected slot - instead of a fresh spawn with
    // empty hands. `saved` is null for a name this world has never seen.
    const name = verifiedName;
    const saved = this.playerSaves.get(playerKey(name)) ?? null;

    const [spawnX, spawnZ] = this.findLandSpawn();
    const spawn: Vec3 = saved
      ? { x: saved.x, y: saved.y, z: saved.z }
      : { x: spawnX, y: this.findSpawnEyeY(spawnX, spawnZ), z: spawnZ };
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
    const slim = msg.slim === true;
    const cape = typeof msg.cape === 'string' && msg.cape.length <= 64 ? msg.cape : null;

    const session: Session = {
      ws, id, name, physics,
      yaw: saved?.yaw ?? 0, pitch: saved?.pitch ?? 0,
      intent: { moveX: 0, moveZ: 0, wantJump: false, sprinting: false, sneaking: false, restricted: false },
      lastSeq: 0,
      // A save written while they were dying could hold 0 - never restore
      // someone straight into a corpse they can't respawn out of.
      health: saved && saved.health > 0 ? saved.health : PLAYER_MAX_HEALTH,
      skin,
      slim,
      cape,
      // Deep-copied, not adopted by reference: the saved record is shared
      // state, and two sessions joining under the same name (a second tab,
      // say) would otherwise write into the very same slot objects.
      inventory: saved ? saved.slots.map((s) => ({ ...s })) : createEmptyInventory(),
      selectedSlot: saved?.selectedIndex ?? 0,
      armor: saved?.armor ? saved.armor.map((s) => ({ ...s })) : Array.from({ length: 4 }, createEmptySlot),
      armorSpill: 0,
      openFurnace: null,
      openChest: null,
      air: new PlayerAir(() => this.hurtPlayer(id, DROWN_DAMAGE, undefined, true, undefined, true)),
      lavaTimer: 0,
      fireTimer: 0,
      fireTicksLeft: 0,
      fireTickTimer: 0,
      onFire: false,
      dead: false,
      craft: null,
      heldItem: null,
      heldFrom: null,
      eating: null,
      mining: null,
      lastAttackAtMs: 0,
      invulnUntilMs: 0,
      // References `physics` (declared with `let` above and assigned just
      // before this) rather than `spawn`/`session.physics` - it has to track
      // wherever this player actually IS as they move, not the fixed point
      // they joined at.
      mobSpawning: createMobSpawning({
        getPlayerPos: () => physics.state.position,
        isSolidAt: (x, y, z) => this.isSolidAt(x, y, z),
        getBlockAt: (x, y, z) => this.getBlockAt(x, y, z),
        // ServerTerrain.surfaceHeight() is the raw (unrounded) noise sample -
        // chunk.ts's own generation floors it before placing the actual
        // GRASS block (see its `surfaceY = Math.floor(getTerrainHeight(...))`),
        // so passing the float straight through here made every animal/
        // hostile-surface column check read the wrong y (never GRASS) and
        // silently fail forever. Floor it the same way generation does.
        surfaceHeight: (x, z) => Math.floor(this.terrain!.surfaceHeight(x, z)),
        isActiveAt: (x, z) => this.activeRegion.isActiveAt(x, z),
        isNight: () => this.isNight(),
        approxBrightnessAt: (x, y, z) => this.approxBrightnessAt(x, y, z),
        isMobSpawnBlocked: (x, z) => this.controlZoneAt(x, z)?.mobSpawn === false,
        mobs: this.mobs,
      }),
    };
    this.sessions.set(ws, session);
    this.joining.delete(ws);

    this.send(ws, { type: 'welcome', playerId: id, worldSeed: this.worldSeed, spawn, tickRateHz: TICK_HZ, dayTime: this.dayNightElapsed });
    this.sendInventory(session);
    // Catch this client up on every edit made before it connected - our
    // placeholder world has no chunk system yet (see the class doc comment),
    // so there's no chunkData to send; replaying each edit as its own
    // blockChanged is simple and correct at this world's current tiny scale.
    for (const [key, id2] of this.edits) {
      const [x, y, z] = key.split(',').map(Number);
      // silent: true - this is catch-up history, not a live change; without
      // it a big backlog (e.g. a forest's worth of accumulated leaf decay)
      // played its dig sound/break-puff for every single entry on join.
      this.send(ws, { type: 'blockChanged', x, y, z, blockId: id2, waterDistance: this.waterDistanceFor(id2, x, y, z), silent: true, data: this.blockData.get(key) });
    }
    // Catch this client up on every already-connected player's skin, then
    // tell everyone else about this new player's - same backlog-replay
    // pattern as the edits loop just above.
    for (const [otherWs, other] of this.sessions) {
      if (otherWs === ws) continue;
      this.send(ws, { type: 'playerSkin', playerId: other.id, skin: other.skin, slim: other.slim, cape: other.cape });
    }
    this.broadcast({ type: 'playerSkin', playerId: id, skin, slim, cape }, ws);
    this.broadcast({ type: 'chat', from: 'server', text: `${session.name} joined` }, ws);
    this.ensureTicking();
  }

  private onDisconnect(ws: WebSocket): void {
    this.joining.delete(ws); // may have dropped mid-verification, before any session existed
    const session = this.sessions.get(ws);
    if (!session) return;
    // Put anything staged in an open crafting grid back in the inventory
    // first. Today the inventory itself goes with the session anyway, so this
    // changes nothing visible - it matters the moment Fase 12 persists
    // inventories, and doing it here means that phase can't forget.
    this.closeCraftGrid(session);
    // closeCraftGrid() above already cancels a held item IF a grid was open,
    // but a plain inventory-zone pick doesn't require one to be open - cover
    // that case too so nothing on the cursor is silently lost on disconnect.
    this.handleInvCancel(session);
    // Save AFTER returning the grid's contents, so what was staged in it is
    // part of the inventory that gets written rather than lost.
    this.savePlayer(session);
    // Each player has their own animal/hostile spawner (mobSpawning), so
    // leaving its mobs behind on every disconnect only ever grows the
    // world's population over a session, eventually starving everyone still
    // connected once ServerMobManager's MAX_MOBS cap is hit - a
    // disconnecting player's mobs leave with them instead.
    for (const mobId of session.mobSpawning.ownedMobIds()) this.mobs.forceRemove(mobId);
    this.mobsDirty = true;
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
    this.lastTickAtMs = null; // starting fresh - don't count the idle gap as an overrun
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * Health metric for "is this world still keeping up", which is what decides
   * how many players a world can hold.
   *
   * It measures the WALL-CLOCK GAP BETWEEN TICKS, not how long a tick's own
   * work takes. That is deliberate, and not what PLAN-MULTIPLAYER-PORT.md
   * originally described: Cloudflare freezes timers inside a Worker as a
   * Spectre mitigation, so Date.now()/performance.now() do not advance across
   * a stretch of synchronous code. Wrapping the tick body in a timer pair
   * would read 0ms forever. Consecutive setInterval callbacks are separated
   * by a real async boundary, so the gap between them does advance - and it
   * is the more useful number anyway: tick() runs on a FIXED dt, so a tick
   * that can't be delivered on schedule is a world running in slow motion,
   * which is exactly the symptom players feel.
   *
   * Reading it: the gap should sit at TICK_MS (50ms). Sustained higher means
   * the world is behind; the plan's guidance is to add players until the
   * average creeps past ~30-40ms of actual work, i.e. a gap noticeably above
   * 50ms.
   */
  private recordTickInterval(): void {
    const now = Date.now();
    const last = this.lastTickAtMs;
    this.lastTickAtMs = now;
    if (last === null) return;

    this.tickIntervals[this.tickIntervalIndex] = now - last;
    this.tickIntervalIndex = (this.tickIntervalIndex + 1) % TICK_SAMPLE_COUNT;
    if (this.tickSamplesFilled < TICK_SAMPLE_COUNT) this.tickSamplesFilled++;
  }

  /** Current load picture - served as JSON by /stats/:worldId (see index.ts). */
  private stats(): Record<string, unknown> {
    const samples = this.tickIntervals.slice(0, this.tickSamplesFilled);
    const avg = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    const peak = samples.length > 0 ? Math.max(...samples) : 0;
    return {
      players: this.sessions.size,
      mobs: this.mobs.count,
      activeChunks: this.activeRegion.size,
      droppedItems: this.droppedItems.snapshots().length,
      arrows: this.arrows.snapshots().length,
      targetTickMs: TICK_MS,
      avgTickIntervalMs: Number(avg.toFixed(2)),
      peakTickIntervalMs: peak,
      sampleWindowTicks: samples.length,
      tickCount: this.tickCount,
    };
  }

  private tick(): void {
    this.tickCount++;
    this.recordTickInterval();
    const dt = Math.min(TICK_MS / 1000, MAX_DT_S);

    this.dayNightElapsed += dt;
    const cycleTime = resolveCycleTime(this.dayNightElapsed, 0);
    const { skyDarken } = computeDayNightState(cycleTime);
    this.lastSkyDarken = skyDarken;
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
      if (session.dead) continue; // frozen on the death screen - no movement, no further harm
      const direction = new THREE.Vector3(session.intent.moveX, 0, session.intent.moveZ);
      if (direction.lengthSq() > 0) direction.normalize();
      direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), session.yaw);
      session.physics.updatePhysics(direction, session.intent.wantJump, session.intent.sprinting, dt, session.intent.restricted);
      this.applyEnvironmentDamage(session, dt);
      this.updateEating(session, dt);
    }
    this.tickMessageBlocks(dt);

    // Recompute which chunks are worth simulating BEFORE anything consults it
    // this tick, so a player who just crossed a chunk boundary wakes up their
    // new surroundings on the same tick they arrive rather than one late.
    this.activeRegion.update([...this.sessions.values()].map((s) => ({ id: s.id, pos: s.physics.state.position })));

    this.mobs.update(dt, {
      isSolid: (x, y, z) => this.isSolidAt(x, y, z),
      isWater: (x, y, z) => this.isWaterAt(x, y, z),
      players: this.livePlayers(),
      isActiveAt: (x, z) => this.activeRegion.isActiveAt(x, z),
      getBlockAt: (x, y, z) => this.getBlockAt(x, y, z),
      isDay: () => !this.isNight(),
      onAttackPlayer: (playerId, damage, fromPos) => this.hurtPlayer(playerId, damage, undefined, false, fromPos),
      onShootArrow: (fromPos, targetPos) => this.spawnSkeletonArrow(fromPos, targetPos),
      onDeath: (drops, pos) => {
        for (const drop of drops) this.droppedItems.spawn(drop.id, drop.count, pos);
        this.mobsDirty = true;
      },
    });

    // Global housekeeping (Fase 21 of PLAN-MULTIPLAYER-BUGFIXES-2.md): a
    // mob's OWNING player's own spawn slot already force-removes it the
    // instant it wanders out of that player's active region (game/
    // mob-spawning.ts's updateSpawnSlot) - but a mob whose owner has since
    // DISCONNECTED keeps its spawned mobs in the shared world on purpose
    // (Fase 9's own decision), and nothing else ever revisits them again.
    // One left far from every remaining player would otherwise sit frozen
    // (isActiveAt already stops it from thinking, see mobs.update() above)
    // forever, wasting a slot of MAX_MOBS with nobody around to ever see it.
    // This is the closest equivalent to singleplayer's "the session ends,
    // its mobs go with it" for a world that has to keep running after one
    // player leaves - reusing the exact isActiveAt/forceRemove machinery
    // that already exists, just applied without requiring a specific owner.
    for (const mob of this.mobs.snapshots()) {
      if (!this.activeRegion.isActiveAt(mob.pos.x, mob.pos.z)) this.mobs.forceRemove(mob.id);
    }

    // Each connected player's own 16-slot spawner (Fase 9) - run after the
    // active-region recompute above so a slot's "did my mob leave the active
    // area" check and any fresh spawn attempt both see this tick's real
    // regions, not last tick's. Frozen the same way physics/damage are: a
    // dead player waiting on the death screen doesn't keep repopulating the
    // world around their corpse.
    for (const session of this.sessions.values()) {
      if (!session.dead) session.mobSpawning.update(dt);
    }

    // Leaf decay (Fase 18 of PLAN-MULTIPLAYER-BUGFIXES-2.md) - same
    // watch-set/flood-fill as world.ts:397, just applied through setBlock()
    // so the removal broadcasts and persists like any other edit. Throttled
    // to once a second - see leavesTickAccum's doc comment for why running
    // it at the full tick rate was a real CPU/lag problem.
    this.leavesTickAccum += dt;
    if (this.leavesTickAccum >= 1) {
      const decayDelta = this.leavesTickAccum;
      this.leavesTickAccum = 0;
      for (const [x, y, z] of this.leaves.update((bx, by, bz) => this.getBlockAt(bx, by, bz), decayDelta)) {
        // Silent: decay is never a player action, so - same as singleplayer,
        // where it's driven from world.ts's own tick loop with no sound/drop
        // tied to it at all, unlike an actual mined block - it must never
        // play the generic break sound/particle puff every OTHER setBlock()
        // broadcast gets (see applyBlockChange's `silent` check client-side).
        this.setBlock(x, y, z, BlockId.AIR, true);
      }
    }

    this.droppedItems.update(dt, {
      isSolid: (x, y, z) => this.isSolidAt(x, y, z),
      players: this.livePlayers(),
      collect: (playerId, itemId, count) => {
        const session = this.sessionById(playerId);
        if (!session) return count; // left the world mid-pickup - the stack stays on the ground
        return count - addToInventory(session.inventory, itemId, count);
      },
      onPickup: (playerId) => {
        const session = this.sessionById(playerId);
        if (session) this.sendInventory(session);
      },
    });

    this.arrows.update(dt, {
      isSolid: (x, y, z) => this.isSolidAt(x, y, z),
      players: this.livePlayers(),
      raycastMobs: (from, dir, maxDist) => this.mobs.raycast(from, dir, maxDist),
      onHitMob: (mobId, damage, fromPos) => this.mobs.damage(mobId, damage, fromPos),
      onHitPlayer: (playerId, damage, fromPos) => this.hurtPlayer(playerId, damage, undefined, false, fromPos),
      collect: (playerId) => {
        const session = this.sessionById(playerId);
        if (!session) return false;
        if (addToInventory(session.inventory, ItemId.ARROW, 1) < 1) return false; // full - the arrow stays where it is
        this.sendInventory(session);
        return true;
      },
    });

    // Water, lava and fire. Each engine keeps its own tick interval (0.25s,
    // 1.5s and 1.2s) and skips anything outside the active region, so a flow
    // or a blaze nobody is near costs nothing at all until someone walks back.
    const isActiveAt = (x: number, z: number) => this.activeRegion.isActiveAt(x, z);
    this.water.update(dt, isActiveAt);
    this.lava.update(dt, isActiveAt);
    this.fire.update(dt, isActiveAt, this.lava);

    this.mobSaveAccum += dt;
    if (this.mobSaveAccum >= MOB_SAVE_INTERVAL || this.mobsDirty) {
      this.mobSaveAccum = 0;
      this.mobsDirty = false;
      void this.state.storage.put(MOBS_KEY, this.mobs.toRecords());
    }

    this.furnaceSaveAccum += dt;
    if (this.furnaceSaveAccum >= FURNACE_SAVE_INTERVAL || this.furnacesDirty) {
      this.furnaceSaveAccum = 0;
      this.furnacesDirty = false;
      this.saveFurnaces();
    }

    // Connected players are checkpointed on a slow cadence. Disconnecting
    // writes immediately (onDisconnect), so this only bounds how much is lost
    // if the DO is evicted out from under a live session.
    this.playerSaveAccum += dt;
    if (this.playerSaveAccum >= PLAYER_SAVE_INTERVAL) {
      this.playerSaveAccum = 0;
      for (const session of this.sessions.values()) this.savePlayer(session);
    }

    this.furnaceManager.tick(dt);
    // Only sessions that actually have a furnace GUI open need the gauge
    // updates - broadcasting every furnace to everyone would scale badly
    // and nobody else is looking at it anyway.
    for (const [, session] of this.sessions) {
      if (session.openFurnace) this.sendFurnaceState(session);
    }

    const entities: EntitySnapshot[] = [
      // A dead player STAYS in the list (dying:true) instead of dropping out
      // the instant health hits 0 - the client plays the same topple/red-
      // tint animation a dying mob gets (RemoteEntity.dyingFor) and holds it
      // until they respawn, rather than the corpse just vanishing like a
      // disconnect.
      ...[...this.sessions.values()].map((s) => ({
        id: s.id,
        kind: 'player' as const,
        pos: { x: s.physics.state.position.x, y: s.physics.state.position.y, z: s.physics.state.position.z },
        yaw: s.yaw,
        health: s.health,
        maxHealth: PLAYER_MAX_HEALTH,
        onFire: s.onFire,
        dying: s.dead,
        name: s.name,
        pitch: s.pitch,
        sneaking: s.intent.sneaking,
        heldItem: s.inventory[s.selectedSlot]?.id ?? null,
        armor: s.armor.map((a) => a.id),
      })),
      ...this.mobs.snapshots(),
    ];

    const droppedItems = this.droppedItems.snapshots();
    const arrows = this.arrows.snapshots();

    // `entities`/`droppedItems`/`arrows` are now IDENTICAL for every
    // connected client (each session's own `.filter((e) => e.id !==
    // session.id)` copy used to make this per-session, at the cost of
    // JSON.stringify-ing those same arrays once per connected player, every
    // tick, inside this single-threaded DO - real, wasted CPU that directly
    // competes with the same tick's physics/AI for time. Serializing the
    // shared portion exactly once and splicing each session's small `self`
    // object into the pre-built string turns that into O(1) big-array
    // stringify + O(sessions) cheap ones. The client now skips its own id
    // out of `entities` itself (see multiplayer-game.ts's localPlayerId).
    const entitiesJson = JSON.stringify(entities);
    const droppedItemsJson = JSON.stringify(droppedItems);
    const arrowsJson = JSON.stringify(arrows);

    for (const [ws, session] of this.sessions) {
      const p = session.physics.state;
      const selfJson = JSON.stringify({
        pos: { x: p.position.x, y: p.position.y, z: p.position.z },
        velocity: { x: p.velocity.x, y: p.velocity.y, z: p.velocity.z },
        yaw: session.yaw,
        pitch: session.pitch,
        grounded: p.grounded,
        health: session.health,
        air: session.air.points,
        onFire: session.onFire,
      });
      const payload = `{"type":"state","tick":${this.tickCount},"ackSeq":${session.lastSeq},"self":${selfJson},"entities":${entitiesJson},"droppedItems":${droppedItemsJson},"arrows":${arrowsJson}}`;
      try { ws.send(payload); } catch { /* socket already gone */ }
    }
  }

  /**
   * Falling, drowning and burning, mirroring singleplayer's own per-frame
   * block in main.ts so the world hurts the same in both modes. Runs right
   * after this session's physics step, since fall distance is only valid for
   * the tick the landing happened on (PlayerPhysics recomputes `fallImpact`
   * from scratch every updatePhysics, so there's nothing to "consume" here -
   * reading it a tick late would just read 0).
   */
  private applyEnvironmentDamage(session: Session, dt: number): void {
    const fall = session.physics.fallImpact;
    if (fall > FALL_SAFE_DISTANCE) this.hurtPlayer(session.id, Math.ceil(fall - 3));

    const pos = session.physics.state.position;
    const bx = Math.round(pos.x);
    const bz = Math.round(pos.z);
    // Two samples per body, at knee and chest height - the same pair
    // singleplayer checks, so standing in a single flame block registers
    // whether it's at your feet or your waist.
    const atFeet = this.getBlockAt(bx, Math.round(pos.y - 1.4), bz);
    const atChest = this.getBlockAt(bx, Math.round(pos.y - 0.6), bz);
    const inLava = atFeet === BlockId.LAVA || atChest === BlockId.LAVA;
    const inFire = !inLava && (atFeet === BlockId.FIRE || atChest === BlockId.FIRE);

    // TP pad: standing on one teleports instantly to its configured target
    // (defaults to its own position - a no-op - if never configured, see
    // handleTpBlockOpen). Checked at the block directly under the feet, not
    // the knee/chest samples above (those exist to catch a body PARTLY in
    // lava/fire; a teleport pad only triggers by actually standing on it).
    const groundBlock = this.getBlockAt(bx, Math.round(pos.y - 1.62), bz);
    if (groundBlock === BlockId.TP_BLOCK) {
      const target = this.blockData.get(`${bx},${Math.round(pos.y - 1.62)},${bz}`)?.tpTarget;
      if (target) session.physics.setSpawn(target.x, target.y, target.z);
    }

    // Jumping a fresh timer straight to its threshold makes the FIRST frame of
    // contact hurt immediately, instead of granting a free half second inside
    // the lava - the else branches reset it the moment contact is lost.
    if (inLava) {
      if (session.lavaTimer === 0) session.lavaTimer = LAVA_TICK_INTERVAL;
      session.lavaTimer += dt;
      if (session.lavaTimer >= LAVA_TICK_INTERVAL) {
        session.lavaTimer -= LAVA_TICK_INTERVAL;
        this.hurtPlayer(session.id, LAVA_TICK_DAMAGE, undefined, true);
      }
    } else {
      session.lavaTimer = 0;
    }

    if (inFire) {
      if (session.fireTimer === 0) session.fireTimer = FIRE_TICK_INTERVAL;
      session.fireTimer += dt;
      if (session.fireTimer >= FIRE_TICK_INTERVAL) {
        session.fireTimer -= FIRE_TICK_INTERVAL;
        this.hurtPlayer(session.id, FIRE_TICK_DAMAGE, undefined, true);
      }
    } else {
      session.fireTimer = 0;
    }

    // After-burn: contact tops the counter back up (so it only starts draining
    // once you're clear of the flames), then burns down one damage per second.
    if (inLava || inFire) session.fireTicksLeft = PLAYER_FIRE_AFTERBURN_TICKS;
    session.onFire = session.fireTicksLeft > 0;
    if (session.onFire) {
      session.fireTickTimer += dt;
      if (session.fireTickTimer >= PLAYER_FIRE_TICK_INTERVAL) {
        session.fireTickTimer -= PLAYER_FIRE_TICK_INTERVAL;
        session.fireTicksLeft -= 1;
        this.hurtPlayer(session.id, 1, undefined, true);
      }
    } else {
      session.fireTickTimer = 0;
    }

    // Head-underwater is a plain block test at eye level rather than
    // singleplayer's UnderwaterManager check, which also accounts for a
    // flowing block's actual surface height - the server has no flowing water
    // to account for until the water sim lands (Fase 6b of the port plan).
    session.air.update(dt, this.isWaterAt(bx, Math.round(pos.y), bz));
  }

  /** Player melee attack on a mob - checked server-side (reach + attack-rate), never trusted from the client. */
  private attackMob(attacker: Session, targetId: number): void {
    const now = Date.now();
    if (now - attacker.lastAttackAtMs < PLAYER_ATTACK_COOLDOWN_MS) return;
    const mobPos = this.mobs.getPos(targetId);
    if (!mobPos) return; // already dead/gone
    if (attacker.physics.state.position.distanceTo(mobPos) > PLAYER_MELEE_RANGE) return;
    if (this.controlZoneAt(mobPos.x, mobPos.z)?.mobDamage === false) return;
    attacker.lastAttackAtMs = now;
    this.mobs.damage(targetId, PLAYER_MELEE_DAMAGE, attacker.physics.state.position);
    // LCE DiggerItem::hurtEnemy - hitting something costs two uses, not one.
    this.damageTool(attacker, 2);
  }

  /**
   * PvP. Same reach check as hitting a mob, plus spawn protection: no damage
   * if EITHER party is inside the protected area. Checking the attacker too
   * (not just the victim) is what stops the obvious abuse of standing safe
   * inside the zone and picking off everyone walking past its edge.
   */
  private attackPlayer(attacker: Session, targetId: number): void {
    const now = Date.now();
    if (now - attacker.lastAttackAtMs < PLAYER_ATTACK_COOLDOWN_MS) return;
    const target = this.sessionById(targetId);
    if (!target || target === attacker || target.dead) return;
    const from = attacker.physics.state.position;
    const to = target.physics.state.position;
    if (from.distanceTo(to) > PLAYER_MELEE_RANGE) return;
    if (this.inSpawnProtection(from) || this.inSpawnProtection(to)) return;
    // Zone PvP flag: off blocks the hit if EITHER party is inside it, same
    // "checking the attacker too" reasoning the spawn-protection check above
    // already uses (otherwise someone could stand safe in a pvp-off zone
    // and pick off people walking past its edge).
    if (this.controlZoneAt(from.x, from.z)?.pvp === false || this.controlZoneAt(to.x, to.z)?.pvp === false) return;
    attacker.lastAttackAtMs = now;
    this.hurtPlayer(target.id, PLAYER_MELEE_DAMAGE, attacker.name, false, attacker.physics.state.position);
    this.damageTool(attacker, 2);
  }

  /**
   * The world's spawn column, resolved once and cached. findLandSpawn() is a
   * pure function of the terrain (a deterministic spiral out from the origin,
   * no randomness), so every call already returned the same answer - caching
   * only avoids re-walking the spiral, and gives spawn protection a single
   * fixed centre rather than something recomputed per check.
   */
  private spawnChunk: [number, number] | null = null;

  /** True if `pos` is inside the SPAWN_PROTECTION_CHUNKS x SPAWN_PROTECTION_CHUNKS block of chunks centred on the world spawn, where players can't hurt each other. */
  private inSpawnProtection(pos: THREE.Vector3): boolean {
    if (!this.spawnChunk) {
      const [sx, sz] = this.findLandSpawn();
      this.spawnChunk = chunkCoordOf(sx, sz);
    }
    const [cx, cz] = chunkCoordOf(pos.x, pos.z);
    const reach = (SPAWN_PROTECTION_CHUNKS - 1) / 2;
    return Math.abs(cx - this.spawnChunk[0]) <= reach && Math.abs(cz - this.spawnChunk[1]) <= reach;
  }

  /**
   * Damage from a mob (melee or "shot") to a specific player. No fall
   * damage/drowning/fire tracked server-side yet - this is currently the
   * only source of player damage. On death: reset health and teleport back
   * to spawn immediately (no death screen/animation - purely a position +
   * health reset, see the class doc comment for what's still missing).
   */
  /**
   * `ignoreInvuln` mirrors player-health.ts's damage() flag: environmental
   * damage (drowning, lava/fire ticks) passes true so it isn't blocked by the
   * i-frame window a hostile hit just started - same split singleplayer
   * makes at main.ts's own damage() call sites.
   */
  /** Spends `amount` durability on every equipped armor piece independently (LCE Inventory::hurtArmor), removing any that reach their max, and pushing the result to the client. */
  private damageArmor(session: Session, amount: number): void {
    let changed = false;
    for (let slot = 0; slot < 4; slot++) {
      const item = session.armor[slot];
      const uses = armorDurability(item.id);
      if (uses <= 0) continue;
      const damage = (item.damage ?? 0) + amount;
      session.armor[slot] = damage >= uses ? createEmptySlot() : { ...item, damage };
      changed = true;
    }
    if (changed) this.sendInventory(session);
  }

  private hurtPlayer(playerId: number, rawDamage: number, killedBy?: string, ignoreInvuln = false, fromPos?: THREE.Vector3, bypassArmor = false): void {
    const session = this.sessionById(playerId);
    if (!session || session.dead) return; // a corpse can't be hurt again
    // Zone invulnerability - unlike the i-frame window below, this blocks
    // EVERY damage source unconditionally (fall/lava/fire/drown included,
    // which all pass ignoreInvuln=true to skip THAT window) - a control
    // zone's own invuln flag is a much stronger guarantee than a brief
    // post-hit grace period.
    const p = session.physics.state.position;
    if (this.controlZoneAt(p.x, p.z)?.invuln) return;
    const now = Date.now();
    if (!ignoreInvuln && now < session.invulnUntilMs) return;
    // LCE Mob::getDamageAfterArmorAbsorb/Inventory::hurtArmor - drowning
    // (bypassArmor) skips both the defense reduction and the durability
    // loss, same as vanilla's magic/drown damage sources.
    let damage = rawDamage;
    if (!bypassArmor) {
      const armorValue = totalArmorValue(session.armor.map((s) => s.id));
      if (armorValue > 0) {
        const reduced = reduceDamageByArmor(rawDamage, armorValue, session.armorSpill);
        damage = reduced.damage;
        session.armorSpill = reduced.spill;
        this.damageArmor(session, armorHurtAmount(rawDamage));
      }
    }
    session.health = Math.max(0, session.health - damage);
    if (!ignoreInvuln) session.invulnUntilMs = now + PLAYER_HURT_INVULN_MS;
    // Same shove as main.ts's hurtPlayerFromMob - only for a real attack
    // (fromPos given), never for fall/lava/fire/drown, matching singleplayer.
    // Applied even on the killing blow, same as singleplayer does.
    if (fromPos) {
      const dx = p.x - fromPos.x;
      const dz = p.z - fromPos.z;
      const len = Math.hypot(dx, dz) || 1;
      session.physics.applyKnockback((dx / len) * PLAYER_KNOCKBACK_SPEED, (dz / len) * PLAYER_KNOCKBACK_SPEED, PLAYER_KNOCKBACK_UP);
    }
    if (session.health > 0) return;

    // Stay dead at 0 health instead of respawning on the spot: the client
    // needs a moment where it IS dead to put a death screen up, and the old
    // instant reset meant it never saw health reach 0 at all. The actual
    // respawn happens when they ask for it (handleRespawn).
    session.dead = true;
    session.onFire = false; // stop the flames on everyone else's view of the body
    this.send(session.ws, { type: 'died', killedBy });
    this.broadcast({
      type: 'chat', from: 'server',
      text: killedBy ? `${session.name} was slain by ${killedBy}` : `${session.name} died`,
    });
  }

  /**
   * Leave the death screen. Everything the environment was doing to them gets
   * cleared here, not just health - respawning still out of breath or still
   * burning would kill them again on dry land.
   */
  /**
   * Reduced port of src/chat-commands.ts's /summon, /give, /time, /seed and
   * /fly (Fase 6/7 of PLAN-MULTIPLAYER-BUGFIXES.md /
   * PLAN-MULTIPLAYER-MISSING-FEATURES.md), plus multiplayer-only commands
   * with no singleplayer equivalent: /clean <inv|mob> (a single-player
   * world has no reason to nuke every mob at once, or clear an inventory
   * it's just as easy to empty by hand), /tp <player> <player>, /rank
   * <player> <rank>, and /kick, /ban, /unban, /mute <player> [duration] -
   * moderation only makes sense once other real people are in the world.
   * /panorama and /mobstatus stay singleplayer-only (purely client-side
   * capture, or a debug readout of client-only spawning state that doesn't
   * exist the same way server-side). The result is echoed back to the
   * caller ONLY, as a `from: 'server'` chat line - never broadcast, same as
   * a real Minecraft server's command output.
   *
   * Permission comes from rankOf(session.name) (see PlayerRank's own doc
   * comment): /kick, /ban, /unban and /mute need Mod or above; /give,
   * /time, /seed, /fly, /clean, /tp and /rank <player> Mod|User need Admin
   * or above; /rank <player> Admin needs the 'sigmafes' owner override
   * specifically, not even a plain Admin can hand that rank out. /summon
   * and /clean inv (no target) stay unrestricted - they only ever affect
   * the caller's own mobs-in-front-of-them/inventory.
   */
  private handleChatCommand(session: Session, raw: string): void {
    const args = raw.trim().split(/\s+/).filter(Boolean);
    const cmd = (args.shift() ?? '').toLowerCase();
    const reply = (text: string) => this.send(session.ws, { type: 'chat', from: 'server', text });
    const rank = this.rankOf(session.name);
    const isOwner = rank === 'sigmafes';
    const isAdmin = isOwner || rank === 'Admin';
    const isMod = isAdmin || rank === 'Mod';

    if (cmd === 'time') {
      if (!isAdmin) { reply('You do not have permission to use /time.'); return; }
      if (args[0] === 'set' && (TIME_PHASES as readonly string[]).includes(args[1])) {
        this.dayNightElapsed = cycleTimeFor(args[1] as TimePhase);
        this.lastDayTimeBroadcast = -Infinity; // force the next tick() to push the new time out immediately instead of waiting on its usual throttle
        reply(`Set the time to ${args[1]}`);
        return;
      }
      reply('Usage: /time set day|night|sunset|sunrise');
      return;
    }

    if (cmd === 'seed') {
      if (!isAdmin) { reply('You do not have permission to use /seed.'); return; }
      reply(`World seed: ${this.worldSeed}`);
      return;
    }

    if (cmd === 'fly') {
      if (!isAdmin) { reply('You do not have permission to use /fly.'); return; }
      // No double-tap-jump detection server-side (input is just a held
      // wantJump boolean, see Session.intent) - unlike singleplayer's
      // toggle-a-permission-then-double-tap flow, this both grants the
      // permission AND engages flight immediately (hold Space to ascend,
      // sneak to descend, same as singleplayer once flying).
      const enabled = !session.physics.flyEnabled;
      session.physics.setCanFly(enabled);
      if (enabled) session.physics.setFlying(true);
      reply(enabled ? 'Flight enabled.' : 'Flight disabled.');
      return;
    }

    if (cmd === 'clean') {
      const target = (args[0] ?? '').toLowerCase();
      if (target === 'inv') {
        // With a second argument, clears THAT player's inventory instead of
        // the caller's own - admin-gated, since it reaches into someone
        // else's stuff. No argument stays the original self-only, ungated
        // behaviour (same as /give used to be).
        const targetName = args[1];
        if (targetName) {
          if (!isAdmin) { reply('You do not have permission to use /clean inv on another player.'); return; }
          const targetSession = this.sessionByName(targetName);
          if (!targetSession) { reply(`${targetName} is not online.`); return; }
          for (let i = 0; i < targetSession.inventory.length; i++) targetSession.inventory[i] = createEmptySlot();
          this.sendInventory(targetSession);
          reply(`Cleared ${targetSession.name}'s inventory.`);
          return;
        }
        for (let i = 0; i < session.inventory.length; i++) session.inventory[i] = createEmptySlot();
        this.sendInventory(session);
        reply('Inventory cleared.');
        return;
      }
      if (target === 'mob' || target === 'mobs') {
        // World-wide (every player's animals AND hostiles), so admin-gated
        // like /time - one player shouldn't be able to wipe everyone else's
        // spawned mobs on a whim.
        if (!isAdmin) { reply('You do not have permission to use /clean mob.'); return; }
        const ids = this.mobs.snapshots().map((s) => s.id);
        for (const id of ids) this.mobs.forceRemove(id);
        this.mobsDirty = true;
        reply(`Removed ${ids.length} mob${ids.length === 1 ? '' : 's'}.`);
        return;
      }
      reply('Usage: /clean inv [player] | mob');
      return;
    }

    if (cmd === 'kick' || cmd === 'ban' || cmd === 'unban' || cmd === 'mute') {
      if (!isMod) { reply(`You do not have permission to use /${cmd}.`); return; }
      const targetName = args[0];
      if (!targetName) { reply(`Usage: /${cmd} <player>${cmd === 'ban' || cmd === 'mute' ? ' [10m|2h|3d]' : ''}`); return; }
      const lower = targetName.toLowerCase();

      if (cmd === 'unban') {
        if (!this.bannedNames.has(lower)) { reply(`${targetName} is not banned.`); return; }
        this.bannedNames.delete(lower);
        void this.state.storage.delete(`ban:${lower}`);
        reply(`Unbanned ${targetName}.`);
        return;
      }
      let durationText = '';
      if (cmd === 'mute' || cmd === 'ban') {
        const expiry = this.parseDuration(args[1]);
        if (expiry === null) { reply('Duration must look like 10m, 2h, or 3d.'); return; }
        const map = cmd === 'mute' ? this.mutedNames : this.bannedNames;
        map.set(lower, expiry);
        void this.state.storage.put(`${cmd}:${lower}`, expiry);
        durationText = expiry === Infinity ? ' permanently' : ` until ${new Date(expiry).toISOString()}`;
        if (cmd === 'mute') { reply(`Muted ${targetName}${durationText}.`); return; }
      }
      // /kick and /ban both disconnect anyone currently online under that
      // name - /ban would otherwise only take effect on their NEXT join
      // attempt, leaving them connected until then.
      const target = this.sessionByName(targetName);
      if (!target) { reply(`${targetName} is not online.${cmd === 'ban' ? ` Banned${durationText}.` : ''}`); return; }
      this.send(target.ws, { type: 'rejected', reason: cmd === 'ban' ? 'You have been banned from this world' : 'You have been kicked from this world' });
      target.ws.close();
      reply(cmd === 'ban' ? `Banned ${target.name}${durationText}.` : `Kicked ${target.name}.`);
      return;
    }

    if (cmd === 'tp') {
      if (!isAdmin) { reply('You do not have permission to use /tp.'); return; }
      const [fromName, toName] = args;
      if (!fromName || !toName) { reply('Usage: /tp <player> <destination player>'); return; }
      const from = this.sessionByName(fromName);
      const to = this.sessionByName(toName);
      if (!from) { reply(`${fromName} is not online.`); return; }
      if (!to) { reply(`${toName} is not online.`); return; }
      const p = to.physics.state.position;
      from.physics.setSpawn(p.x, p.y, p.z);
      reply(`Teleported ${from.name} to ${to.name}.`);
      return;
    }

    if (cmd === 'rank') {
      const [targetName, wantedRank] = args;
      if (!targetName || !wantedRank) { reply(`Usage: /rank <player> <${PLAYER_RANKS.join('|')}>`); return; }
      const normalized = PLAYER_RANKS.find((r) => r.toLowerCase() === wantedRank.toLowerCase());
      if (!normalized) { reply(`Usage: /rank <player> <${PLAYER_RANKS.join('|')}>`); return; }
      // Handing out Admin is the owner's call alone - even an existing Admin
      // can't promote a third player to their own level, only Mod/User.
      if (normalized === 'Admin' ? !isOwner : !isAdmin) { reply('You do not have permission to use /rank.'); return; }
      const lower = targetName.toLowerCase();
      if (lower === OWNER_NAME) { reply(`${targetName} is the owner and always has every permission.`); return; }
      this.playerRanks.set(lower, normalized);
      void this.state.storage.put(`rank:${lower}`, normalized);
      const targetSession = this.sessionByName(targetName);
      reply(`Set ${targetSession?.name ?? targetName}'s rank to ${normalized}.`);
      return;
    }

    if (cmd === 'summon') {
      const kind = (args[0] ?? '').toLowerCase() as MobKind;
      if (!MOB_KINDS.includes(kind)) {
        reply(`Usage: /summon <${MOB_KINDS.join('|')}>`);
        return;
      }
      // A few blocks in front of the player, facing back toward them - same
      // placement math as the singleplayer command.
      const dir = new THREE.Vector3(-Math.sin(session.yaw), 0, -Math.cos(session.yaw));
      const pos = session.physics.state.position.clone().addScaledVector(dir, 3);
      pos.y -= 1.62;
      const id = this.mobs.spawn(kind, pos, session.yaw + Math.PI);
      reply(id === null ? 'Could not summon: too many mobs already in the world.' : `Summoned a ${kind}.`);
      return;
    }

    if (cmd === 'give') {
      if (!isAdmin) { reply('You do not have permission to use /give.'); return; }
      if (args.length === 0) { reply('Usage: /give <item|block> [count]'); return; }

      // Trailing pure-number argument is the count; the rest is the item name.
      let count = 1;
      let nameParts = args;
      const last = args[args.length - 1];
      if (args.length > 1 && /^\d+$/.test(last)) {
        count = Math.max(1, Math.min(6400, parseInt(last, 10)));
        nameParts = args.slice(0, -1);
      }
      const query = slugifyItemName(nameParts.join(' ').replace(/^minecraft:/, ''));

      let id: number | null = null;
      let label = '';
      for (const b of BLOCK_CATALOG) {
        if (slugifyItemName(b.name) === query || String(b.id) === query) { id = b.id; label = b.name; break; }
      }
      if (id == null) {
        for (const [key, def] of Object.entries(ITEMS)) {
          if (slugifyItemName(def.name) === query || key === query) { id = Number(key); label = def.name; break; }
        }
      }
      if (id == null) { reply(`Unknown item: ${nameParts.join(' ')}`); return; }

      const leftover = addToInventory(session.inventory, id, count);
      const gave = count - leftover;
      this.sendInventory(session);
      reply(gave > 0 ? `Gave ${gave} × ${label}` : 'Inventory full');
      return;
    }

    reply(`Unknown command: /${cmd}`);
  }

  private handleRespawn(session: Session): void {
    if (!session.dead) return;
    session.dead = false;
    session.health = PLAYER_MAX_HEALTH;
    const [sx, sz] = this.findLandSpawn();
    session.physics.setSpawn(sx, this.findSpawnEyeY(sx, sz), sz);
    session.air.reset();
    session.lavaTimer = 0;
    session.fireTimer = 0;
    session.fireTicksLeft = 0;
    session.fireTickTimer = 0;
    session.onFire = false;
  }

  /** Snapshot a connected player to storage. Called on disconnect (always) and on a slow cadence while they're online. */
  private savePlayer(session: Session): void {
    const p = session.physics.state.position;
    const record: PlayerRecord = {
      slots: session.inventory,
      selectedIndex: session.selectedSlot,
      armor: session.armor,
      health: session.health,
      x: p.x, y: p.y, z: p.z,
      yaw: session.yaw, pitch: session.pitch,
    };
    // The in-memory map has to move in step with storage, not just at wake-up:
    // onJoin reads from it, so a player who disconnects and comes back inside
    // the same DO lifetime would otherwise be restored from the stale record
    // loaded at startup - and then have their real progress overwritten by the
    // next save. (`slots` aliases the live inventory array, which keeps the
    // map current between saves; storage.put serialises a snapshot.)
    this.playerSaves.set(playerKey(session.name), record);
    void this.state.storage.put(playerKey(session.name), record);
  }

  private saveFurnaces(): void {
    void this.state.storage.put(FURNACES_KEY, [...this.furnaces.entries()]);
  }

  /** Everyone still in play: a dead player waiting on the death screen isn't a target for mobs or arrows, and can't vacuum items up off the ground. */
  private livePlayers(): { id: number; pos: THREE.Vector3 }[] {
    const out: { id: number; pos: THREE.Vector3 }[] = [];
    for (const session of this.sessions.values()) {
      if (session.dead) continue;
      out.push({ id: session.id, pos: session.physics.state.position });
    }
    return out;
  }

  private sessionById(playerId: number): Session | null {
    for (const session of this.sessions.values()) {
      if (session.id === playerId) return session;
    }
    return null;
  }

  /** Case-insensitive name lookup, for /kick, /ban and /mute - `null` if that player isn't currently connected (a name-only ban/mute still records, see handleChatCommand). */
  private sessionByName(name: string): Session | null {
    const lower = name.toLowerCase();
    for (const session of this.sessions.values()) {
      if (session.name.toLowerCase() === lower) return session;
    }
    return null;
  }

  /** `/ban`'s and `/mute`'s shared "is this name still under its expiry" check - lazily lifts (map + storage) whichever one has expired instead of waiting for a separate sweep, since the only two places that ever need the answer (onJoin, chat) already check it on demand. */
  private isRestricted(map: Map<string, number>, prefix: 'ban' | 'mute', name: string): boolean {
    const lower = name.toLowerCase();
    const expiry = map.get(lower);
    if (expiry === undefined) return false;
    if (Date.now() < expiry) return true;
    map.delete(lower);
    void this.state.storage.delete(`${prefix}:${lower}`);
    return false;
  }

  private isBanned(name: string): boolean {
    return this.isRestricted(this.bannedNames, 'ban', name);
  }

  private isMuted(name: string): boolean {
    return this.isRestricted(this.mutedNames, 'mute', name);
  }

  /** 'sigmafes' (case-insensitive) is the hardcoded, non-persisted owner override - see PlayerRank's own doc comment. Everyone else's rank comes from playerRanks, defaulting to 'User'. */
  private rankOf(name: string): 'sigmafes' | PlayerRank {
    const lower = name.toLowerCase();
    if (lower === OWNER_NAME) return 'sigmafes';
    return this.playerRanks.get(lower) ?? 'User';
  }

  /** Admin or the owner - the permission level both control/tp blocks require to place, break, or configure, and that lets a zone's grief flag be bypassed. */
  private isAdminOrOwner(name: string): boolean {
    const rank = this.rankOf(name);
    return rank === 'sigmafes' || rank === 'Admin';
  }

  /**
   * Rebuilds `controlZones` from every placed CONTROL_BLOCK cell currently
   * in `this.edits`, grouped by their BlockData.controlId. A group needs at
   * least 2 members to actually form a zone - a single placed-but-unpaired
   * control block (or a freshly placed one with no controlId set at all
   * yet) contributes nothing. 3+ sharing the same id is a misconfiguration
   * (not something the /control UI can even produce, since it only ever
   * links two at a time) - only the first two found are used, silently.
   * Called after anything that could change the answer: placing/breaking a
   * control block (setBlock) or configuring one (handleControlBlockSet).
   */
  private rebuildControlZones(): void {
    const byId = new Map<number, { x: number; z: number; flags: ControlFlags }[]>();
    for (const [key, id] of this.edits) {
      if (id !== BlockId.CONTROL_BLOCK) continue;
      const data = this.blockData.get(key);
      if (data?.controlId == null) continue;
      const [x, , z] = key.split(',').map(Number);
      const list = byId.get(data.controlId) ?? [];
      list.push({ x, z, flags: data.controlFlags ?? defaultControlFlags() });
      byId.set(data.controlId, list);
    }
    this.controlZones = [];
    for (const points of byId.values()) {
      if (points.length < 2) continue;
      const [a, b] = points;
      this.controlZones.push({
        minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
        minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z),
        ...a.flags,
      });
    }
  }

  /** The active zone (if any) covering this XZ column, every Y - see controlZones' own doc comment. `null` outside every zone. */
  private controlZoneAt(x: number, z: number): (ControlFlags & { minX: number; maxX: number; minZ: number; maxZ: number }) | null {
    for (const zone of this.controlZones) {
      if (x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ) return zone;
    }
    return null;
  }

  /**
   * Parses a /ban or /mute duration argument (`10m`, `2h`, `3d`, case-
   * insensitive) into an absolute expiry epoch-ms timestamp - `undefined`
   * (no argument at all) means permanent (Infinity), matching how /ban and
   * /mute always worked before timed durations existed. Returns `null` for
   * a present-but-malformed argument, so the caller can tell "no duration
   * given" apart from "duration given wrong" and reply accordingly.
   */
  private parseDuration(arg: string | undefined): number | null {
    if (arg === undefined) return Infinity;
    const match = arg.match(/^(\d+)([mhd])$/i);
    if (!match) return null;
    const amount = parseInt(match[1], 10);
    const unitMs = match[2].toLowerCase() === 'm' ? 60_000 : match[2].toLowerCase() === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() + amount * unitMs;
  }

  /** Only WATER/LAVA carry a spread distance worth sending - see protocol.ts's blockChanged doc comment. `undefined` for every other block, including AIR, so the client can tell "not a liquid" apart from "a liquid at distance 0" (a real, meaningful value). */
  private waterDistanceFor(id: BlockId, x: number, y: number, z: number): number | undefined {
    if (id === BlockId.WATER) return this.water.getWaterDistance(x, y, z);
    if (id === BlockId.LAVA) return this.lava.getWaterDistance(x, y, z);
    return undefined;
  }

  /**
   * The low-level block write: persist, broadcast, and keep the FIRE engine's
   * cell list in step (a flame washed away by a flow has to stop being
   * tracked, or it would burn forever with no block behind it).
   *
   * Deliberately does NOT tell the water/lava engines about the change, even
   * though they call this constantly - `onBlockPlaced` means "a SOURCE was
   * placed here", so notifying from inside the write would turn every
   * flowing cell the engine itself lays down into a new source and flood the
   * world. Player-initiated placement goes through setBlockFromPlayer()
   * instead. This is the same split singleplayer keeps between World.setBlock
   * and World.place.
   */
  private setBlock(x: number, y: number, z: number, id: BlockId, silent = false, data?: BlockData): void {
    // Read before the edit overwrites it - leaf decay needs to know what
    // USED to be here (was it a log?), same as world.ts's remove() capturing
    // oldBlock before blockStore.removeBlockRaw().
    const oldId = this.getBlockAt(x, y, z);
    const key = `${x},${y},${z}`;
    this.edits.set(key, id);
    void this.state.storage.put(`edit:${key}`, id);
    // Same split as world.ts's setBlockData/remove: a block that needs
    // orientation gets a fresh entry, anything else (including a plain
    // re-placement over a cell that USED to be oriented, e.g. a stair
    // getting mined and replaced by dirt) drops whatever was there before -
    // never carry stale facing/half/axis data into an unrelated block.
    if (data) {
      this.blockData.set(key, data);
      void this.state.storage.put(`blockdata:${key}`, data);
    } else if (this.blockData.has(key)) {
      this.blockData.delete(key);
      void this.state.storage.delete(`blockdata:${key}`);
    }
    this.broadcast({ type: 'blockChanged', x, y, z, blockId: id, waterDistance: this.waterDistanceFor(id, x, y, z), silent, data });
    if (id === BlockId.FIRE) this.fire.onFirePlaced(x, y, z);
    else this.fire.onFireRemoved(x, y, z);
    if (id === BlockId.WATER || id === BlockId.LAVA) this.resolveLiquidInteractionAt(x, y, z);
    // Same split as world.ts's add()/remove(): placing leaves starts
    // watching them, removing ANY block stops watching it (a no-op if it
    // wasn't leaves), and removing a log re-checks every leaf that could now
    // be orphaned within LeavesManager's own RANGE.
    if (id === BlockId.OAK_LEAVES) {
      this.leaves.addLeaf(x, y, z);
    } else if (id === BlockId.AIR) {
      this.leaves.removeLeaf(x, y, z);
      if (oldId === BlockId.OAK_LOG) this.leaves.onLogRemoved(x, y, z, (bx, by, bz) => this.getBlockAt(bx, by, bz));
    }
    // A control block appearing, disappearing, or being overwritten by
    // something else all change the answer controlZoneAt() gives - see its
    // own doc comment for why a full rebuild is cheap enough here.
    if (id === BlockId.CONTROL_BLOCK || oldId === BlockId.CONTROL_BLOCK) this.rebuildControlZones();
    if (oldId === BlockId.MESSAGE_BLOCK && id !== BlockId.MESSAGE_BLOCK) this.messageBlockTimers.delete(key);
  }

  /**
   * Water meeting lava turns the lava to stone - obsidian if it was a source,
   * cobblestone if it was just a flow. Without this the two liquids would
   * simply flow through each other, since neither engine knows the other
   * exists. Ported from singleplayer's World.resolveLiquidInteractionAt; the
   * Fizz sound it also plays there is client-side and has no equivalent here.
   */
  private resolveLiquidInteractionAt(x: number, y: number, z: number): void {
    const current = this.getBlockAt(x, y, z);
    if (current !== BlockId.WATER && current !== BlockId.LAVA) return;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const neighbor = this.getBlockAt(nx, ny, nz);
      const touchesOpposingLiquid = (current === BlockId.WATER && neighbor === BlockId.LAVA)
        || (current === BlockId.LAVA && neighbor === BlockId.WATER);
      if (!touchesOpposingLiquid) continue;

      const lavaX = current === BlockId.LAVA ? x : nx;
      const lavaY = current === BlockId.LAVA ? y : ny;
      const lavaZ = current === BlockId.LAVA ? z : nz;
      const replacement = this.lava.isSource(lavaX, lavaY, lavaZ) ? BlockId.OBSIDIAN : BlockId.COBBLESTONE;
      this.lava.clearAt(lavaX, lavaY, lavaZ);
      this.setBlock(lavaX, lavaY, lavaZ, replacement);
    }
  }

  /** A block a PLAYER placed or broke: same write as setBlock, plus telling the fluid engines a source appeared or disappeared here. */
  private setBlockFromPlayer(x: number, y: number, z: number, id: BlockId, data?: BlockData): void {
    this.setBlock(x, y, z, id, false, data);
    if (id === BlockId.AIR) {
      this.water.onBlockRemoved(x, y, z);
      this.lava.onBlockRemoved(x, y, z);
    } else {
      this.water.onBlockPlaced(x, y, z, id);
      this.lava.onBlockPlaced(x, y, z, id);
    }
  }

  /** Same threshold day-night-cycle.ts's own isNight() uses (skyDarken past half the night's max) - drives mob-spawning.ts's day/night gate. */
  private isNight(): boolean {
    return this.lastSkyDarken > NIGHT_SKY_DARKEN / 2;
  }

  /**
   * Approximate brightness (0..15) at a cave column, for game/mob-spawning.ts
   * to gate hostile spawns near a torch. NOT real light propagation - this
   * server has no per-voxel light engine at all, lighting has only ever been
   * a client rendering concern until now. This is just the strongest known
   * emissive EDITED block within reach, faded by straight-line (Chebyshev)
   * distance rather than a real flood-fill that stops at corners - good
   * enough to keep hostiles out of a lit room, not pixel-identical to what
   * the client would render. Only scans `edits` (bounded by how much of the
   * world has actually been touched), and only runs when a cave spawn slot
   * is empty and off cooldown - not every tick.
   */
  private approxBrightnessAt(x: number, y: number, z: number): number {
    let best = 0;
    for (const [key, id] of this.edits) {
      const emission = blockLightProperties[id].emission;
      if (emission <= 0) continue;
      const [ex, ey, ez] = key.split(',').map(Number);
      const dist = Math.max(Math.abs(ex - x), Math.abs(ey - y), Math.abs(ez - z));
      if (dist > emission) continue;
      const level = emission - dist;
      if (level > best) best = level;
    }
    return best;
  }

  private isSolidAt(x: number, y: number, z: number): boolean {
    const edit = this.edits.get(`${x},${y},${z}`);
    // Same isSolidBlock() terrain.isSolid() already uses for generated
    // terrain (terrain.ts:60-64) - `edit !== AIR` alone treated any edited
    // non-air block as solid, including water/lava/fire/torches (all in
    // block.ts's NON_SOLID_BLOCKS), so a player-PLACED liquid or a
    // fire-spread edit was solid like stone while the same block straight
    // out of world generation wasn't.
    if (edit !== undefined) return isSolidBlock(edit);
    return this.terrain!.isSolid(x, y, z);
  }

  /** The actual BlockId at a position - edits first, generated terrain otherwise. Same priority as isSolidAt/isWaterAt, just returning the id instead of a boolean (handleBreakBlock needs to know exactly what was broken to roll the right drop). */
  private getBlockAt(x: number, y: number, z: number): BlockId {
    const edit = this.edits.get(`${x},${y},${z}`);
    if (edit !== undefined) return edit;
    return this.terrain!.getBlock(x, y, z);
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

}

/** Small deterministic string hash - same worldId always derives the same terrain seed. */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

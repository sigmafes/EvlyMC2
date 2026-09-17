import type { BlockId } from '../block';
import type { InventorySlot } from '../inventory';
import type { MobKind } from '../mob-manager';
import type { FurnaceState, ChestState, BlockData } from '../block-data';

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

export const PROTOCOL_VERSION = 2;

export type Vec3 = { x: number; y: number; z: number };

/**
 * One end of an inventory move (`invPickUp`/`invPlace`, and the older
 * `craftMove`): which slot "array", and the index within it. Spelled out
 * rather than encoded as offset index ranges so a stray index can't
 * silently mean "some inventory slot". `furnaceInput`/`furnaceFuel` address
 * the currently-open furnace's own two placeable slots (see world-do.ts's
 * Session.openFurnace) - `index` is unused/0 for those, there's only one of
 * each. The furnace's output slot isn't addressable here at all: it's
 * take-only, still handled by the older, simpler `furnaceTakeOutput`.
 * `chest` addresses the currently-open chest's 27 slots by `index` (0..26) -
 * unlike the furnace, a chest has no special per-slot semantics (anything
 * goes anywhere), so it rides the exact same generic invPickUp/invPlace/
 * invCancel messages instead of needing its own chestInsert/chestTake pair.
 * `armor` addresses the player's own 4 permanent armor slots (index 0..3 =
 * helmet/chestplate/leggings/boots, LCE's own ArmorItem slot order) - always
 * open, no armorOpen/Close pair needed. Each index only accepts its own
 * piece (armorSlotFor()), enforced server-side in handleInvPlace.
 */
export type CraftSlotRef = { zone: 'inventory' | 'grid' | 'furnaceInput' | 'furnaceFuel' | 'chest' | 'armor'; index: number };

/**
 * An item lying on the ground (Fase 1 del plan de porteo): what a broken block
 * or a Q-thrown stack leaves behind until someone walks over it. Deliberately
 * NOT an `EntitySnapshot` - it has no health/yaw/fire/dying, and the client
 * renders it as a spinning item mesh rather than as a body, so sharing that
 * shape would mean four meaningless fields on every ground item every tick.
 *
 * The server owns position and pickup; the spin and idle bob are cosmetic and
 * computed client-side from `entityId`/local time, never sent over the wire.
 */
/**
 * An arrow in flight or stuck in a block. Like DroppedItemSnapshot this is
 * deliberately not an `EntitySnapshot` - an arrow has no health, doesn't burn
 * and can't die, so it would carry four meaningless fields every tick.
 *
 * `yaw`/`pitch` come precomputed rather than as a velocity vector: the client
 * only needs to point the mesh, and an arrow that has embedded in a wall has
 * no velocity left to derive a heading from.
 */
export type ArrowSnapshot = {
  entityId: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
};

export type DroppedItemSnapshot = {
  /** Server-assigned, stable for this item's whole lifetime - the client keys its meshes by it. */
  entityId: number;
  /** BlockId (1..23) or ItemId (100+) - same numbering `InventorySlot.id` uses. */
  itemId: number;
  count: number;
  pos: Vec3;
};

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
  /** Only present for kind:'player' - look pitch, so PlayerModel.setOrientation() can tilt their head up/down for everyone else, not just the local client's own body. */
  pitch?: number;
  /** Only present for kind:'player' - drives PlayerModel.setSneaking()/updateSneak() for everyone else. */
  sneaking?: boolean;
  /** Only present for kind:'player' - the selected hotbar slot's item/block id (or null for empty), drives PlayerModel.setHeldItem() for everyone else. */
  heldItem?: number | null;
  /** Only meaningful for a ranged hostile (skeleton) - sighted+in-range and about to/already shooting, drives BipedMobModel.setAttacking()'s bow-draw pose for everyone else. */
  aiming?: boolean;
  /** Only present for kind:'player' - [helmet, chestplate, leggings, boots] item ids (null = empty), drives PlayerModel.setArmor() for everyone else. */
  armor?: (number | null)[];
};

// --- Client -> Server --------------------------------------------------

export type ClientMessage =
  | {
      type: 'join'; worldId: string; protocolVersion: number;
      /**
       * Signed proof of which account this is, issued by the access worker at
       * login (see net/auth-token.ts). The server takes the player's name
       * from INSIDE this token - there is no client-supplied name any more,
       * because a name the client picks is a name anyone can pick, and the
       * player's saved inventory hangs off it.
       */
      token: string;
      /** The 64x64 skin PNG this client currently has selected (player-skin.ts),
       * as a data: URL - `null`/absent if using the built-in default. Sent once
       * at join, not kept in sync afterward (see world-do.ts's onJoin doc
       * comment): changing skin mid-session in another player's view is a
       * real follow-up, not something this first pass covers. */
      skin?: string | null;
      /** This client's slim/classic arm setting (settings.ts's `alexSkin`) - true = slim. Same "sent once at join" treatment as `skin` above, relayed to everyone else via `playerSkin` so remote players actually render with the arm width the owner picked instead of always classic. */
      slim?: boolean;
      /** settings.ts's `selectedCape` (a cape.ts CapeOption id, or null/absent for none) - trusted at face value like `skin`/`slim` above (purely cosmetic, only affects how the sender's OWN avatar renders to others). The server does not re-check cape.ts's allowlist against the sender's name; every other client already gates cape visibility on isCapeAllowed(name) itself, same as it always has. */
      cape?: string | null;
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
      /** Eating or drawing the bow (client-computed, same "eating || bowDrawStart" check driving the local hand pose) - caps movement at crouch speed and overrides sprint server-side, same treatment PlayerPhysics.updatePhysics's speedRestricted param already gives singleplayer. */
      restricted: boolean;
      yaw: number;
      pitch: number;
      dtMs: number; // this input's own client-side frame delta, so the server advances physics by the same amount the client predicted
    }
  /**
   * Player started mining this block, with whatever's in their currently
   * SELECTED slot at this instant - the server captures that item and holds
   * it fixed for the whole dig (switching hotbar slots mid-swing doesn't
   * speed up or slow down an already-started dig, matching singleplayer's
   * own interaction.ts, which only reads the selected item once in
   * startMining()). Re-sending this for a new position retargets. Server-
   * side there's still nothing to clean up on an abandoned dig (it just sits
   * unused until overwritten or the block changes) - but it now also
   * broadcasts `entityBreakStart` to everyone else, purely so their client
   * can show the same crack overlay/chip sound on this block that only the
   * digging player themself saw before.
   */
  | { type: 'breakStart'; x: number; y: number; z: number }
  /** Gave up on the current dig without finishing it (released the mouse/let go early) - `breakStart` alone left every OTHER client's crack overlay on this block stuck forever, since only a completed `breakBlock` (via the resulting `blockChanged`) ever cleared it otherwise. Purely cosmetic, see `entityBreakCancel`. */
  | { type: 'breakCancel' }
  /**
   * Player finished the dig animation client-side and wants it applied.
   * `x/y/z` must match the position from the most recent `breakStart`, and
   * enough real time must have passed since then (see world-do.ts's
   * handleBreakBlock) - the server re-derives the dig duration itself from
   * breakTime() using the item captured at breakStart, it never trusts a
   * claimed elapsed time or believes a `breakBlock` with no matching
   * `breakStart` at all.
   */
  | { type: 'breakBlock'; x: number; y: number; z: number }
  /**
   * `normal` is the clicked face's world-space normal (one of the 6
   * axis-aligned unit vectors), `clickY` is the click point's fractional
   * height within that face's cell (`point.y - (existingBlockY - 0.5)`, same
   * value src/block-placement-rules.ts's placedHalfIsTop derives from
   * RaycastHit), and `yaw` is the player's look yaw at the moment of the
   * click - together the exact inputs block-placement-rules.ts needs to
   * orient a stair/slab/log/torch/furnace the same way singleplayer does.
   * `blockId` is only ever used for the flint-and-steel special case
   * (world-do.ts's handlePlaceBlock always places whatever is actually in
   * the player's selected slot otherwise).
   */
  | { type: 'placeBlock'; x: number; y: number; z: number; blockId: BlockId; normal: Vec3; clickY: number; yaw: number }
  | { type: 'selectSlot'; index: number }
  | { type: 'useItem'; slotIndex: number }
  /** Right-click-to-equip (LCE ArmorItem::useOn) - swaps the player's currently SELECTED hotbar item into its matching armor slot if it actually is armor, whatever was there going back to the hotbar. A no-op if the selected item isn't armor. */
  | { type: 'quickEquipArmor' }
  /** Q - throws the selected hotbar slot's item(s) out in front of the player as a real ground entity (DroppedItemSnapshot), same as singleplayer's own Q. `dir` is the player's look direction, used for the throw arc; the server clamps/normalises it itself. `all` mirrors singleplayer's interaction.ts onDropSelected(ctrlKey): false (plain Q) drops a single item, true (Ctrl+Q) drops the whole stack. */
  | { type: 'dropItem'; dir: Vec3; all: boolean }
  /**
   * Craft one of the recipes the server last told this client it can
   * afford (`craftableRecipes`) - `recipeIndex` is RECIPES' own array
   * index (src/crafting.ts), re-validated server-side on arrival rather
   * than trusted (see world-do.ts's handleCraft doc comment). This is the
   * shortcut list, kept alongside the real grid below: it pulls ingredients
   * from wherever they're stacked instead of from cells you arranged.
   */
  | { type: 'craft'; recipeIndex: number }
  /** Open a crafting grid: `table` is the position of a crafting table for the 3x3, or null for the 2x2 you carry with you. */
  | { type: 'craftOpen'; table: { x: number; y: number; z: number } | null }
  /** Close it. Anything left in the cells goes back to the inventory rather than being destroyed - see world-do.ts's closeCraftGrid. */
  | { type: 'craftClose' }
  /**
   * Move/merge one stack within the open grid, between the grid and the
   * inventory, or within the inventory - the same self-contained, cursor-free
   * move `moveSlot` uses, just with a zone on each end so it can cross
   * between the two. Same-id stacks merge, otherwise the two cells swap.
   */
  | { type: 'craftMove'; from: CraftSlotRef; to: CraftSlotRef }
  /** Take the result: consumes one item from every occupied input cell, exactly like singleplayer's CraftingGrid.consumeCraft(). Unlike singleplayer's cursor-drag UI, this already goes straight into the hotbar/backpack every click (handleCraftTakeOutput) - multiplayer never grew the held-cursor step for this slot, so there's no separate shift-click behaviour to add here. */
  | { type: 'craftTakeOutput' }
  /**
   * Cursor-follows-mouse inventory interaction, same model as singleplayer's
   * Inventory class (pickUpFrom/placeHeld/depositOne) - just server-held
   * instead of client-held, since this inventory is server-authoritative.
   * `session.heldItem` (world-do.ts) is the equivalent of that class's own
   * `heldItem`/`heldFrom` fields; `invHeld` below echoes it back so the
   * client can draw the cursor-following ghost with the right icon/count.
   *
   * - Left click empty-handed -> `invPickUp` with `half: false` (whole stack).
   * - Right click empty-handed -> `invPickUp` with `half: true` (half the
   *   stack, rounded up - onSlotRightClick's exact rule).
   * - Left click while holding -> `invPlace` with `one: false` (merge into a
   *   same-id stack, or swap if the target holds something else).
   * - Right click while holding, or dragging with the right button held
   *   across several slots (one deposit per new slot entered) -> `invPlace`
   *   with `one: true` each time (depositOne's exact rule).
   * - `invCancel`: put the held stack back where it came from (merging if
   *   it fits), for a right-click on empty space, or the panel closing.
   */
  | { type: 'invPickUp'; from: CraftSlotRef; half: boolean }
  | { type: 'invPlace'; to: CraftSlotRef; one: boolean }
  | { type: 'invCancel' }
  /** Backpack (E) slot click: move/merge whatever is in `from` into `to` - same-id stacks merge (up to maxStack, leftover stays in `from`), otherwise the two slots swap. Both are indices into the same 36-slot inventory (0..8 hotbar, 9..35 backpack) - there's no separate "held item cursor" state to track over the network, each click is a complete, self-contained move. */
  | { type: 'moveSlot'; from: number; to: number }
  /** Right-clicking a placed furnace block opens its GUI - the server starts including this position in the periodic `furnaceState` pushes to this session (see world-do.ts's Session.openFurnace) until furnaceClose. */
  | { type: 'furnaceOpen'; x: number; y: number; z: number }
  | { type: 'furnaceClose' }
  /** Moves the player's currently SELECTED hotbar slot's whole stack into that furnace's input or fuel slot (merging if it already holds the same item) - simplified from a real per-slot drag the same way the craft menu simplifies the crafting grid (see protocol.ts's `craft` doc comment). */
  | { type: 'furnaceInsert'; x: number; y: number; z: number; target: 'input' | 'fuel' }
  /** Collects the furnace's finished output stack into the player's inventory - same "always straight to inventory, no cursor step" simplification as `craftTakeOutput`. */
  | { type: 'furnaceTakeOutput'; x: number; y: number; z: number }
  /** Right-clicking a placed chest opens its GUI - the server starts including this position in the periodic `chestState` pushes to this session (see world-do.ts's Session.openChest) until chestClose. */
  | { type: 'chestOpen'; x: number; y: number; z: number }
  | { type: 'chestClose' }
  /** Melee swing at an entity: negative ids are mobs, positive ones other players (PvP - see world-do.ts's spawn-protection check). */
  | { type: 'attack'; targetId: number }
  /**
   * Purely cosmetic arm-swing cue (mining chip, or a swing at an entity/thin
   * air with nothing to hit) - `attack`/`breakBlock` already cover the real
   * gameplay actions; this exists ONLY so every OTHER client can play the
   * same third-person swing animation the sender is already playing
   * locally, since neither of those messages reaches anyone but the server.
   * Trusted at face value (no reach/cooldown check) - it can't do anything
   * but animate a model, the same trust level as look direction.
   */
  | { type: 'swing' }
  /** Leave the death screen. The server holds a dead player frozen at 0 health until this arrives, rather than respawning them the instant they die. */
  | { type: 'respawn' }
  /** Release the bow: `power` is the draw (0..1) and `dir` the look direction. The server checks the player actually has an arrow, spends it, and spawns a real projectile (see world-do.ts's handleShootBow). */
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
      /** `air`: breath left as bubble points (0..10, see player-air.ts) - 10 means "not submerged / full", which is when the client hides the bar entirely. */
      self: { pos: Vec3; velocity: Vec3; yaw: number; pitch: number; grounded: boolean; health: number; air: number; onFire: boolean };
      entities: EntitySnapshot[];
      /** Items currently lying on the ground (see DroppedItemSnapshot). Sent in full every tick like `entities` - the same interest-management caveat applies. */
      droppedItems: DroppedItemSnapshot[];
      /** Arrows in flight or embedded in blocks (see ArrowSnapshot). */
      arrows: ArrowSnapshot[];
    }
  /** Sparse block edits for one chunk - same [localIndex, blockId] shape chunk-edits.ts already persists, just shipped instead of read from IndexedDB. */
  | { type: 'chunkData'; cx: number; cz: number; edits: [index: number, blockId: BlockId][] }
  /**
   * `waterDistance` is only meaningful (and only ever sent non-undefined)
   * when `blockId` is WATER or LAVA - the server's own WaterEngine/
   * LavaEngine's MCPE-style spread distance (0 = source) at this cell,
   * mirroring src/water-engine.ts's `WaterNode.distance`. The client has no
   * simulation of its own (the server owns it - see world-do.ts's
   * fluidWorld doc comment), so without this every liquid cell would mesh
   * as a flat full block instead of getting the sloped "menisco" corner
   * heights singleplayer's own World.getLiquidDistance() feeds its chunk
   * mesher.
   *
   * `silent`, when true, tells the client to skip the dig/place sound and
   * break-particle puff it would otherwise play for this change - for a
   * change that was never a player action (leaf decay - singleplayer's own
   * decay, driven from world.ts's tick loop, was never wired to a sound
   * either) or that's catch-up history rather than something happening
   * right now (the backlog of edits replayed on join). Absent/false plays
   * the sound normally, same as before this field existed.
   */
  /** `data` carries orientation (facing/half/axis, see block-data.ts's BlockData) for a block that needs it - a placed stair/slab/log/torch/furnace, or unset for anything that renders the same regardless of orientation. Omitted (not just undefined) whenever there's nothing to say, to keep the common case's payload small. */
  | { type: 'blockChanged'; x: number; y: number; z: number; blockId: BlockId; waterDistance?: number; silent?: boolean; data?: BlockData }
  | { type: 'inventoryUpdate'; slots: InventorySlot[]; selectedIndex: number; armor: InventorySlot[] }
  | { type: 'entityRemoved'; id: number; reason: 'death' | 'despawn' | 'disconnect' }
  /** Someone else's cosmetic swing cue (see the `swing` client message) - `id` is a player session id, never a mob's (mobs already animate their own attacks from EntitySnapshot state, they don't send this). Never echoed back to the sender, who already played it locally the instant they sent it. */
  | { type: 'entitySwing'; id: number }
  /** Someone else started mining this block (`swing`'s sibling for the crack overlay/chip sound instead of the arm) - `totalMs` is the server-derived real dig duration (breakTime()), so the bystander's overlay tracks the same pace as the real dig instead of guessing one. Never echoed back to the sender, who already ran this locally. */
  | { type: 'entityBreakStart'; id: number; x: number; y: number; z: number; totalMs: number }
  /** Someone else's dig from the last `entityBreakStart` was abandoned before finishing - clear their crack overlay. A dig that actually COMPLETES doesn't need this: the resulting `blockChanged` already removes the block, and the bystander's own overlay timer runs out around the same moment regardless. */
  | { type: 'entityBreakCancel'; id: number }
  /** Another player's skin - sent once when they join (and replayed for every already-connected player right after `welcome`, so a client catches up on everyone already in the world). `skin: null` means the built-in default. `slim` is their arm-width setting (see the `join` client message's own doc comment) - absent/false means classic. */
  | { type: 'playerSkin'; playerId: number; skin: string | null; slim?: boolean; cape?: string | null }
  /** Someone else started eating - purely cosmetic (see `entitySwing`'s trust reasoning): drives the same crumb-particle burst at their mouth that the sender already shows itself locally, so eating actually looks like eating to everyone else in mp instead of just a silent chew animation. `itemId` picks which food's texture the crumbs use. Broadcast once when the bite starts (world-do.ts's handleUseItem), not repeated per bite tick. */
  | { type: 'entityEat'; id: number; itemId: number }
  /** Resyncs the client's local day/night clock to the server's authoritative one (day-night-math.ts) - sent whenever the integer skyDarken step changes (so a transition starts on every client at the same moment) and periodically besides, to correct any drift in a client that free-runs the clock locally between corrections (see multiplayer-game.ts). */
  | { type: 'dayTime'; elapsed: number }
  /** Every RECIPES (src/crafting.ts) index this player currently has ingredients for, sent whenever the inventory changes - drives the craft menu's list (see multiplayer-game.ts). `out` is included so the client can render the result icon without needing its own copy of RECIPES. */
  | { type: 'craftableRecipes'; recipes: { index: number; out: { id: number; count: number } }[] }
  /** Pushed periodically (every tick, while the session has this furnace open via furnaceOpen) so the GUI's cook/fuel gauges animate smoothly - see world-do.ts's Session.openFurnace. */
  | { type: 'furnaceState'; x: number; y: number; z: number; state: FurnaceState }
  /** Same idea as `furnaceState`, pushed every tick while the session has this chest open via chestOpen (see world-do.ts's Session.openChest). */
  | { type: 'chestState'; x: number; y: number; z: number; state: ChestState }
  /** Someone else opened/closed this chest - cosmetic-only lid animation cue for every other client (see the `swing`/`entitySwing` doc comment for the trust reasoning), never echoed back to whoever actually sent chestOpen/chestClose. */
  | { type: 'entityChestOpen'; x: number; y: number; z: number }
  | { type: 'entityChestClose'; x: number; y: number; z: number }
  /**
   * The open crafting grid's contents and what they currently make. Pushed on
   * every change rather than polled, same as the furnace. `output` is derived
   * server-side by matchRecipe(), so the client renders the result without
   * needing its own copy of the recipe list or the shape-matching rules.
   * `side` is 2 or 3; `inputs` is always side*side long.
   */
  | { type: 'craftGridState'; side: 2 | 3; inputs: InventorySlot[]; output: InventorySlot }
  /** The grid was closed (by the player, or because they walked away from the table). */
  | { type: 'craftGridClosed' }
  /** Echoes `session.heldItem` (see invPickUp/invPlace/invCancel's doc comment) - `null` when nothing is held, so the client's cursor-following ghost knows what to draw and when to hide. */
  | { type: 'invHeld'; item: InventorySlot | null }
  /** The selected tool just broke from durability (mining/attacking/shooting a bow enough times - see src/tools.ts's maxDurability). Purely a "play the break sound" cue for the client, same as singleplayer's own local Inventory.damageSelected() return value triggering it directly - the slot itself already went empty in the `inventoryUpdate` sent alongside this. */
  | { type: 'toolBroke' }
  /**
   * You died. The server freezes this player at 0 health - no physics, no
   * input, untargetable - until they send `respawn`, rather than teleporting
   * them back instantly, so there's actually a death screen to show.
   * `killedBy` is the other player's name for a PvP kill, absent otherwise.
   */
  | { type: 'died'; killedBy?: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number };

/** Narrow an unknown decoded payload to a ClientMessage by its `type` tag - use on the server after `JSON.parse`ing a raw WebSocket frame. */
export function isClientMessageType(type: string): type is ClientMessage['type'] {
  return (
    [
      'join', 'input', 'breakStart', 'breakBlock', 'placeBlock', 'selectSlot', 'useItem', 'quickEquipArmor', 'dropItem', 'craft', 'moveSlot',
      'craftOpen', 'craftClose', 'craftMove', 'craftTakeOutput',
      'invPickUp', 'invPlace', 'invCancel',
      'furnaceOpen', 'furnaceClose', 'furnaceInsert', 'furnaceTakeOutput',
      'chestOpen', 'chestClose',
      'attack', 'swing', 'breakCancel', 'respawn', 'shootBow', 'chat', 'ping',
    ] as const
  ).includes(type as ClientMessage['type']);
}

/** Same idea for the client, decoding a frame from the server. */
export function isServerMessageType(type: string): type is ServerMessage['type'] {
  return (
    [
      'welcome', 'rejected', 'state', 'chunkData', 'blockChanged',
      'inventoryUpdate', 'entityRemoved', 'entitySwing', 'entityBreakStart', 'entityBreakCancel', 'playerSkin', 'entityEat', 'dayTime', 'craftableRecipes', 'furnaceState', 'chestState', 'entityChestOpen', 'entityChestClose',
      'craftGridState', 'craftGridClosed', 'invHeld', 'toolBroke', 'died', 'chat', 'pong',
    ] as const
  ).includes(type as ServerMessage['type']);
}

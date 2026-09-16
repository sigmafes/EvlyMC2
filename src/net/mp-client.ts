import { PROTOCOL_VERSION, isServerMessageType, type ClientMessage, type ServerMessage } from './protocol';
import type { InventorySlot } from '../inventory';
import type { FurnaceState } from '../block-data';

export type MpClientHandlers = {
  onWelcome: (msg: Extract<ServerMessage, { type: 'welcome' }>) => void;
  onRejected: (reason: string) => void;
  onState: (msg: Extract<ServerMessage, { type: 'state' }>) => void;
  onBlockChanged: (msg: Extract<ServerMessage, { type: 'blockChanged' }>) => void;
  onEntityRemoved: (id: number) => void;
  onEntitySwing: (id: number) => void;
  onPlayerSkin: (playerId: number, skin: string | null) => void;
  onDayTime: (elapsed: number) => void;
  onInventoryUpdate: (slots: InventorySlot[], selectedIndex: number) => void;
  onCraftableRecipes: (recipes: { index: number; out: { id: number; count: number } }[]) => void;
  onFurnaceState: (x: number, y: number, z: number, state: FurnaceState) => void;
  onCraftGridState: (side: 2 | 3, inputs: InventorySlot[], output: InventorySlot) => void;
  onCraftGridClosed: () => void;
  onInvHeld: (item: InventorySlot | null) => void;
  onToolBroke: () => void;
  onDied: (killedBy?: string) => void;
  onChat: (from: string, text: string) => void;
  /** Round-trip reply to a `ping` this client sent - `clientTimeMs` is its own value echoed back, so `performance.now() - clientTimeMs` is the RTT. */
  onPong: (clientTimeMs: number, serverTimeMs: number) => void;
  onClose: (reason: string) => void;
};

/**
 * Thin WebSocket wrapper speaking net/protocol.ts - Fase 6 of the
 * multiplayer plan. Pure networking, no THREE/rendering: multiplayer-game.ts
 * owns the scene and calls into this.
 */
export class MpClient {
  private ws: WebSocket | null = null;
  private closedByUs = false;

  /** `token` is the signed proof of which account this is (access-gate.ts's loadPlayToken) - the server reads the player's name out of it, so there's no name to pass. */
  connect(serverUrl: string, worldId: string, token: string, handlers: MpClientHandlers, skin?: string | null): void {
    const ws = new WebSocket(serverUrl);
    this.ws = ws;
    this.closedByUs = false;

    ws.addEventListener('open', () => {
      this.send({ type: 'join', worldId, token, protocolVersion: PROTOCOL_VERSION, skin });
    });

    ws.addEventListener('message', (event) => {
      let msg: ServerMessage;
      try {
        const raw = JSON.parse(String(event.data));
        if (typeof raw?.type !== 'string' || !isServerMessageType(raw.type)) return;
        msg = raw as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'welcome': handlers.onWelcome(msg); break;
        case 'rejected': handlers.onRejected(msg.reason); break;
        case 'state': handlers.onState(msg); break;
        case 'blockChanged': handlers.onBlockChanged(msg); break;
        case 'entityRemoved': handlers.onEntityRemoved(msg.id); break;
        case 'entitySwing': handlers.onEntitySwing(msg.id); break;
        case 'playerSkin': handlers.onPlayerSkin(msg.playerId, msg.skin); break;
        case 'dayTime': handlers.onDayTime(msg.elapsed); break;
        case 'inventoryUpdate': handlers.onInventoryUpdate(msg.slots, msg.selectedIndex); break;
        case 'craftableRecipes': handlers.onCraftableRecipes(msg.recipes); break;
        case 'furnaceState': handlers.onFurnaceState(msg.x, msg.y, msg.z, msg.state); break;
        case 'craftGridState': handlers.onCraftGridState(msg.side, msg.inputs, msg.output); break;
        case 'craftGridClosed': handlers.onCraftGridClosed(); break;
        case 'invHeld': handlers.onInvHeld(msg.item); break;
        case 'toolBroke': handlers.onToolBroke(); break;
        case 'died': handlers.onDied(msg.killedBy); break;
        case 'chat': handlers.onChat(msg.from, msg.text); break;
        case 'pong': handlers.onPong(msg.clientTimeMs, msg.serverTimeMs); break;
        default: break; // chunkData: not used by this client yet
      }
    });

    ws.addEventListener('close', () => {
      if (!this.closedByUs) handlers.onClose('Connection lost');
    });
    ws.addEventListener('error', () => {
      handlers.onClose('Connection error');
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  disconnect(): void {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}

import { PROTOCOL_VERSION, isServerMessageType, type ClientMessage, type ServerMessage } from './protocol';

export type MpClientHandlers = {
  onWelcome: (msg: Extract<ServerMessage, { type: 'welcome' }>) => void;
  onRejected: (reason: string) => void;
  onState: (msg: Extract<ServerMessage, { type: 'state' }>) => void;
  onBlockChanged: (msg: Extract<ServerMessage, { type: 'blockChanged' }>) => void;
  onEntityRemoved: (id: number) => void;
  onPlayerSkin: (playerId: number, skin: string | null) => void;
  onChat: (from: string, text: string) => void;
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

  connect(serverUrl: string, worldId: string, playerName: string, handlers: MpClientHandlers, skin?: string | null): void {
    const ws = new WebSocket(serverUrl);
    this.ws = ws;
    this.closedByUs = false;

    ws.addEventListener('open', () => {
      this.send({ type: 'join', worldId, playerName, protocolVersion: PROTOCOL_VERSION, skin });
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
        case 'playerSkin': handlers.onPlayerSkin(msg.playerId, msg.skin); break;
        case 'chat': handlers.onChat(msg.from, msg.text); break;
        default: break; // chunkData/inventoryUpdate/pong: not used by this first client yet
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

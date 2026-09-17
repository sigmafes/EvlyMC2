import { playClick } from './ui-sound';
import {
  MpServerEntry, loadServers, addServer, updateServer, deleteServer, fetchServerStatus,
} from './mp-servers';

type MpServerListHandlers = {
  /** Connect straight to this server's saved address, no form in the way. */
  onJoin: (url: string) => void;
  /** Open the address+name form for a one-off connection that isn't saved to the list. */
  onDirectConnect: () => void;
  /** Back to the main menu. */
  onCancel: () => void;
};

/** Same handful of colours Minecraft's own default server icon rotates through, picked deterministically from the name so a given server always lands on the same one instead of flickering between screens. */
const ICON_COLORS = ['#4a90d9', '#c0392b', '#27ae60', '#8e44ad', '#d35400', '#16a085', '#c2185b'];

function iconColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return ICON_COLORS[hash % ICON_COLORS.length];
}

/** First letters of up to two words, e.g. "Hypixel Network" -> "HN", "prueba2" -> "PR" - same fallback Minecraft's own launcher uses for a server with no custom icon (which nothing here ever has - there's no icon upload, just this generated one). */
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Minecraft-style "Play Multiplayer" screen: a saved server list (own name,
 * address, MOTD note, live player count + ping) with Join/Direct Connect/
 * Add/Edit/Delete/Refresh - restyled from a single "type a URL" form to
 * match singleplayer's own "Select World" screen (world-select.ts), which
 * this file mirrors structurally.
 */
export class MpServerList {
  private readonly root = document.querySelector<HTMLElement>('#multiplayer-servers')!;
  private readonly listEl = document.querySelector<HTMLElement>('#mp-server-list')!;
  private servers: MpServerEntry[] = [];
  private selectedId: string | null = null;
  /** Live status per server id, filled in as fetchServerStatus() calls resolve - absent means "still checking" (not "offline", see renderList's ping-none case for that). */
  private status = new Map<string, { players: number; pingMs: number } | 'offline'>();

  constructor(private readonly handlers: MpServerListHandlers) {
    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button');
      if (!button) return;
      playClick();
      this.onAction(button.dataset.action ?? '');
    });
  }

  open(): void {
    this.servers = loadServers();
    if (this.selectedId && !this.servers.some((s) => s.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && this.servers.length > 0) this.selectedId = this.servers[0].id;
    this.renderList();
    this.root.hidden = false;
    this.refreshStatus();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private selected(): MpServerEntry | undefined {
    return this.servers.find((s) => s.id === this.selectedId);
  }

  private onAction(action: string): void {
    const current = this.selected();
    switch (action) {
      case 'mp-join':
        if (current) this.handlers.onJoin(current.url);
        break;
      case 'mp-direct':
        this.handlers.onDirectConnect();
        break;
      case 'mp-add': {
        const name = window.prompt('Server name:', '')?.trim();
        if (!name) break;
        const url = window.prompt('Server address (wss://host/world/id):', '')?.trim();
        if (!url) break;
        const entry = addServer({ name, url });
        this.servers = loadServers();
        this.selectedId = entry.id;
        this.renderList();
        this.refreshStatus();
        break;
      }
      case 'mp-edit': {
        if (!current) break;
        const name = window.prompt('Server name:', current.name)?.trim();
        if (!name) break;
        const url = window.prompt('Server address:', current.url)?.trim();
        if (!url) break;
        updateServer(current.id, { name, url });
        this.servers = loadServers();
        this.renderList();
        this.refreshStatus();
        break;
      }
      case 'mp-delete': {
        if (!current) break;
        if (window.confirm(`Delete "${current.name}"?`)) {
          deleteServer(current.id);
          this.status.delete(current.id);
          this.selectedId = null;
          this.servers = loadServers();
          if (this.servers.length > 0) this.selectedId = this.servers[0].id;
          this.renderList();
        }
        break;
      }
      case 'mp-refresh':
        this.refreshStatus();
        break;
      case 'mp-cancel':
        this.hide();
        this.handlers.onCancel();
        break;
    }
  }

  /** Kicks off a fetchServerStatus() for every saved server in parallel - each one repaints just its own row (via a fresh renderList()) as it resolves, rather than waiting for the slowest server to show any of them. */
  private refreshStatus(): void {
    for (const server of this.servers) {
      const id = server.id;
      this.status.delete(id);
      void fetchServerStatus(server.url).then((result) => {
        this.status.set(id, result ?? 'offline');
        if (this.root.hidden) return; // navigated away while this was in flight
        this.renderList();
      });
    }
    this.renderList();
  }

  private pingClass(ms: number): string {
    if (ms < 150) return 'ping-good';
    if (ms < 400) return 'ping-ok';
    return 'ping-bad';
  }

  private renderList(): void {
    this.listEl.replaceChildren();

    if (this.servers.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mp-server-list-empty';
      empty.textContent = 'No servers yet - add one below, or use Direct Connect for a one-off address.';
      this.listEl.append(empty);
    }

    for (const server of this.servers) {
      const row = document.createElement('div');
      row.className = 'mp-server-row';
      row.setAttribute('role', 'option');
      if (server.id === this.selectedId) row.classList.add('selected');

      const icon = document.createElement('div');
      icon.className = 'mp-server-icon';
      icon.style.background = iconColorFor(server.name);
      icon.textContent = initialsFor(server.name);

      const text = document.createElement('div');
      text.className = 'mp-server-row-text';
      const title = document.createElement('div');
      title.className = 'mp-server-row-title';
      title.textContent = server.name;
      const motd = document.createElement('div');
      motd.className = 'mp-server-row-motd';
      motd.textContent = server.motd || 'A EvlyMC Server';
      const addr = document.createElement('div');
      addr.className = 'mp-server-row-addr';
      addr.textContent = server.url;
      text.append(title, motd, addr);

      const status = document.createElement('div');
      status.className = 'mp-server-row-status';
      const result = this.status.get(server.id);
      const playersLine = document.createElement('div');
      const bars = document.createElement('div');
      bars.className = 'mp-ping-bars';
      bars.innerHTML = '<span></span><span></span><span></span><span></span>';
      if (result === 'offline') {
        playersLine.textContent = 'Offline';
        bars.classList.add('ping-none');
      } else if (result) {
        playersLine.textContent = `${result.players} online`;
        bars.classList.add(this.pingClass(result.pingMs));
      } else {
        playersLine.textContent = 'Pinging...';
        bars.classList.add('ping-none');
      }
      status.append(playersLine, bars);

      row.append(icon, text, status);
      row.addEventListener('click', () => {
        this.selectedId = server.id;
        this.renderList();
      });
      row.addEventListener('dblclick', () => this.handlers.onJoin(server.url));

      this.listEl.append(row);
    }

    this.updateButtons();
  }

  private updateButtons(): void {
    const hasSelection = !!this.selected();
    for (const action of ['mp-join', 'mp-edit', 'mp-delete']) {
      const button = this.root.querySelector<HTMLButtonElement>(`.mc-button[data-action="${action}"]`);
      if (button) button.disabled = !hasSelection;
    }
  }
}

/**
 * Saved multiplayer server list - same idea as worlds.ts's WorldMeta list,
 * just for server connections instead of local worlds (see main-menu.ts's
 * "Play Multiplayer" screen, restyled to match Minecraft's own server list).
 */
export type MpServerEntry = {
  id: string;
  /** Player-chosen display name, shown in the list - never fetched from the server itself. */
  name: string;
  /** wss://host/world/<worldId> - what MpClient.connect() actually dials. */
  url: string;
  /** Player-chosen note shown under the name (this project's stand-in for a real server MOTD, which nothing on the wire actually provides today - see fetchServerStatus's doc comment for the one thing that IS live). */
  motd: string;
  createdAt: number;
};

const KEY = 'evlymc-mp-servers';

/**
 * Validates a pasted server address and pulls the worldId MpClient.connect()
 * needs out of it - shared by main-menu.ts's Direct Connect form and
 * mp-server-list.ts's Add/Edit/Join actions, so every entry point accepts
 * (and rejects) the exact same thing. "xatatestserver" is a shortcut for the
 * dev/test world, resolved before the regular /world/<id> check - typing it
 * behaves exactly as if the full Cloudflare Workers URL had been pasted in.
 */
export function resolveWorldUrl(raw: string): { url: string; worldId: string } | null {
  const trimmed = raw.trim();
  const url = trimmed.toLowerCase() === 'xatatestserver'
    ? 'wss://evlymc-world-server.mrfierrocarrilgames.workers.dev/world/prueba2'
    : trimmed;
  const match = url.match(/\/world\/([A-Za-z0-9_-]+)\/?$/);
  return url && match ? { url, worldId: match[1] } : null;
}

function makeId(): string {
  return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** All saved servers, in the order they were added (oldest first, like Minecraft's own list). */
export function loadServers(): MpServerEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as MpServerEntry[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveServers(list: MpServerEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}

export function addServer(partial: { name: string; url: string; motd?: string }): MpServerEntry {
  const list = loadServers();
  const entry: MpServerEntry = {
    id: makeId(),
    name: partial.name,
    url: partial.url,
    motd: partial.motd ?? '',
    createdAt: Date.now(),
  };
  list.push(entry);
  saveServers(list);
  return entry;
}

export function updateServer(id: string, patch: Partial<Omit<MpServerEntry, 'id'>>): void {
  const list = loadServers();
  const entry = list.find((s) => s.id === id);
  if (entry) Object.assign(entry, patch);
  saveServers(list);
}

export function deleteServer(id: string): void {
  saveServers(loadServers().filter((s) => s.id !== id));
}

/**
 * Live status for one server, queried over plain HTTPS (no WebSocket
 * upgrade needed) against world-server's existing GET /stats/<worldId>
 * (world-do.ts's `stats()`/index.ts's routing) - the same endpoint
 * diagnostics already used for load-monitoring, repurposed here for the
 * server list's player count + ping. There is no real MOTD anywhere on the
 * wire (see MpServerEntry.motd's own doc comment) and no configured max-
 * player cap server-side, so this only ever reports a live player count,
 * never a "current/max".
 */
export type MpServerStatus = { players: number; pingMs: number };

function statusUrlFor(wsUrl: string): string | null {
  const match = wsUrl.trim().match(/^wss?:\/\/([^/]+)\/world\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (!match) return null;
  const scheme = wsUrl.trim().startsWith('wss://') ? 'https' : 'http';
  return `${scheme}://${match[1]}/stats/${match[2]}`;
}

export async function fetchServerStatus(wsUrl: string, timeoutMs = 4000): Promise<MpServerStatus | null> {
  const statusUrl = statusUrlFor(wsUrl);
  if (!statusUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const start = performance.now();
    const res = await fetch(statusUrl, { signal: controller.signal });
    const pingMs = performance.now() - start;
    if (!res.ok) return null;
    const data = await res.json() as { players?: number };
    return { players: typeof data.players === 'number' ? data.players : 0, pingMs };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface Env {
  ACCESS_KV: KVNamespace;
  ALLOWED_ORIGINS: string;
}

type Account = {
  /** Original casing, for display; lookups are by lowercase key. */
  username: string;
  salt: string; // base64
  hash: string; // hex
  iterations: number;
  createdAt: string;
  createdIp: string;
};

const USERNAME_MIN = 4;
const USERNAME_MAX = 16;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 16;
const MAX_ACCOUNTS_PER_IP = 2;
// Cloudflare Workers' crypto.subtle caps PBKDF2 at 100,000 iterations - it
// throws (not clamps) above that, and only in the real deployed runtime, not
// local `wrangler dev`, which is why this needs calling out explicitly.
const PBKDF2_ITERATIONS = 100_000;

function corsHeaders(request: Request, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
  const origin = request.headers.get('Origin') ?? '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(body: unknown, status: number, request: Request, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

function isValidUsername(name: string): boolean {
  return name.length >= USERNAME_MIN && name.length <= USERNAME_MAX && /^[A-Za-z0-9_-]+$/.test(name);
}

function isValidPassword(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

const WHITELIST_KEY = 'whitelist';

/**
 * Closed-beta gate on top of accounts: only names in this list can register
 * OR log in, regardless of whether the account already exists. An empty/
 * missing list blocks everyone. Managed directly in KV (see access-worker's
 * README) - no game-side UI for it, intentionally, since it's an operator
 * tool, not a player-facing setting.
 */
async function isWhitelisted(env: Env, username: string): Promise<boolean> {
  const list = (await env.ACCESS_KV.get<string[]>(WHITELIST_KEY, 'json')) ?? [];
  return list.includes(username.toLowerCase());
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** PBKDF2-SHA256, 256-bit output. Never store/compare plaintext passwords. */
async function hashPassword(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return toHex(bits);
}

/** Constant-time string compare, so a timing side-channel can't leak how much of the hash matched. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(request: Request): Promise<{ username: string; password: string }> {
  const body = (await request.json().catch(() => null)) as { username?: unknown; password?: unknown } | null;
  return {
    username: typeof body?.username === 'string' ? body.username.trim() : '',
    password: typeof body?.password === 'string' ? body.password : '',
  };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const { username, password } = await readBody(request);

  if (!isValidUsername(username)) {
    return json(
      { ok: false, error: `Name must be ${USERNAME_MIN}-${USERNAME_MAX} characters (letters, numbers, _ and - only)` },
      400, request, env,
    );
  }
  if (!isValidPassword(password)) {
    return json({ ok: false, error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters` }, 400, request, env);
  }
  // Registration itself stays open (anyone can create an account, up to the
  // per-IP cap below) - the whitelist gate is enforced at login only, see
  // handleLogin(). That way people can claim their name/account ahead of
  // time; actually getting into the game is what needs an invite.

  const accountKey = `account:${username.toLowerCase()}`;
  if (await env.ACCESS_KV.get(accountKey)) {
    return json({ ok: false, error: 'That name is already taken' }, 409, request, env);
  }

  const ip = clientIp(request);
  const ipKey = `ip:${ip}`;
  const ipAccounts = (await env.ACCESS_KV.get<string[]>(ipKey, 'json')) ?? [];
  if (ipAccounts.length >= MAX_ACCOUNTS_PER_IP) {
    return json({ ok: false, error: 'Maximum number of accounts reached for this connection' }, 429, request, env);
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
  const account: Account = {
    username,
    salt: toBase64(salt),
    hash,
    iterations: PBKDF2_ITERATIONS,
    createdAt: new Date().toISOString(),
    createdIp: ip,
  };

  await env.ACCESS_KV.put(accountKey, JSON.stringify(account));
  await env.ACCESS_KV.put(ipKey, JSON.stringify([...ipAccounts, username.toLowerCase()]));

  return json({ ok: true, username }, 200, request, env);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const { username, password } = await readBody(request);
  if (!username || !password) {
    return json({ ok: false, error: 'Enter your name and password' }, 400, request, env);
  }
  if (!(await isWhitelisted(env, username))) {
    return json({ ok: false, error: 'This name does not have access to the beta' }, 403, request, env);
  }

  const account = await env.ACCESS_KV.get<Account>(`account:${username.toLowerCase()}`, 'json');
  // Same generic error whether the account doesn't exist or the password is
  // wrong - don't let this endpoint be used to enumerate valid usernames.
  if (!account) {
    return json({ ok: false, error: 'Invalid name or password' }, 401, request, env);
  }

  const hash = await hashPassword(password, fromBase64(account.salt), account.iterations);
  if (!timingSafeEqual(hash, account.hash)) {
    return json({ ok: false, error: 'Invalid name or password' }, 401, request, env);
  }

  return json({ ok: true, username: account.username }, 200, request, env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Not found' }, 404, request, env);
    }

    const url = new URL(request.url);
    if (url.pathname === '/register') return handleRegister(request, env);
    if (url.pathname === '/login') return handleLogin(request, env);
    return json({ ok: false, error: 'Not found' }, 404, request, env);
  },
};

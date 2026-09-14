/**
 * Ticket que prueba "esta persona inició sesión como tal cuenta", para que el
 * world server pueda confiar en un nombre de jugador en vez de creerle al
 * cliente.
 *
 * Por qué hace falta: `join` traía solo `playerName`, un string libre. Como el
 * guardado del jugador se keyea por ese nombre (Fase 12), cualquiera que
 * abriera un WebSocket crudo y escribiera el nombre de otro heredaba su
 * inventario y su posición. Que el campo no se pueda editar en la interfaz no
 * arregla nada: el servidor es el que tiene que poder verificarlo.
 *
 * El access worker (que es quien valida la contraseña) FIRMA este token al
 * iniciar sesión; el world server lo VERIFICA con el mismo secreto compartido.
 * Así el world server no necesita llamar al access worker en cada join - ni
 * latencia ni costo por conexión - y sigue sin poder ser engañado.
 *
 * Este archivo lo incluyen los dos workers a propósito (ver sus tsconfig):
 * firmar y verificar tienen que usar exactamente el mismo formato, y son justo
 * el tipo de par que se rompe en silencio si se duplica y uno de los dos
 * cambia. No usa DOM ni nada de Node - solo WebCrypto, que existe igual en
 * ambos runtimes.
 *
 * NO es un JWT y no pretende serlo: no hay algoritmos negociables (el "alg:
 * none" de JWT es un clásico de vulnerabilidades), es siempre HMAC-SHA256.
 */

/** Cuánto vale un token antes de tener que volver a iniciar sesión. */
export const AUTH_TOKEN_TTL_SECONDS = 12 * 60 * 60;

type TokenPayload = {
  /** Username, con el casing original de la cuenta. */
  u: string;
  /** Vencimiento, en segundos epoch. */
  exp: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function hmac(payloadB64: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return base64UrlEncode(new Uint8Array(sig));
}

/** Compara en tiempo constante, para no filtrar cuánto de la firma coincidía. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Emite un token para `username`. Solo lo llama el access worker, después de verificar la contraseña. */
export async function signAuthToken(username: string, secret: string, ttlSeconds = AUTH_TOKEN_TTL_SECONDS): Promise<string> {
  const payload: TokenPayload = { u: username, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadB64}.${await hmac(payloadB64, secret)}`;
}

/**
 * Devuelve el username si el token está firmado con `secret` y no venció, o
 * null en cualquier otro caso. El que llama tiene que usar ESTE nombre, no uno
 * que haya mandado el cliente por separado - si no, todo esto no sirve de nada.
 */
export async function verifyAuthToken(token: string, secret: string): Promise<string | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!timingSafeEqual(await hmac(payloadB64, secret), signature)) return null;

  const raw = base64UrlDecode(payloadB64);
  if (!raw) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(raw)) as TokenPayload;
    if (typeof payload?.u !== 'string' || typeof payload?.exp !== 'number') return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.u;
  } catch {
    return null;
  }
}

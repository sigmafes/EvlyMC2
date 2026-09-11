export interface Env {
  ACCESS_KV: KVNamespace;
  ALLOWED_ORIGIN: string;
}

type KeyRecord = {
  name: string;
  used: boolean;
  usedAt?: string;
};

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/validate' || request.method !== 'POST') {
      return json({ ok: false, error: 'Not found' }, 404, env);
    }

    let body: { name?: unknown; key?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'Invalid request' }, 400, env);
    }

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!name || !key) {
      return json({ ok: false, error: 'Invalid access key' }, 400, env);
    }

    // KV key is the access key itself (case-sensitive); the record carries
    // who it was issued to, so the name typed in has to match too.
    const record = await env.ACCESS_KV.get<KeyRecord>(`key:${key}`, 'json');
    if (!record || record.name.toLowerCase() !== name.toLowerCase()) {
      return json({ ok: false, error: 'Invalid access key' }, 401, env);
    }
    if (record.used) {
      return json({ ok: false, error: 'This access key has already been used' }, 401, env);
    }

    const updated: KeyRecord = { ...record, used: true, usedAt: new Date().toISOString() };
    await env.ACCESS_KV.put(`key:${key}`, JSON.stringify(updated));

    return json({ ok: true }, 200, env);
  },
};

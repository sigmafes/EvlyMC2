# EvlyMC access-worker

A tiny Cloudflare Worker that validates closed-beta access keys server-side, so
they stop shipping in plain text inside the game's public JS bundle and
"used" becomes a real, centrally-tracked fact instead of a per-browser
localStorage flag.

## What you need to do (each step below is yours - I can't create accounts or
log in for you)

### 1. Cloudflare account
Sign up at https://dash.cloudflare.com/sign-up (free tier is enough for this).

### 2. Log in from the CLI
From `access-worker/`:
```bash
npm install
npx wrangler login
```
This opens a browser tab to authorize Wrangler against your account.

### 3. Create the KV namespace (where keys live)
```bash
npx wrangler kv namespace create ACCESS_KV
npx wrangler kv namespace create ACCESS_KV --preview
```
Each command prints an `id`. Open `wrangler.toml` and paste them in:
- the first command's `id` -> `id = "..."`
- the second command's `id` -> `preview_id = "..."`

### 4. Add your first key
Each key is one KV entry, keyed by the access key string itself:
```bash
npx wrangler kv key put --binding=ACCESS_KV "key:bMdE3mbd" "{\"name\":\"sigmafes\",\"used\":false}"
```
Repeat per person you invite (different key string, same JSON shape with their
name). To generate a new random key, ask me and I'll hand you one the same way
I did for `bMdE3mbd` - I just won't be able to run this command for you since
it needs your login.

### 5. Deploy
```bash
npx wrangler deploy
```
Wrangler prints the live URL, something like
`https://evlymc-access.<your-subdomain>.workers.dev`. **Send me that URL** -
I'll wire the game's `access-gate.ts` to call it instead of checking the
local plaintext list, and remove `access-keys.ts` from the client bundle
entirely.

### 6. Managing keys later
- Check a key: `npx wrangler kv key get --binding=ACCESS_KV "key:bMdE3mbd"`
- Revoke one early: `npx wrangler kv key delete --binding=ACCESS_KV "key:bMdE3mbd"`
- List everything: `npx wrangler kv key list --binding=ACCESS_KV`

## What this buys you vs. the current localStorage version
- Keys never appear in the shipped JS - only the Worker (which you control)
  can see the list.
- "Used" is tracked in one place (Cloudflare's KV), not per-browser - the
  same key genuinely can't be reused in a second browser, incognito window,
  or after clearing site data.

## Known limitation (being upfront about it)
KV writes are eventually consistent (Cloudflare's own docs: propagation can
take up to ~60s globally). If the exact same key is submitted twice within
that window from two different places, both could momentarily read
`used: false` and both succeed. For a low-traffic invite list this is
extremely unlikely to matter in practice; if it ever needs to be airtight,
the fix is swapping the KV read-then-write for a Durable Object (which
serializes requests per-key) - a bigger change, worth doing only if it
actually becomes a problem.

## This is also your multiplayer foundation
Nothing here is access-gate-specific at the infrastructure level - the same
Cloudflare account/Worker project is where a multiplayer relay would live
later (Durable Objects support WebSockets directly). Standing this up now
isn't a detour from multiplayer, it's the first piece of it.

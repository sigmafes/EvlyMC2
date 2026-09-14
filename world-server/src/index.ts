import { WorldDO, type Env } from './world-do';

export { WorldDO };

/**
 * Routes a WebSocket upgrade at /world/:worldId to that world's Durable
 * Object instance (idFromName means the same worldId always resolves to the
 * same instance - the "one server process per world" model from the plan).
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // /stats/<worldId> answers with that world's load report as JSON (see
    // WorldDO.stats) - how many players/mobs/chunks it's carrying and whether
    // its 20Hz tick is keeping up. Routed to the same Durable Object as the
    // world itself, since that's where the numbers live.
    const match = url.pathname.match(/^\/(?:world|stats)\/([A-Za-z0-9_-]{1,64})$/);
    if (!match) {
      return new Response('Usage: connect a WebSocket to /world/<worldId>, or GET /stats/<worldId>', { status: 404 });
    }
    const id = env.WORLD_DO.idFromName(match[1]);
    const stub = env.WORLD_DO.get(id);
    // Forward the original request unchanged - reconstructing a new Request
    // for a WebSocket upgrade is risky (the Upgrade header is handled
    // specially by the runtime). The DO derives its own terrain seed by
    // re-parsing this same /world/:id path from request.url itself.
    return stub.fetch(request);
  },
};

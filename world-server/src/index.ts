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
    const match = url.pathname.match(/^\/world\/([A-Za-z0-9_-]{1,64})$/);
    if (!match) {
      return new Response('Usage: connect a WebSocket to /world/<worldId>', { status: 404 });
    }
    const id = env.WORLD_DO.idFromName(match[1]);
    const stub = env.WORLD_DO.get(id);
    return stub.fetch(request);
  },
};

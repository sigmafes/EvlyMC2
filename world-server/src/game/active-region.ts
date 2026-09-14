import { CHUNK_SIZE } from '../../../src/worldgen/constants';

/**
 * Qué parte del mundo se simula: la unión de los chunks dentro de este radio
 * de cada jugador conectado. Fuera de eso el mundo se CONGELA, no se apaga -
 * ver la doc de la clase.
 *
 * Es un radio fijo a propósito, no la render distance del cliente: un cliente
 * podría pedir ver más lejos, pero cuánto simula el servidor (y por lo tanto
 * cuánta CPU de Durable Object se factura) no es algo que deba poder decidir
 * quien se conecta.
 *
 * Tiene que seguir siendo MAYOR que el radio de visión del cliente
 * (VIEW_RADIUS_CHUNKS en multiplayer-game.ts, hoy 3), o se vería lo que no se
 * simula: mobs congelados, parados en el aire, dentro del campo de visión. El
 * margen de 4 contra 3 es justamente eso, no un número arbitrario.
 */
export const SIMULATION_RADIUS_CHUNKS = 4;

/** Chunk coords for a block position. The `+8` matches the client's own chunkCoordOf(): block coords are centre-based, so chunk 0 spans blocks -8..7, and getting this wrong would put the server and client on different chunk grids. */
export function chunkCoordOf(x: number, z: number): [number, number] {
  return [Math.floor((x + 8) / CHUNK_SIZE), Math.floor((z + 8) / CHUNK_SIZE)];
}

/**
 * The set of chunks currently worth simulating.
 *
 * Anything that ticks continuously (mob AI today, water and fire once they
 * land) asks this before advancing a chunk, so a world with two players in
 * one corner doesn't pay to simulate everything they walked away from - the
 * single biggest lever on this Durable Object's CPU bill.
 *
 * "Frozen" means the tick is simply SKIPPED, not that state is discarded and
 * not that time keeps accruing to be applied in one lump later. A burning
 * tree that everyone walks away from stops mid-burn and stays exactly there;
 * when somebody comes back it carries on from that same point rather than
 * instantly catching up on the minutes it spent alone. That "don't catch up"
 * property is why there's no elapsed-time bookkeeping here at all: keeping a
 * per-chunk clock is precisely what would reintroduce the fast-forward.
 *
 * Recomputed only when the set of occupied chunks actually changes, not every
 * tick - at 20Hz with several players, rebuilding ~81 keys per player per
 * tick would itself become part of the cost this exists to avoid.
 */
export class ActiveRegion {
  private active = new Set<string>();
  /** The chunk each player was in at the last rebuild, keyed by session id - a rebuild is only needed when one of these changes. */
  private lastPlayerChunks = new Map<number, string>();

  /** Recompute if anyone crossed a chunk boundary (or joined/left) since last time. Cheap to call every tick; it usually does nothing. */
  update(players: { id: number; pos: { x: number; z: number } }[]): void {
    let changed = players.length !== this.lastPlayerChunks.size;
    const current = new Map<number, string>();
    for (const player of players) {
      const [cx, cz] = chunkCoordOf(player.pos.x, player.pos.z);
      const key = `${cx},${cz}`;
      current.set(player.id, key);
      if (this.lastPlayerChunks.get(player.id) !== key) changed = true;
    }
    if (!changed) return;

    this.lastPlayerChunks = current;
    this.active = new Set();
    for (const key of current.values()) {
      const [pcx, pcz] = key.split(',').map(Number);
      for (let cx = pcx - SIMULATION_RADIUS_CHUNKS; cx <= pcx + SIMULATION_RADIUS_CHUNKS; cx++) {
        for (let cz = pcz - SIMULATION_RADIUS_CHUNKS; cz <= pcz + SIMULATION_RADIUS_CHUNKS; cz++) {
          this.active.add(`${cx},${cz}`);
        }
      }
    }
  }

  /** True if the chunk containing this BLOCK position should be simulated this tick. */
  isActiveAt(x: number, z: number): boolean {
    const [cx, cz] = chunkCoordOf(x, z);
    return this.active.has(`${cx},${cz}`);
  }

  /** How many chunks are being simulated right now - reported by the /stats endpoint, since this is the number that scales the tick's cost. */
  get size(): number {
    return this.active.size;
  }
}

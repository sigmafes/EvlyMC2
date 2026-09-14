import type { BlockId } from '../../../src/block';

/**
 * La superficie mínima del mundo que necesitan los motores de fluidos y de
 * fuego. Singleplayer les pasa su clase `World` entera; el servidor no tiene
 * nada parecido (ni chunks cargados, ni mallas), así que expone solo estos
 * tres métodos contra su mapa de ediciones + terreno generado.
 *
 * `setBlock` acá NO es solo escribir en memoria: del lado servidor persiste la
 * edición y la transmite a todos los clientes. Por eso el agua y el fuego no
 * necesitan ningún mensaje de red propio - cada celda que cambia viaja como
 * la misma edición de bloque que romper o colocar, y el cliente no tiene que
 * saber que existe una simulación detrás.
 */
export type FluidWorld = {
  getBlock(x: number, y: number, z: number): BlockId;
  setBlock(x: number, y: number, z: number, id: BlockId): void;
  /** Horizontal world bounds. The server's terrain is infinite, so this is always true there - it exists because the ported engines call it. */
  isInsideWorld(x: number, z: number): boolean;
};

/**
 * Whether a cell is close enough to a player to simulate this tick. The
 * singleplayer engines took `playerX`/`playerZ` and measured a radius from
 * the one player; with several players it has to be the union of everyone's
 * surroundings, which is what game/active-region.ts computes.
 */
export type IsActiveAt = (x: number, z: number) => boolean;

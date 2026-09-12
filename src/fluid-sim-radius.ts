// Shared "close enough to simulate" radius for water/lava/fire - independent
// of render distance. A source/cell outside this radius is frozen exactly as
// it last was (no drain, no spread, no aging) instead of being recomputed
// every tick regardless of how far it is from the player; it resumes normal
// behaviour automatically the moment the player is back within range.
export const FLUID_SIM_RADIUS_BLOCKS = 24; // ~3x3 chunks (CHUNK_SIZE=16) around the player

/** True if (x,z) is within FLUID_SIM_RADIUS_BLOCKS of the player, or always true if no position was given (back-compat for callers that don't pass one). */
export function withinFluidSimRadius(x: number, z: number, playerX?: number, playerZ?: number): boolean {
  if (playerX === undefined || playerZ === undefined) return true;
  const dx = x - playerX;
  const dz = z - playerZ;
  return dx * dx + dz * dz <= FLUID_SIM_RADIUS_BLOCKS * FLUID_SIM_RADIUS_BLOCKS;
}

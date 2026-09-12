// Shared chunk/world-gen constants. Lives outside chunk.ts so the worldgen/*
// feature modules (which chunk.ts imports) can use them without an import
// cycle - chunk.ts re-exports these for every existing `from './chunk'` import.
export const CHUNK_SIZE = 16;
export const CHUNK_HEIGHT = 152; // build height (not a multiple of SUBCHUNK_HEIGHT - the last subchunk per column is just shorter, already tolerated in chunk.ts)
export const CHUNK_MIN_Y = 0;
export const CHUNK_MAX_Y = 128; // terrain generation ceiling - distinct from CHUNK_HEIGHT, same split LCE makes (maxBuildHeight vs genDepth)
export const WATER_LEVEL = 63;

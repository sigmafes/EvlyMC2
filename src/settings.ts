/** Player options, editable from the main menu or in-game, persisted to localStorage. */
export type GameSettings = {
  fov: number;
  sensitivity: number;
  /** Look sensitivity for touch-drag (Android); separate from the desktop mouse's `sensitivity`. */
  touchSensitivity: number;
  /** On-screen touch button opacity, 10-100. */
  buttonOpacity: number;
  renderDistance: number;
  smoothLighting: boolean;
  fog: boolean;
  alexSkin: boolean;
  viewBob: boolean;
};

const KEY = 'evlymc-settings';
/** Multiplayer keeps its own copy under a separate key - same shape, but the two modes' values (render distance especially: multiplayer's is capped 2-4 by the server's SIMULATION_RADIUS_CHUNKS, singleplayer's isn't) shouldn't overwrite each other just because someone tuned one mode's options. */
const KEY_MP = 'evlymc-settings-mp';

export const DEFAULT_SETTINGS: GameSettings = {
  fov: 70,
  sensitivity: 100,
  touchSensitivity: 100,
  buttonOpacity: 100,
  renderDistance: 5,
  smoothLighting: true,
  fog: true,
  alexSkin: false,
  viewBob: true,
};

/** Multiplayer's own defaults - identical except renderDistance, which starts at the middle of its 2-4 range instead of singleplayer's 5. */
export const DEFAULT_MP_SETTINGS: GameSettings = {
  ...DEFAULT_SETTINGS,
  renderDistance: 3,
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<GameSettings>) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch: Partial<GameSettings>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch {
    /* private mode */
  }
}

export function loadMpSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY_MP);
    return raw ? { ...DEFAULT_MP_SETTINGS, ...(JSON.parse(raw) as Partial<GameSettings>) } : { ...DEFAULT_MP_SETTINGS };
  } catch {
    return { ...DEFAULT_MP_SETTINGS };
  }
}

export function saveMpSettings(patch: Partial<GameSettings>) {
  try {
    localStorage.setItem(KEY_MP, JSON.stringify({ ...loadMpSettings(), ...patch }));
  } catch {
    /* private mode */
  }
}

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

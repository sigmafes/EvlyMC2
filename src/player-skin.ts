/**
 * Player identity: display name + a custom skin PNG imported from disk.
 * Global (not per-world), persisted to localStorage as a small key each -
 * the skin is stored as a data: URL, which at 64x64 PNG is only a few KB, well
 * within localStorage's per-origin quota.
 */

const NAME_KEY = 'evlymc-player-name';
const SKIN_KEY = 'evlymc-player-skin';

export const DEFAULT_PLAYER_NAME = 'Player';
const SKIN_SIZE = 64;

export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || DEFAULT_PLAYER_NAME;
  } catch {
    return DEFAULT_PLAYER_NAME;
  }
}

export function savePlayerName(name: string): void {
  try {
    const trimmed = name.trim().slice(0, 16);
    localStorage.setItem(NAME_KEY, trimmed || DEFAULT_PLAYER_NAME);
  } catch {
    /* private mode */
  }
}

export function loadPlayerSkinDataUrl(): string | null {
  try {
    return localStorage.getItem(SKIN_KEY);
  } catch {
    return null;
  }
}

export function savePlayerSkinDataUrl(dataUrl: string): void {
  try {
    localStorage.setItem(SKIN_KEY, dataUrl);
  } catch {
    /* private mode, or over quota - the skin just won't survive a reload */
  }
}

export function clearPlayerSkin(): void {
  try {
    localStorage.removeItem(SKIN_KEY);
  } catch {
    /* private mode */
  }
}

export type SkinImportResult =
  | { ok: true; dataUrl: string; image: HTMLImageElement }
  | { ok: false; error: string };

/**
 * Read, decode and validate a user-picked file as a skin: must be a real PNG,
 * and exactly 64x64 px (the modern Minecraft skin format this model's UV
 * layout assumes - SKIN_UV in player-model.ts references pixels up to y=63,
 * which a legacy 64x32 skin doesn't have).
 */
export async function readAndValidateSkinFile(file: File): Promise<SkinImportResult> {
  const looksLikePng = file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');
  if (!looksLikePng) {
    return { ok: false, error: 'The file must be a PNG image.' };
  }

  let dataUrl: string;
  try {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('read failed'));
      reader.readAsDataURL(file);
    });
  } catch {
    return { ok: false, error: 'Could not read the file.' };
  }

  // A mislabelled non-PNG file (or corrupt data) fails to decode as an image
  // even if the extension/MIME type looked right - catch that here too.
  let image: HTMLImageElement;
  try {
    image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = dataUrl;
    });
  } catch {
    return { ok: false, error: 'That file is not a valid PNG image.' };
  }

  if (image.naturalWidth !== SKIN_SIZE || image.naturalHeight !== SKIN_SIZE) {
    return {
      ok: false,
      error: `The skin must be exactly ${SKIN_SIZE}x${SKIN_SIZE} px (this one is ${image.naturalWidth}x${image.naturalHeight}).`,
    };
  }

  return { ok: true, dataUrl, image };
}

/** Load the persisted skin (if any) and hand it to `applyFn` once decoded. Call once at startup. */
export function applyPersistedSkin(applyFn: (image: HTMLImageElement) => void): void {
  const dataUrl = loadPlayerSkinDataUrl();
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => applyFn(img);
  img.src = dataUrl;
}

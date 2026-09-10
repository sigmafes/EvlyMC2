import { playClick } from './ui-sound';
import { WorldMeta, createWorld, loadWorlds, nextWorldName } from './worlds';

type WorldCreateHandlers = {
  /** A world was created — start playing it. */
  onCreate: (world: WorldMeta) => void;
  /** Back to the world list. */
  onCancel: () => void;
};

/**
 * Minecraft-style "Create New World" screen. Only the name and "Allow Cheats"
 * are editable for now; Game Mode / Difficulty are fixed, and the top tabs are
 * placeholders.
 */
export class WorldCreate {
  private readonly root = document.querySelector<HTMLElement>('#world-create')!;
  private readonly nameEl = document.querySelector<HTMLInputElement>('#wc-name')!;
  private readonly cheatsEl = document.querySelector<HTMLButtonElement>('#wc-cheats')!;
  private cheats = false;

  constructor(private readonly handlers: WorldCreateHandlers) {
    this.cheatsEl.addEventListener('click', () => {
      playClick();
      this.cheats = !this.cheats;
      this.paintCheats();
    });

    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button[data-action]');
      if (!button) return;
      playClick();
      if (button.dataset.action === 'wc-create') this.create();
      else if (button.dataset.action === 'wc-cancel') this.cancel();
    });
  }

  open(): void {
    this.nameEl.value = nextWorldName(loadWorlds());
    this.cheats = false;
    this.paintCheats();
    this.root.hidden = false;
    this.nameEl.focus();
    this.nameEl.select();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private paintCheats(): void {
    this.cheatsEl.querySelector('span')!.textContent = `Allow Cheats: ${this.cheats ? 'ON' : 'OFF'}`;
  }

  private create(): void {
    const name = this.nameEl.value.trim() || nextWorldName(loadWorlds());
    const world = createWorld({ name, mode: 'Survival', cheats: this.cheats });
    this.hide();
    this.handlers.onCreate(world);
  }

  private cancel(): void {
    this.hide();
    this.handlers.onCancel();
  }
}

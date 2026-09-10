import worldThumb from '../gui/world.png';
import { playClick } from './ui-sound';
import { WorldCreate } from './world-create';
import {
  WorldMeta,
  loadWorlds,
  createWorld,
  updateWorld,
  deleteWorld,
  activateWorld,
  formatStamp,
} from './worlds';

type WorldSelectHandlers = {
  /** Start the game on the chosen world. */
  onPlay: (world: WorldMeta) => void;
  /** Back to the main menu. */
  onCancel: () => void;
};

/**
 * Minecraft-style "Select World" screen: a searchable list of saved worlds with
 * Play / Create / Edit / Delete / Re-Create / Cancel actions.
 */
export class WorldSelect {
  private readonly root = document.querySelector<HTMLElement>('#world-select')!;
  private readonly listEl = document.querySelector<HTMLElement>('#world-list')!;
  private readonly searchEl = document.querySelector<HTMLInputElement>('#world-search')!;
  private worlds: WorldMeta[] = [];
  private selectedId: string | null = null;
  private creator: WorldCreate | null = null;

  constructor(private readonly handlers: WorldSelectHandlers) {
    this.searchEl.addEventListener('input', () => this.renderList());

    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button');
      if (!button) return;
      playClick();
      this.onAction(button.dataset.action ?? '');
    });
  }

  /** Show the screen and (re)load the world list. */
  open(): void {
    this.worlds = loadWorlds();
    if (this.selectedId && !this.worlds.some((w) => w.id === this.selectedId)) {
      this.selectedId = null;
    }
    if (!this.selectedId && this.worlds.length > 0) this.selectedId = this.worlds[0].id;
    this.searchEl.value = '';
    this.renderList();
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  private selected(): WorldMeta | undefined {
    return this.worlds.find((w) => w.id === this.selectedId);
  }

  private onAction(action: string): void {
    const current = this.selected();
    switch (action) {
      case 'play':
        if (current) this.play(current);
        break;
      case 'create':
        this.openCreator();
        break;
      case 'edit': {
        if (!current) break;
        const name = window.prompt('World name:', current.name)?.trim();
        if (name) {
          updateWorld(current.id, { name });
          this.worlds = loadWorlds();
          this.renderList();
        }
        break;
      }
      case 'delete': {
        if (!current) break;
        if (window.confirm(`Delete "${current.name}"? This cannot be undone.`)) {
          deleteWorld(current.id);
          this.selectedId = null;
          this.worlds = loadWorlds();
          if (this.worlds.length > 0) this.selectedId = this.worlds[0].id;
          this.renderList();
        }
        break;
      }
      case 'recreate': {
        if (!current) break;
        if (window.confirm(`Re-create "${current.name}" with the same seed? A fresh world is generated.`)) {
          const world = createWorld({
            name: current.name,
            seed: current.seed,
            mode: current.mode,
            cheats: current.cheats,
          });
          this.play(world);
        }
        break;
      }
      case 'cancel':
        this.hide();
        this.handlers.onCancel();
        break;
    }
  }

  private openCreator(): void {
    if (!this.creator) {
      this.creator = new WorldCreate({
        onCreate: (world) => this.play(world),
        onCancel: () => this.open(),
      });
    }
    this.hide();
    this.creator.open();
  }

  private play(world: WorldMeta): void {
    activateWorld(world);
    this.hide();
    this.handlers.onPlay(world);
  }

  /** Suffix shown after the name, disambiguating worlds that share it (by creation order). */
  private dupSuffix(world: WorldMeta): string {
    const sameName = this.worlds
      .filter((w) => w.name === world.name)
      .sort((a, b) => a.createdAt - b.createdAt);
    const idx = sameName.findIndex((w) => w.id === world.id);
    return idx > 0 ? ` (${idx})` : '';
  }

  private renderList(): void {
    const query = this.searchEl.value.trim().toLowerCase();
    const shown = query
      ? this.worlds.filter((w) => w.name.toLowerCase().includes(query))
      : this.worlds;

    this.listEl.replaceChildren();

    if (shown.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'world-list-empty';
      empty.textContent = this.worlds.length === 0
        ? 'No worlds yet — create one below.'
        : 'No worlds match your search.';
      this.listEl.append(empty);
    }

    for (const world of shown) {
      const row = document.createElement('div');
      row.className = 'world-row';
      if (world.id === this.selectedId) row.classList.add('selected');

      const thumb = document.createElement('img');
      thumb.className = 'world-thumb';
      thumb.src = worldThumb;
      thumb.alt = '';

      const text = document.createElement('div');
      text.className = 'world-row-text';

      const title = document.createElement('div');
      title.className = 'world-row-title';
      title.textContent = world.name;

      const sub1 = document.createElement('div');
      sub1.className = 'world-row-sub';
      sub1.textContent = `${world.name}${this.dupSuffix(world)} (${formatStamp(world.createdAt)})`;

      const sub2 = document.createElement('div');
      sub2.className = 'world-row-sub';
      sub2.textContent = `${world.mode} Mode, ${world.cheats ? 'Cheats, ' : ''}Version: ${world.version}`;

      text.append(title, sub1, sub2);
      row.append(thumb, text);

      row.addEventListener('click', () => {
        this.selectedId = world.id;
        this.renderList();
      });
      row.addEventListener('dblclick', () => this.play(world));

      this.listEl.append(row);
    }

    this.updateButtons();
  }

  private updateButtons(): void {
    const hasSelection = !!this.selected();
    for (const action of ['play', 'edit', 'delete', 'recreate']) {
      const button = this.root.querySelector<HTMLButtonElement>(`.mc-button[data-action="${action}"]`);
      if (button) button.disabled = !hasSelection;
    }
  }
}

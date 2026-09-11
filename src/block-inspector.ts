import { blockLightProperties } from './block';
import { BlockInteraction } from './interaction';
import { LightEngine } from './light-engine';
import { World } from './world';

const blockNames: Record<number, string> = {
  0: 'AIR',
  1: 'BEDROCK',
  2: 'OAK_PLANKS',
  3: 'STONE',
  4: 'DIRT',
  5: 'GRASS',
  6: 'GLOWSTONE',
  7: 'OAK_LOG',
  8: 'WATER',
  9: 'OAK_LEAVES',
  10: 'SAND',
  11: 'FIRE',
  12: 'LAVA',
  13: 'COBBLESTONE',
  14: 'OBSIDIAN',
  15: 'ICE',
  16: 'COAL_ORE',
  17: 'IRON_ORE',
  18: 'GOLD_ORE',
  19: 'DIAMOND_ORE',
  20: 'EMERALD_ORE',
  21: 'LAPIS_ORE',
  22: 'REDSTONE_ORE',
  23: 'CRAFTING_TABLE',
  24: 'GLASS',
  25: 'FURNACE',
  26: 'TORCH',
};

export class BlockInspector {
  private readonly values: Map<string, HTMLElement>;

  constructor(
    private readonly panel: HTMLElement,
    private readonly interaction: BlockInteraction,
    private readonly world: World,
    private readonly lightEngine: LightEngine,
  ) {
    this.values = new Map(
      [...panel.querySelectorAll<HTMLElement>('[id^="block-"]')].map((element) => [element.id, element]),
    );
    document.addEventListener('keydown', this.onKeyDown);
    panel.addEventListener('click', this.copy);
    panel.addEventListener('keydown', this.onPanelKeyDown);
  }

  update() {
    const target = this.interaction.getTargetBlock();
    if (!target) {
      this.set('block-name', 'Ninguno');
      this.set('block-id', '--');
      this.set('block-position', '--');
      this.set('block-sky-light', '--');
      this.set('block-block-light', '--');
      this.set('block-brightness', '--');
      this.set('block-opacity', '--');
      this.set('block-emission', '--');
      return;
    }

    const { x, y, z } = target.position;
    const lightPosition = target.lightPosition;
    const properties = blockLightProperties[target.id];
    this.set('block-name', blockNames[target.id] ?? 'UNKNOWN');
    this.set('block-id', target.id.toString());
    this.set('block-position', `${x}, ${y}, ${z}`);
    this.set('block-sky-light', this.world.getLight('skyLight', lightPosition.x, lightPosition.y, lightPosition.z).toString());
    this.set('block-block-light', this.world.getLight('blockLight', lightPosition.x, lightPosition.y, lightPosition.z).toString());
    this.set('block-brightness', this.lightEngine.getRawBrightness(lightPosition.x, lightPosition.y, lightPosition.z).toString());
    this.set('block-opacity', properties.opacity.toString());
    this.set('block-emission', properties.emission.toString());
  }

  private set(id: string, value: string) {
    this.values.get(id)!.textContent = value;
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'KeyO' && !event.repeat) this.panel.hidden = !this.panel.hidden;
  };
  private onPanelKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      void this.copy();
    }
  };
  private copy = async (event?: Event) => {
    event?.stopPropagation();
    const lines = [...this.panel.querySelectorAll<HTMLElement>('dd')]
      .map((value) => `${value.previousElementSibling?.textContent}: ${value.textContent}`);
    const report = ['Bedrock World - Block Inspector', new Date().toISOString(), ...lines].join('\n');
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      const fallback = document.createElement('textarea');
      fallback.value = report;
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.appendChild(fallback);
      fallback.select();
      document.execCommand('copy');
      fallback.remove();
    }
    const status = this.panel.querySelector<HTMLElement>('#block-copy-status');
    if (status) {
      status.textContent = 'COPIED';
      window.setTimeout(() => { status.textContent = 'CLICK TO COPY'; }, 1200);
    }
  };
}

import * as THREE from 'three';
import { PlayerController } from './player';
import { World } from './world';
import { LightEngine } from './light-engine';

type MemoryInfo = {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
};

export class Diagnostics {
  private readonly values: Map<string, HTMLElement>;
  private frames = 0;
  private lastTime = performance.now();
  private lastUpdate = this.lastTime;

  constructor(
    private readonly panel: HTMLElement,
    private readonly renderer: THREE.WebGLRenderer,
    private readonly world: World,
    private readonly player: PlayerController,
    private readonly lightEngine: LightEngine,
  ) {
    this.values = new Map(
      [...panel.querySelectorAll<HTMLElement>('[id^="metric-"]')].map((element) => [element.id, element]),
    );
    document.addEventListener('keydown', this.onKeyDown);
    panel.addEventListener('click', this.copy);
    panel.addEventListener('mousedown', this.stopPanelEvent);
    panel.addEventListener('keydown', this.onPanelKeyDown);
  }

  update(now: number, cycleTime = 0) {
    this.frames += 1;
    if (now - this.lastUpdate < 500) return;
    const fps = this.frames / ((now - this.lastTime) / 1000);
    const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
    this.set('metric-fps', fps.toFixed(1));
    this.set('metric-frame', `${(1000 / fps).toFixed(2)} ms`);
    this.set('metric-pixel-ratio', this.renderer.getPixelRatio().toFixed(2));
    this.set('metric-calls', this.renderer.info.render.calls.toString());
    this.set('metric-triangles', this.renderer.info.render.triangles.toLocaleString());
    this.set('metric-geometries', this.renderer.info.memory.geometries.toString());
    this.set('metric-textures', this.renderer.info.memory.textures.toString());
    this.set('metric-programs', (this.renderer.info.programs?.length ?? 0).toString());
    this.set('metric-blocks', this.world.totalBlocks.toLocaleString());
    this.set('metric-visible-blocks', this.world.visibleSubchunks.toLocaleString());
    const { position } = this.player.state;
    this.set('metric-position', `${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`);
    this.set('metric-game-time', formatGameTime(cycleTime));
    this.set('metric-light-queue', this.lightEngine.pendingUpdates.toString());
    this.set('metric-light-processed', this.lightEngine.processedUpdates.toString());
    this.set('metric-light-dirty', this.world.dirtySubchunks.toString());
    this.set('metric-sky-darken', this.lightEngine.currentSkyDarken.toString());
    this.set('metric-memory-used', memory ? `${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : 'No disponible');
    this.set('metric-memory-limit', memory ? `${(memory.jsHeapSizeLimit / 1048576).toFixed(1)} MB` : 'No disponible');
    this.set('metric-device-memory', 'deviceMemory' in navigator ? `${(navigator as Navigator & { deviceMemory: number }).deviceMemory} GB` : 'No disponible');
    this.frames = 0;
    this.lastTime = now;
    this.lastUpdate = now;
  }

  private set(id: string, value: string) {
    this.values.get(id)!.textContent = value;
  }

  private toggle = () => { this.panel.hidden = !this.panel.hidden; };
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'KeyO' && !event.repeat) this.toggle();
  };
  private onPanelKeyDown = (event: KeyboardEvent) => {
    if (event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      void this.copy();
    }
  };
  private stopPanelEvent = (event: MouseEvent) => event.stopPropagation();
  private copy = async (event?: Event) => {
    event?.stopPropagation();
    const lines = [...this.panel.querySelectorAll<HTMLElement>('dd')]
      .map((value) => `${value.previousElementSibling?.textContent}: ${value.textContent}`);
    const report = ['Bedrock World - Render Diagnostics', new Date().toISOString(), ...lines].join('\n');
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
    const status = this.panel.querySelector<HTMLElement>('#diagnostics-copy-status');
    if (status) {
      status.textContent = 'COPIED';
      window.setTimeout(() => { status.textContent = 'CLICK TO COPY'; }, 1200);
    }
  };
}

function formatGameTime(cycleTime: number) {
  const totalSeconds = Math.floor((cycleTime / 90) * 24 * 60 * 60) % (24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => value.toString().padStart(2, '0')).join(':');
}

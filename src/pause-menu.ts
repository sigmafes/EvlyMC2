import * as THREE from 'three';
import { playClick } from './ui-sound';
import { lockPointer } from './is-touch';

export type ModelAdjustments = {
  head: { x: number; y: number; z: number };
  torso: { x: number; y: number; z: number };
  armLeft: { x: number; y: number; z: number };
  armRight: { x: number; y: number; z: number };
  legs: { x: number; y: number; z: number };
};

export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly pauseView: HTMLElement;
  private readonly optionsView: HTMLElement;
  private readonly fovSlider: HTMLInputElement;
  private readonly sensitivitySlider: HTMLInputElement;
  private readonly renderDistanceSlider: HTMLInputElement;
  private readonly fogToggle: HTMLButtonElement;
  private readonly smoothLightingToggle: HTMLButtonElement;
  private readonly alexSkinToggle: HTMLButtonElement;
  private readonly viewBobToggle: HTMLButtonElement;
  private fogEnabled = true;
  private smoothLightingEnabled = true;
  private alexSkinEnabled = false;
  private viewBobEnabled = true;
  private underwater = false;
  private paused = false;
  mouseSensitivity = 100;

  modelAdjustments: ModelAdjustments = {
    head: { x: 0, y: 0, z: 0 },
    torso: { x: 0, y: 0, z: 0 },
    armLeft: { x: 0, y: 0, z: 0 },
    armRight: { x: 0, y: 0, z: 0 },
    legs: { x: 0, y: 0, z: 0 },
  };

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly scene: THREE.Scene,
    private readonly fog: THREE.Fog,
    private readonly onSmoothLightingChange: (enabled: boolean) => void,
    private readonly onAlexSkinChange: (slim: boolean) => void = () => {},
    private readonly onRenderDistanceChange: (chunks: number) => void = () => {},
    private readonly onLeaveWorld: () => void = () => {},
    private readonly onViewBobChange: (enabled: boolean) => void = () => {},
  ) {
    this.root = document.querySelector<HTMLElement>('#pause-menu')!;
    this.pauseView = this.root.querySelector<HTMLElement>('#pause-view')!;
    this.optionsView = this.root.querySelector<HTMLElement>('#options-view')!;
    this.fovSlider = this.root.querySelector<HTMLInputElement>('#fov-slider')!;
    this.sensitivitySlider = this.root.querySelector<HTMLInputElement>('#sensitivity-slider')!;
    this.renderDistanceSlider = this.root.querySelector<HTMLInputElement>('#render-distance-slider')!;
    this.fogToggle = this.root.querySelector<HTMLButtonElement>('#fog-toggle')!;
    this.smoothLightingToggle = this.root.querySelector<HTMLButtonElement>('#smooth-lighting-toggle')!;
    this.alexSkinToggle = this.root.querySelector<HTMLButtonElement>('#alex-skin-toggle')!;
    this.viewBobToggle = this.root.querySelector<HTMLButtonElement>('#view-bob-toggle')!;

    this.fovSlider.addEventListener('input', this.updateFov);
    this.fovSlider.addEventListener('input', () => {
      this.root.querySelector<HTMLOutputElement>('#fov-value')!.value = this.fovSlider.value;
    });
    this.sensitivitySlider.addEventListener('input', () => {
      this.mouseSensitivity = Number(this.sensitivitySlider.value);
      this.root.querySelector<HTMLOutputElement>('#sensitivity-value')!.value = this.sensitivitySlider.value;
    });
    this.renderDistanceSlider.addEventListener('change', () => {
      this.root.querySelector<HTMLOutputElement>('#render-distance-value')!.value = this.renderDistanceSlider.value;
      this.onRenderDistanceChange(Number(this.renderDistanceSlider.value));
    });
    this.renderDistanceSlider.addEventListener('input', () => {
      this.root.querySelector<HTMLOutputElement>('#render-distance-value')!.value = this.renderDistanceSlider.value;
    });
    this.fogToggle.addEventListener('click', () => {
      this.fogEnabled = !this.fogEnabled;
      this.updateFogToggle();
      this.applyFog();
    });
    this.smoothLightingToggle.addEventListener('click', () => {
      this.smoothLightingEnabled = !this.smoothLightingEnabled;
      this.updateToggle(this.smoothLightingToggle, this.smoothLightingEnabled);
      this.onSmoothLightingChange(this.smoothLightingEnabled);
    });
    this.alexSkinToggle.addEventListener('click', () => {
      this.alexSkinEnabled = !this.alexSkinEnabled;
      this.updateToggle(this.alexSkinToggle, this.alexSkinEnabled);
      this.onAlexSkinChange(this.alexSkinEnabled);
    });
    this.viewBobToggle.addEventListener('click', () => {
      this.viewBobEnabled = !this.viewBobEnabled;
      this.updateToggle(this.viewBobToggle, this.viewBobEnabled);
      this.onViewBobChange(this.viewBobEnabled);
    });
    this.root.querySelector<HTMLButtonElement>('#back-to-game')!.addEventListener('click', this.close);
    this.root.querySelector<HTMLButtonElement>('#open-options')!.addEventListener('click', () => this.showOptions(true));
    this.root.querySelector<HTMLButtonElement>('#options-back')!.addEventListener('click', () => this.showOptions(false));
    this.root.querySelector<HTMLButtonElement>('#leave-world')!.addEventListener('click', () => this.onLeaveWorld());

    // UI click for every button in the pause menu / its options.
    this.root.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button')) playClick();
    });
    document.addEventListener('keydown', this.onKeyDown);
    this.updateFov();
    this.updateFogToggle();
    this.updateToggle(this.smoothLightingToggle, true);
    this.onSmoothLightingChange(true);
    this.updateToggle(this.alexSkinToggle, this.alexSkinEnabled);
    this.updateToggle(this.viewBobToggle, this.viewBobEnabled);
  }

  /** Sync the in-game options UI to the persisted settings (called from main.ts). */
  setViewBob(enabled: boolean) {
    this.viewBobEnabled = enabled;
    this.updateToggle(this.viewBobToggle, enabled);
  }

  get isPaused() { return this.paused; }

  /** On-screen Pause button. */
  toggle() { if (this.paused) this.close(); else this.open(); }

  private open = () => {
    this.paused = true;
    this.root.hidden = false;
    this.showOptions(false);
    document.exitPointerLock();
  };

  private close = () => {
    this.paused = false;
    this.root.hidden = true;
    this.showOptions(false);
    lockPointer(document.querySelector<HTMLCanvasElement>('#game-canvas'));
  };

  private showOptions(show: boolean) {
    this.pauseView.hidden = show;
    this.optionsView.hidden = !show;
  }

  get baseFov() {
    return Number(this.fovSlider.value);
  }

  setUnderwater(underwater: boolean) {
    if (this.underwater === underwater) return;
    this.underwater = underwater;
    this.updateFov();
  }

  private updateFov = () => {
    this.camera.fov = Number(this.fovSlider.value) - (this.underwater ? 10 : 0);
    this.camera.updateProjectionMatrix();
  };

  private applyFog() {
    this.scene.fog = this.fogEnabled ? this.fog : null;
  }

  private updateFogToggle() {
    this.updateToggle(this.fogToggle, this.fogEnabled);
  }

  private updateToggle(button: HTMLButtonElement, enabled: boolean) {
    const label = button.dataset.label ?? '';
    const onWord = button.dataset.on ?? 'ON';
    const offWord = button.dataset.off ?? 'OFF';
    button.querySelector<HTMLElement>('.toggle-label')!.textContent = `${label}: ${enabled ? onWord : offWord}`;
    button.dataset.enabled = enabled ? 'true' : 'false';
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Tab' || event.repeat) return;
    event.preventDefault();
    if (this.paused) this.close();
    else this.open();
  };
}

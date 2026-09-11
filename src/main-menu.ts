import * as THREE from 'three';
import { enterFullscreen } from './fullscreen';
import logoUrl from '../gui/logo.png';
import pano0 from '../gui/bg/panorama_0.png';
import pano1 from '../gui/bg/panorama_1.png';
import pano2 from '../gui/bg/panorama_2.png';
import pano3 from '../gui/bg/panorama_3.png';
import pano4 from '../gui/bg/panorama_4.png';
import pano5 from '../gui/bg/panorama_5.png';
import { GameSettings, loadSettings, saveSettings } from './settings';
import track0 from '../gui/bg/beginning_2.ogg';
import track1 from '../gui/bg/floating_trees.ogg';
import track2 from '../gui/bg/moog_city_2.ogg';
import track3 from '../gui/bg/mutation.ogg';
import splashRaw from '../gui/splash.txt?raw';
import { playClick } from './ui-sound';
import { WorldSelect } from './world-select';
import { isTouchDevice } from './is-touch';
import { InventoryDoll } from './inventory-doll';
import { applySkinTexture, resetSkinTexture } from './player-model';
import {
  loadPlayerName, savePlayerName, clearPlayerSkin,
  readAndValidateSkinFile, applyPersistedSkin, savePlayerSkinDataUrl,
} from './player-skin';

const MUSIC = [track0, track1, track2, track3];
const SPLASHES = splashRaw.split('\n').map((s) => s.trim()).filter(Boolean);
const MUSIC_SILENCE_MS = 15_000;

type MainMenuHandlers = {
  onSingleplayer: () => void;
};

/**
 * Pre-game main menu: a rotating panorama skybox (viewed from inside the cube),
 * the logo, and Singleplayer / Options buttons.
 */
export class MainMenu {
  private readonly root = document.querySelector<HTMLElement>('#main-menu')!;
  private readonly optionsRoot = document.querySelector<HTMLElement>('#menu-options')!;
  private readonly playerOptionsRoot = document.querySelector<HTMLElement>('#player-options')!;
  private readonly playerOptionsDoll = new InventoryDoll({
    canvasSelector: '#player-options-doll',
    containerSelector: '#player-options-body',
    width: 196,
    height: 280,
  });
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(90, 1, 0.01, 10);
  private rafId = 0;
  private time = 0;

  // Menu music: random track, 15s of silence between tracks, no consecutive repeat.
  private readonly audio = new Audio();
  private lastTrack = -1;
  private musicTimer = 0;

  private worldSelect: WorldSelect | null = null;

  constructor(handlers: MainMenuHandlers) {
    (document.querySelector<HTMLImageElement>('#menu-logo')!).src = logoUrl;

    if (SPLASHES.length > 0) {
      const splash = document.querySelector<HTMLElement>('#menu-splash')!;
      const phrase = SPLASHES[Math.floor(Math.random() * SPLASHES.length)];
      splash.textContent = phrase;
      if (phrase.length > 24) splash.style.fontSize = '15px';
    }

    this.audio.volume = 0.4;
    this.audio.addEventListener('ended', () => {
      this.musicTimer = window.setTimeout(() => this.playNextTrack(), MUSIC_SILENCE_MS);
    });
    // The menu is built ~1s before the intro finishes fading, so kick the music
    // off now — the intro video (with sound) already counts as the user gesture.
    // Keep a pointerdown fallback in case autoplay is still blocked.
    this.playNextTrack();
    document.addEventListener('pointerdown', this.startMusic, { once: true });

    // --- Panorama: a size-2 cube with the images on the inside, camera at centre.
    const canvas = document.querySelector<HTMLCanvasElement>('#panorama-canvas')!;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Six planes instead of a box: each is slightly oversized so neighbours
    // overlap by ~1px and the seams between them disappear.
    const loader = new THREE.TextureLoader();
    const OVERLAP = 0.02;
    const planeGeo = new THREE.PlaneGeometry(2 + OVERLAP, 2 + OVERLAP);
    const face = (
      url: string,
      rot: [number, number, number],
      pos: [number, number, number],
    ) => {
      const tex = loader.load(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      const mesh = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      mesh.rotation.set(rot[0], rot[1], rot[2]);
      mesh.position.set(pos[0], pos[1], pos[2]);
      return mesh;
    };
    // Panorama: 0..3 are the four walls in numeric order going around (the camera
    // pans -Z -> -X -> +Z -> +X). 4 = top, 5 = bottom, each rolled 180°.
    const pano = new THREE.Group();
    pano.add(
      face(pano2, [0, 0, 0], [0, 0, -1]),
      face(pano1, [0, Math.PI / 2, 0], [-1, 0, 0]),
      face(pano0, [0, Math.PI, 0], [0, 0, 1]),
      face(pano3, [0, -Math.PI / 2, 0], [1, 0, 0]),
      face(pano4, [Math.PI / 2, 0, Math.PI], [0, 1, 0]),
      face(pano5, [-Math.PI / 2, 0, -Math.PI], [0, -1, 0]),
    );
    this.scene.add(pano);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.rafId = requestAnimationFrame(this.tick);

    // --- Buttons ---
    // Any button/toggle in the menu or options plays the UI click.
    const clickSfx = (event: Event) => {
      if ((event.target as HTMLElement).closest('button')) playClick();
    };
    this.root.addEventListener('click', clickSfx);
    this.optionsRoot.addEventListener('click', clickSfx);
    this.playerOptionsRoot.addEventListener('click', clickSfx);

    this.root.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button');
      if (!button) return;
      if (button.dataset.action === 'singleplayer') {
        this.openWorldSelect(handlers);
      } else if (button.dataset.action === 'options') {
        this.optionsRoot.hidden = false;
      } else if (button.id === 'open-player-options') {
        this.openPlayerOptions();
      }
    });
    this.optionsRoot.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button');
      if (button?.dataset.action === 'options-back') this.optionsRoot.hidden = true;
    });
    this.playerOptionsRoot.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('.mc-button');
      if (button?.dataset.action === 'player-options-back') this.closePlayerOptions();
    });
    this.bindOptions();
    this.bindPlayerOptions();
  }

  private openPlayerOptions(): void {
    this.playerOptionsRoot.hidden = false;
    this.playerOptionsDoll.setSlim(loadSettings().alexSkin);
    this.playerOptionsDoll.setActive(true);
  }

  private closePlayerOptions(): void {
    this.playerOptionsRoot.hidden = true;
    this.playerOptionsDoll.setActive(false);
  }

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);
    this.time += 1 / 60;
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.time * 0.05;
    this.camera.rotation.x = -0.12 + Math.sin(this.time * 0.15) * 0.04;
    this.renderer.render(this.scene, this.camera);
  };

  private resize = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private openWorldSelect(handlers: MainMenuHandlers) {
    if (!this.worldSelect) {
      this.worldSelect = new WorldSelect({
        onPlay: () => {
          enterFullscreen(); // still inside the Play button's click gesture
          this.dispose();
          this.root.hidden = true;
          handlers.onSingleplayer();
        },
        onCancel: () => { /* just hides itself; panorama stays behind */ },
      });
    }
    this.worldSelect.open();
  }

  private startMusic = () => {
    // Only needed if the earlier autoplay attempt was blocked.
    if (this.audio.paused) this.playNextTrack();
  };

  private playNextTrack() {
    let i = Math.floor(Math.random() * MUSIC.length);
    if (MUSIC.length > 1 && i === this.lastTrack) i = (i + 1) % MUSIC.length;
    this.lastTrack = i;
    this.audio.src = MUSIC[i];
    this.audio.currentTime = 0;
    void this.audio.play().catch(() => { /* autoplay still blocked */ });
  }

  private dispose() {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.resize);
    document.removeEventListener('pointerdown', this.startMusic);
    clearTimeout(this.musicTimer);
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.renderer.dispose();
  }

  private bindOptions() {
    const settings = loadSettings();

    const slider = (id: string, out: string, key: keyof GameSettings) => {
      const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
      const output = document.querySelector<HTMLOutputElement>(`#${out}`)!;
      input.value = String(settings[key]);
      output.value = input.value;
      input.addEventListener('input', () => { output.value = input.value; });
      input.addEventListener('change', () => saveSettings({ [key]: Number(input.value) }));
    };
    slider('menu-fov', 'menu-fov-value', 'fov');
    slider('menu-sensitivity', 'menu-sensitivity-value', 'sensitivity');
    slider('menu-touch-sensitivity', 'menu-touch-sensitivity-value', 'touchSensitivity');
    slider('menu-button-opacity', 'menu-button-opacity-value', 'buttonOpacity');
    slider('menu-render-distance', 'menu-render-distance-value', 'renderDistance');
    // Android-only settings: nothing to tune on desktop (no touch look-drag, no
    // on-screen buttons), so grey them out there.
    if (!isTouchDevice()) {
      document.querySelector<HTMLInputElement>('#menu-touch-sensitivity')!.disabled = true;
      document.querySelector<HTMLInputElement>('#menu-button-opacity')!.disabled = true;
    }

    const toggle = (id: string, key: 'smoothLighting' | 'fog' | 'alexSkin' | 'viewBob') => {
      const button = document.querySelector<HTMLButtonElement>(`#${id}`)!;
      const label = button.querySelector<HTMLElement>('.toggle-label')!;
      const name = button.dataset.label ?? '';
      const onWord = button.dataset.on ?? 'ON';
      const offWord = button.dataset.off ?? 'OFF';
      let value = settings[key];
      const paint = () => {
        label.textContent = `${name}: ${value ? onWord : offWord}`;
        button.dataset.enabled = value ? 'true' : 'false';
      };
      paint();
      button.addEventListener('click', () => {
        value = !value;
        paint();
        saveSettings({ [key]: value });
      });
    };
    toggle('menu-smooth-lighting', 'smoothLighting');
    toggle('menu-fog', 'fog');
    toggle('menu-alex-skin', 'alexSkin');
    toggle('menu-view-bob', 'viewBob');
  }

  private bindPlayerOptions() {
    applyPersistedSkin((image) => applySkinTexture(image));

    const nameInput = document.querySelector<HTMLInputElement>('#player-name-input')!;
    nameInput.value = loadPlayerName();
    nameInput.addEventListener('change', () => {
      savePlayerName(nameInput.value);
      nameInput.value = loadPlayerName(); // reflect the trimmed/defaulted value back
    });

    const fileInput = document.querySelector<HTMLInputElement>('#skin-file-input')!;
    const errorEl = document.querySelector<HTMLElement>('#skin-import-error')!;
    const showError = (message: string | null) => {
      errorEl.hidden = !message;
      errorEl.textContent = message ?? '';
    };

    document.querySelector<HTMLButtonElement>('#import-skin-btn')!.addEventListener('click', () => {
      fileInput.click();
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = ''; // allow re-selecting the same file after a failed import
      if (!file) return;
      void (async () => {
        const result = await readAndValidateSkinFile(file);
        if (!result.ok) {
          showError(result.error);
          return;
        }
        showError(null);
        applySkinTexture(result.image);
        savePlayerSkinDataUrl(result.dataUrl);
      })();
    });

    document.querySelector<HTMLButtonElement>('#reset-skin-btn')!.addEventListener('click', () => {
      resetSkinTexture();
      clearPlayerSkin();
      showError(null);
    });
  }
}

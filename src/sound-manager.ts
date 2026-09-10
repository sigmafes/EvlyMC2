/** Handle to a looping sound started with {@link SoundManager.startLoop}. */
export interface LoopHandle {
  setVolume(v: number): void;
  stop(): void;
}

export class SoundManager {
  private audioContext: AudioContext | null = null;
  private soundCache = new Map<string, AudioBuffer>();
  private activeSounds = new Set<AudioBufferSourceNode>();
  private loops = new Set<AudioBufferSourceNode>();

  async initialize() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  private async loadSoundInternal(fullPath: string, cacheKey: string): Promise<AudioBuffer> {
    if (this.soundCache.has(cacheKey)) {
      return this.soundCache.get(cacheKey)!;
    }

    // Try loading with various extension combinations
    const extensions = ['.ogg', '.mp3', '.ogg.mp3', '.mp3.ogg'];

    for (const ext of extensions) {
      try {
        const url = new URL(`${fullPath}${ext}`, import.meta.url).href;
        const response = await fetch(url);
        if (!response.ok) continue;

        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);
        this.soundCache.set(cacheKey, audioBuffer);
        return audioBuffer;
      } catch (error) {
        continue;
      }
    }

    console.warn(`Could not load sound: ${fullPath}`);
    const ctx = this.audioContext!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    return buffer;
  }

  async loadSound(soundName: string, variant: number): Promise<AudioBuffer> {
    const key = `${soundName}_${variant}`;
    const soundNameFormatted = soundName.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join('_');
    const isLiquidSound = soundName.includes('water_place') || soundName.includes('lava_place') || soundName.includes('fizz');
    // Block dig/hit/mine/place sounds now live in sounds/blocks/.
    const folder = isLiquidSound ? '../sounds/liquids/' : '../sounds/blocks/';
    const baseUrl = `${folder}${soundNameFormatted}${variant}`;
    return this.loadSoundInternal(baseUrl, key);
  }

  /** Wire a decoded buffer to the graph and start it. `loop` sources go in `loops`. */
  private spawn(buffer: AudioBuffer, volume: number, loop: boolean): AudioBufferSourceNode | null {
    const ctx = this.audioContext;
    if (!ctx) return null;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;

    const gainNode = ctx.createGain();
    gainNode.gain.value = volume;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    (source as any)._gain = gainNode;

    const bucket = loop ? this.loops : this.activeSounds;
    source.onended = () => { bucket.delete(source); };
    bucket.add(source);
    source.start(0);
    return source;
  }

  playSound(soundName: string, volume: number = 1) {
    if (!this.audioContext) return;
    const variant = Math.floor(Math.random() * 3) + 1;
    this.loadSound(soundName, variant)
      .then((buffer) => this.spawn(buffer, volume, false))
      .catch((err) => console.error(`Failed to play sound ${soundName}:`, err));
  }

  playSingleSound(soundName: string, volume: number = 1) {
    if (!this.audioContext) return;
    const isLiquidSound = soundName.toLowerCase().includes('fizz');
    const folder = isLiquidSound ? '../sounds/liquids/' : '../sounds/';
    this.loadSoundInternal(`${folder}${soundName}`, soundName)
      .then((buffer) => this.spawn(buffer, volume, false))
      .catch((err) => console.error(`Failed to play sound ${soundName}:`, err));
  }

  // --- Generic API (exact casing, path relative to `sounds/`) ---

  /** Play one of `<relPath>1`..`<relPath>N`, chosen at random. */
  playRandom(relPath: string, count: number, volume: number = 1) {
    if (!this.audioContext || count < 1) return;
    const variant = Math.floor(Math.random() * count) + 1;
    this.loadSoundInternal(`../sounds/${relPath}${variant}`, `${relPath}${variant}`)
      .then((buffer) => this.spawn(buffer, volume, false))
      .catch((err) => console.error(`Failed to play sound ${relPath}${variant}:`, err));
  }

  /** Play a single file `<relPath>` (no numeric suffix). */
  playOne(relPath: string, volume: number = 1) {
    if (!this.audioContext) return;
    this.loadSoundInternal(`../sounds/${relPath}`, relPath)
      .then((buffer) => this.spawn(buffer, volume, false))
      .catch((err) => console.error(`Failed to play sound ${relPath}:`, err));
  }

  /**
   * Start a looping sound. Returns a handle to fade / stop it. Safe to call
   * before the buffer has decoded (it starts once ready, unless stopped first).
   */
  startLoop(relPath: string, volume: number = 1): LoopHandle {
    let node: AudioBufferSourceNode | null = null;
    let stopped = false;
    let pendingVolume = volume;

    this.loadSoundInternal(`../sounds/${relPath}`, relPath)
      .then((buffer) => {
        if (stopped || !this.audioContext) return;
        node = this.spawn(buffer, pendingVolume, true);
      })
      .catch((err) => console.error(`Failed to loop sound ${relPath}:`, err));

    return {
      setVolume: (v: number) => {
        pendingVolume = v;
        const gain = node && (node as any)._gain as GainNode | undefined;
        if (gain && this.audioContext) {
          gain.gain.setTargetAtTime(v, this.audioContext.currentTime, 0.08);
        }
      },
      stop: () => {
        stopped = true;
        if (node) {
          try { node.stop(); } catch { /* already stopped */ }
          this.loops.delete(node);
          node = null;
        }
      },
    };
  }

  stopAll() {
    for (const source of this.activeSounds) {
      try { source.stop(); } catch { /* noop */ }
    }
    for (const source of this.loops) {
      try { source.stop(); } catch { /* noop */ }
    }
    this.activeSounds.clear();
    this.loops.clear();
  }
}

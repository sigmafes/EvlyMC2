import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

/** Reproducible RNG (mulberry32) so the star field is identical every run. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1 at noon, 0 at night, ramps through dawn/dusk (LCE sky brightness curve). */
function daylight(td: number): number {
  return THREE.MathUtils.clamp(Math.cos(td * TWO_PI) * 2 + 0.5, 0, 1);
}

/** LCE `Level::getStarBrightness`. */
function starBrightness(td: number): number {
  const b = THREE.MathUtils.clamp(1 - (Math.cos(td * TWO_PI) * 2 + 0.25), 0, 1);
  return b * b * 0.5;
}

/**
 * Sunrise/sunset window. `null` during full day and night. `aa` runs 1 -> 0 as
 * the sky darkens at dusk (and 0 -> 1 as it brightens at dawn); `strength` is the
 * opacity envelope (0 at the edges, 1 mid-window).
 */
function sunsetPhase(td: number): { strength: number; aa: number } | null {
  const tt = Math.cos(td * TWO_PI);
  const span = 0.4;
  if (tt < -span || tt > span) return null;
  const aa = (tt / span) * 0.5 + 0.5;
  return { strength: Math.sin(aa * Math.PI), aa };
}

const GLOW_ORANGE: [number, number, number] = [1.0, 0.478, 0.118]; // 0xff7a1e
const GLOW_PURPLE: [number, number, number] = [0.12, 0.045, 0.22]; // deep, dark purple
const GLOW_BLACK: [number, number, number] = [0, 0, 0];

function mix3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Orange while the sky is still lit, through purple, to black just before it fades. */
function glowColor(aa: number): [number, number, number] {
  if (aa >= 0.55) return GLOW_ORANGE;
  if (aa >= 0.25) return mix3(GLOW_PURPLE, GLOW_ORANGE, (aa - 0.25) / 0.3);
  return mix3(GLOW_BLACK, GLOW_PURPLE, aa / 0.25);
}

/** Radial alpha mask (grayscale = alpha): opaque core, long gradual fade to the rim. */
function makeRadialAlpha(stops: [number, string][]): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [t, c] of stops) g.addColorStop(t, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Tiling white-on-transparent cloud texture: hard-edged blocky squares. */
function makeCloudTexture(): THREE.CanvasTexture {
  const S = 256;
  const GRID = 32;        // macro cells -> each cloud "pixel" is S/GRID = 8 px
  const CELL = S / GRID;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;

  const rand = mulberry32(0xc10d);
  const octaves = [
    { size: 4, amp: 0.6 },
    { size: 8, amp: 0.3 },
    { size: 16, amp: 0.1 },
  ];
  const grids = octaves.map((o) => {
    const g = new Float32Array(o.size * o.size);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    return g;
  });
  const sample = (grid: Float32Array, size: number, u: number, v: number): number => {
    const gx = u * size, gy = v * size;
    const x0 = ((Math.floor(gx) % size) + size) % size;
    const y0 = ((Math.floor(gy) % size) + size) % size;
    const x1 = (x0 + 1) % size, y1 = (y0 + 1) % size;
    let fx = gx - Math.floor(gx), fy = gy - Math.floor(gy);
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = grid[y0 * size + x0], b = grid[y0 * size + x1];
    const c = grid[y1 * size + x0], d = grid[y1 * size + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };

  ctx.clearRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const u = (cx + 0.5) / GRID;
      const v = (cy + 0.5) / GRID;
      let n = 0;
      octaves.forEach((o, i) => { n += o.amp * sample(grids[i], o.size, u, v); });
      if (n > 0.56) ctx.fillRect(cx * CELL, cy * CELL, CELL, CELL); // solid square, no smoothing
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * Sun, moon, stars, dawn/dusk glow and scrolling clouds.
 * Ported from Minecraft LCE (LevelRenderer::renderSky / renderStars / renderClouds).
 * `td` (time of day) is 0..1 with 0 = noon, 0.5 = midnight, matching LCE.
 */
export class SkyRenderer {
  private readonly group = new THREE.Group();     // tracks the camera position
  private readonly celestial = new THREE.Group(); // spins once per day (stars)
  private readonly sun: THREE.Mesh;
  private readonly moon: THREE.Mesh;
  private readonly sunGlow: THREE.Sprite;
  private readonly moonGlow: THREE.Sprite;
  private readonly stars: THREE.Points;
  private readonly glow: THREE.Mesh;
  private readonly clouds: THREE.Mesh;
  private readonly cloudTex: THREE.CanvasTexture;
  private readonly camPos = new THREE.Vector3();
  private readonly tmpColor = new THREE.Color();
  private cloudTime = 0;

  private readonly SUN_DIST = 300;
  private readonly CLOUD_WORLD_Y = 150;
  private readonly CLOUD_SCROLL = 0.6;
  private readonly CLOUD_SPAN = 420; // world blocks per cloud-texture tile

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.group.add(this.celestial);
    scene.add(this.group);

    // Sun / moon: camera-facing white squares (billboarded each frame).
    const square = (size: number, color: number): THREE.Mesh => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size, size),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 1,
          depthWrite: false,
          depthTest: true, // occluded by world blocks
          fog: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      m.renderOrder = 3; // above the horizon glow ring (renderOrder 1)
      return m;
    };
    this.sun = square(70, 0xffffff);
    this.moon = square(46, 0xffffff);
    this.group.add(this.sun, this.moon);

    // Dense white glow behind the sun and moon.
    const glowTex = makeRadialAlpha([
      [0, '#ffffff'],
      [0.35, '#ffffff'],
      [0.62, '#9a9a9a'],
      [1, '#000000'],
    ]);
    const halo = (size: number): THREE.Sprite => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        depthTest: true, // occluded by world blocks
        fog: false,
        blending: THREE.AdditiveBlending,
      }));
      s.scale.set(size, size, 1);
      s.renderOrder = 2; // above the horizon glow ring, below the sun/moon disc
      return s;
    };
    this.sunGlow = halo(150);
    this.moonGlow = halo(150);
    this.group.add(this.sunGlow, this.moonGlow);

    this.stars = this.buildStars();
    this.celestial.add(this.stars);

    this.glow = this.buildGlow();
    this.group.add(this.glow);

    this.cloudTex = makeCloudTexture();
    this.clouds = this.buildClouds();
    this.group.add(this.clouds);
  }

  private buildStars(): THREE.Points {
    const N = 1500;
    const R = 320;
    const rand = mulberry32(10842);
    const pos: number[] = [];
    let placed = 0;
    while (placed < N) {
      const x = rand() * 2 - 1;
      const y = rand() * 2 - 1;
      const z = rand() * 2 - 1;
      const d = x * x + y * y + z * z;
      if (d >= 1 || d <= 0.01) continue;
      const inv = R / Math.sqrt(d);
      pos.push(x * inv, y * inv, z * inv);
      placed++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 2,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true, // terrain occludes them -> only visible through the sky
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = -9;
    return pts;
  }

  /**
   * A big horizontal disc below the camera, tinted with the dawn/dusk colour,
   * covering the whole lower sky and fading out at the horizon ring.
   */
  private buildGlow(): THREE.Mesh {
    const steps = 48;
    const R = this.SUN_DIST * 5;      // huge: reaches past the horizon line
    const rInner = R * 0.82;
    const rimLift = R * 0.12;         // flare the rim up so the tint rises above the horizon
    const positions: number[] = [0, 0, 0];        // centre (idx 0)
    const uvs: number[] = [0.5, 0.5];
    const uInner = 0.25; // rest of the fade lives in the texture -> long, soft gradient
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * TWO_PI;
      positions.push(Math.cos(a) * rInner, 0, Math.sin(a) * rInner);
      uvs.push(0.5 + uInner * Math.cos(a), 0.5 + uInner * Math.sin(a));
    }
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * TWO_PI;
      positions.push(Math.cos(a) * R, rimLift, Math.sin(a) * R);
      uvs.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    }
    const inner0 = 1;
    const outer0 = 1 + steps + 1;
    const idx: number[] = [];
    for (let i = 0; i < steps; i++) {
      idx.push(0, inner0 + i, inner0 + i + 1);
      idx.push(inner0 + i, outer0 + i, inner0 + i + 1);
      idx.push(inner0 + i + 1, outer0 + i, outer0 + i + 1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xff7a1e,           // orange
      alphaMap: makeRadialAlpha([
        [0, '#ffffff'],
        [0.4, '#ffffff'],
        [0.6, '#c0c0c0'],
        [0.78, '#707070'],
        [0.9, '#2a2a2a'],
        [1, '#000000'],
      ]),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: true,           // let the terrain occlude it -> only shows past the blocks
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.visible = false;
    return mesh;
  }

  private buildClouds(): THREE.Mesh {
    const SIZE = 1200;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE);
    geo.rotateX(-Math.PI / 2);
    this.cloudTex.repeat.set(SIZE / this.CLOUD_SPAN, SIZE / this.CLOUD_SPAN);
    const mat = new THREE.MeshBasicMaterial({
      map: this.cloudTex,
      transparent: true,
      opacity: 1,
      alphaTest: 0.1,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -6;
    return mesh;
  }

  update(td: number, delta: number) {
    this.camera.getWorldPosition(this.camPos);
    this.group.position.copy(this.camPos);
    this.group.updateMatrixWorld(true);

    const a = td * TWO_PI;
    const up = Math.cos(a);         // >0 while the sun is above the horizon

    // Sun / moon: place on the day circle, billboard toward the camera.
    this.sun.position.set(0, up * this.SUN_DIST, Math.sin(a) * this.SUN_DIST);
    this.sun.lookAt(this.camPos);
    this.moon.position.set(0, -up * this.SUN_DIST, -Math.sin(a) * this.SUN_DIST);
    this.moon.lookAt(this.camPos);
    // Wide, gentle fade centred well below the horizon so the sun/moon sink and
    // dim gradually instead of popping in and out at the horizon line.
    const sunAboveHorizon = THREE.MathUtils.clamp((up + 0.4) * 2, 0, 1);
    const moonAboveHorizon = THREE.MathUtils.clamp((-up + 0.4) * 2, 0, 1);

    // Sun: fully opaque, just hidden when it has set. Moon keeps a soft fade.
    (this.sun.material as THREE.MeshBasicMaterial).opacity = 1;
    this.sun.visible = sunAboveHorizon > 0.001;
    (this.moon.material as THREE.MeshBasicMaterial).opacity = moonAboveHorizon;

    // Dense white glow behind each body (sprites auto-billboard).
    this.sunGlow.position.copy(this.sun.position);
    this.moonGlow.position.copy(this.moon.position);
    this.sunGlow.material.opacity = sunAboveHorizon * 0.05;
    this.moonGlow.material.opacity = moonAboveHorizon * 0.05;
    this.sunGlow.visible = sunAboveHorizon > 0.001;
    this.moonGlow.visible = moonAboveHorizon > 0.001;

    // Stars
    const sb = starBrightness(td);
    (this.stars.material as THREE.PointsMaterial).opacity = sb;
    this.stars.visible = sb > 0.001;
    this.celestial.rotation.x = a;

    // Horizon glow — only while the sun crosses the horizon. Colour shifts
    // orange -> purple -> black as the sky darkens (and back on the way up).
    const phase = sunsetPhase(td);
    if (phase && phase.strength > 0.001) {
      this.glow.visible = true;
      const mat = this.glow.material as THREE.MeshBasicMaterial;
      mat.opacity = phase.strength * 0.85;
      const c = glowColor(phase.aa);
      mat.color.setRGB(c[0], c[1], c[2]);
      this.glow.position.set(0, -50, 0);

      // Pull the fog toward the horizon colour (DayNightCycle set it this frame).
      const fog = this.scene.fog as THREE.Fog | THREE.FogExp2 | null;
      fog?.color.lerp(this.tmpColor.setRGB(c[0], c[1], c[2]), phase.strength);
    } else {
      this.glow.visible = false;
    }

    // Clouds: world-anchored height, texture scrolls with world position + time.
    // Additive white, fading out to nothing at night.
    this.cloudTime += delta;
    this.clouds.position.y = this.CLOUD_WORLD_Y - this.camPos.y;
    this.cloudTex.offset.x = (this.camPos.x + this.cloudTime * this.CLOUD_SCROLL) / this.CLOUD_SPAN;
    this.cloudTex.offset.y = this.camPos.z / this.CLOUD_SPAN;
    (this.clouds.material as THREE.MeshBasicMaterial).opacity = daylight(td);
  }
}

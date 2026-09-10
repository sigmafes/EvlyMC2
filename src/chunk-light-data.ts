export type LightChannel = 'skyLight' | 'blockLight';

export class ChunkLightData {
  readonly skyLight: Uint8Array;
  readonly blockLight: Uint8Array;
  readonly heightmap: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly depth: number,
  ) {
    const voxelCount = width * height * depth;
    this.skyLight = new Uint8Array(voxelCount);
    this.blockLight = new Uint8Array(voxelCount);
    this.heightmap = new Uint8Array(width * depth);
  }

  get(channel: LightChannel, x: number, y: number, z: number) {
    return this[channel][this.voxelIndex(x, y, z)] ?? 0;
  }

  set(channel: LightChannel, x: number, y: number, z: number, level: number) {
    this[channel][this.voxelIndex(x, y, z)] = Math.max(0, Math.min(15, Math.floor(level)));
  }

  getSurfaceHeight(x: number, z: number) {
    return this.heightmap[this.columnIndex(x, z)] ?? 0;
  }

  setSurfaceHeight(x: number, z: number, y: number) {
    this.heightmap[this.columnIndex(x, z)] = Math.max(0, Math.min(255, Math.floor(y)));
  }

  private voxelIndex(x: number, y: number, z: number) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || z < 0 || z >= this.depth) {
      throw new RangeError(`Coordenada de luz fuera del chunk: ${x}, ${y}, ${z}`);
    }
    return (y * this.depth + z) * this.width + x;
  }

  private columnIndex(x: number, z: number) {
    if (x < 0 || x >= this.width || z < 0 || z >= this.depth) {
      throw new RangeError(`Coordenada de heightmap fuera del chunk: ${x}, ${z}`);
    }
    return z * this.width + x;
  }
}

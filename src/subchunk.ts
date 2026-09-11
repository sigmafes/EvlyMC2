import * as THREE from 'three';
import { BlockMaterials } from './block';
import { buildSubchunkGeometry, BlockReader, LightReader, WaterDistanceReader, WaterFlowReader, BlockDataReader, SubchunkRenderStats } from './mesher';

// 24, not 16: with CHUNK_HEIGHT=152 that's ~7 subchunks/meshes per column
// instead of ~10 (-30% draw calls), still short enough that editing near the
// top of one doesn't force rebuilding an oversized mesh (32 would).
export const SUBCHUNK_HEIGHT = 24;

export class Subchunk {
  readonly mesh: THREE.Mesh;
  readonly center = new THREE.Vector3();
  stats: SubchunkRenderStats = { exposedFaces: 0, facesByMaterial: [], vertexCount: 0, indexCount: 0 };
  readonly minY: number;
  readonly maxY: number;
  private readLight: LightReader = () => 15;
  private readWaterDistance: WaterDistanceReader = () => 0;
  private readWaterFlow: WaterFlowReader = () => new THREE.Vector3();
  private readBlockData: BlockDataReader = () => undefined;
  private smoothLighting = false;
  private ambientOcclusion = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly materials: BlockMaterials,
    private readonly readBlock: BlockReader,
    minY: number,
    maxY: number,
    chunkMinX: number,
    chunkMinZ: number,
    buildImmediately = true,
  ) {
    this.minY = minY;
    this.maxY = maxY;
    this.center.set(chunkMinX + 7.5, (minY + maxY) / 2, chunkMinZ + 7.5);
    this.mesh = new THREE.Mesh();
    this.mesh.frustumCulled = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
    if (buildImmediately) this.rebuild();
  }

  rebuild() {
    const geometry = buildSubchunkGeometry(
      this.readBlock,
      this.minY,
      this.maxY,
      this.center.x - 7.5,
      this.center.z - 7.5,
      this.readLight,
      this.smoothLighting,
      this.ambientOcclusion,
      this.readWaterDistance,
      this.readWaterFlow,
      this.readBlockData,
      this.materials.atlas.rects,
      this.materials.atlas.atlasWidth,
      this.materials.atlas.atlasHeight,
    );
    const previousGeometry = this.mesh.geometry;
    this.mesh.geometry = geometry;
    this.stats = geometry.userData.renderStats ?? this.stats;
    // Order must match mesher.ts's MATERIAL_* indices (MATERIAL_OPAQUE=0..MATERIAL_FIRE=9).
    // Just 10 fixed slots now instead of one per block type - the shared
    // atlas material (`opaque`) covers most blocks; only render states that
    // can't share a material (transparency/tint/culling, or animated
    // scrolling liquids/fire) get their own slot here.
    this.mesh.material = [
      this.materials.opaque,
      this.materials.leaves,
      this.materials.glass,
      this.materials.ice,
      this.materials.torch,
      this.materials.waterStill,
      this.materials.waterFlow,
      this.materials.lavaStill,
      this.materials.lavaFlow,
      this.materials.fire,
    ];
    previousGeometry.dispose();
  }

  setLightReader(readLight: LightReader) {
    this.readLight = readLight;
  }

  setWaterDistanceReader(readWaterDistance: WaterDistanceReader) {
    this.readWaterDistance = readWaterDistance;
  }

  setWaterFlowReader(readWaterFlow: WaterFlowReader) {
    this.readWaterFlow = readWaterFlow;
  }

  setBlockDataReader(readBlockData: BlockDataReader) {
    this.readBlockData = readBlockData;
  }

  setSmoothLighting(enabled: boolean) {
    this.smoothLighting = enabled;
  }

  setAmbientOcclusion(enabled: boolean) {
    this.ambientOcclusion = enabled;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(value: boolean) {
    this.mesh.visible = value;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
  }
}

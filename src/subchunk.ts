import * as THREE from 'three';
import { BlockId, BlockMaterials } from './block';
import { buildSubchunkGeometry, BlockReader, LightReader, WaterDistanceReader, WaterFlowReader, BlockDataReader, SubchunkRenderStats } from './mesher';

export const SUBCHUNK_HEIGHT = 16;

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
    );
    const previousGeometry = this.mesh.geometry;
    this.mesh.geometry = geometry;
    this.stats = geometry.userData.renderStats ?? this.stats;
    this.mesh.material = [
      this.materials[BlockId.BEDROCK],
      this.materials[BlockId.OAK_PLANKS],
      this.materials[BlockId.STONE],
      this.materials[BlockId.DIRT],
      this.materials[BlockId.GRASS],
      this.materials[BlockId.GLOWSTONE],
      this.materials[BlockId.OAK_LOG],
      this.materials[BlockId.WATER],
      this.materials[BlockId.OAK_LEAVES],
      this.materials[BlockId.SAND],
      this.materials[BlockId.FIRE],
      this.materials[BlockId.LAVA],
      this.materials[BlockId.COBBLESTONE],
      this.materials[BlockId.OBSIDIAN],
      this.materials[BlockId.ICE],
      this.materials[BlockId.COAL_ORE],
      this.materials[BlockId.IRON_ORE],
      this.materials[BlockId.GOLD_ORE],
      this.materials[BlockId.DIAMOND_ORE],
      this.materials[BlockId.EMERALD_ORE],
      this.materials[BlockId.LAPIS_ORE],
      this.materials[BlockId.REDSTONE_ORE],
      this.materials[BlockId.CRAFTING_TABLE],
      this.materials[BlockId.GLASS],
    ].flatMap((material) => Array.isArray(material) ? material : [material]);
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

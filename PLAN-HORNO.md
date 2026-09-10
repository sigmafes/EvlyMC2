# Plan: Horno, antorchas y fundido

Estado del trabajo en curso. Retomar desde la **Fase 2**.

## Decisiones tomadas
- `BlockDataStore` con **store IndexedDB propio** (no meter el estado en el save del mundo).
- Crear item **charcoal** aparte de coal → tronco fundido da **charcoal**.
- Swing continuo con click izq **siempre** (comportamiento MC), no solo con herramientas.
- Hielo **no** dropea. Sin sistema de durabilidad todavía ("vamos parte por parte").
- Sin horno aún al definir recetas de herramientas, así que hierro/oro usan `iron_ingot`/`gold_ingot`.

## Hecho

### Fase 0 — Bugfixes
- Brazo oculto en 1ª persona al equipar bloque/item (`arm.visible = !this.held`).
- Swing continuo mientras se mantiene click izq, aunque no se esté rompiendo nada
  (`updateAttackSwing` en `interaction.ts`).
- Partículas de minado/rotura tintadas por la luz del mundo (`particles.ts` recibe `light01`).

### Fase 1 — Bloque Vidrio (`BlockId.GLASS = 24`)
- `block.ts`: `opacity 1`, `cull false`, material con `alphaTest 0.5` + `DoubleSide`.
- `mesher.ts`: `MATERIAL_GLASS = 30`, `MATERIAL_COUNT = 31`, culling vidrio-con-vidrio.
- `subchunk.ts`, `block-sounds.ts` (tipo hielo), `block-hardness.ts` (0.3), sin drop,
  `creative-palette.ts` (`/give glass`), `particles.ts`, `block-inspector.ts`.

## Pendiente

### Fase 2 — Infraestructura de estado por-bloque  ✅ HECHO
- `src/idb.ts`: handle IndexedDB compartido, `evlymc` v2, stores `chunkEdits` + `blockData`.
  `ChunkEditStore` refactorizado para usarlo.
- `src/block-data.ts`: `BlockDataStore` (`Map<"x,y,z", { facing?: 0|1|2|3; lit?: boolean }>`),
  `load`/`get`/`set`/`delete`/`flush`, debounce 1.5s + flush en `visibilitychange`,
  `deleteSeed`. Helpers `FACING_TO_FACE_INDEX` (0->+Z, 1->+X, 2->-Z, 3->-X) y
  `facingTowardPlayer(yaw)`.
- `world.ts`: instancia `BlockDataStore`; `getBlockData` / `setBlockData` (remesh);
  `remove()` borra la entrada; `loadPersistedEdits`/`flushEdits` cubren ambos stores;
  reader `setBlockDataReader` cableado como `setLightReader`.
- `mesher.ts`/`subchunk.ts`/`chunk.ts`: `BlockDataReader` propagado; el mesher solo lo
  consulta para ids en `STATEFUL_BLOCKS`. `materialForFace(id, faceIndex, liquidDistance, data)`
  ya acepta `data` (sin usar todavía).
- `block.ts`: sets `STATEFUL_BLOCKS` y `ORIENTABLE_BLOCKS` (vacíos hasta la Fase 3), `isOrientable`.
- `interaction.ts`: al colocar un bloque de `ORIENTABLE_BLOCKS` escribe
  `facing = facingTowardPlayer(player.state.yaw)`.
- `worlds.ts`: al borrar un mundo se limpian ambos stores.

**Nota Fase 3:** basta con meter `FURNACE` en `STATEFUL_BLOCKS` + `ORIENTABLE_BLOCKS` y
añadir el `case` de `FURNACE` en `materialForFace` usando `data.facing` / `data.lit`.

### Fase 3 — Bloque Horno (`FURNACE`)
- Texturas ya en repo: `furnace_off/on/side/top.png`.
- Material array de 4: `[side, off, on, top]`. Top y bottom usan `furnace_top`.
- `materialForFace`: cara == `data.facing` → `lit ? on : off`; resto lados → `side`.
- Emisión **dinámica 15** cuando `lit` → hook `getEmission(id, x, y, z)` y re-propagar luz
  al cambiar el estado.
- Dureza 3.5, pico requerido (sin pico no dropea). Sonidos `stone_*`. Self-drop.
- Añadir a `INTERACTIVE_BLOCKS` (click derecho abre GUI).

### Fase 4 — Combustible y fundido
Constantes LCE (20 tps):
- Fundir 1 ítem = **200 ticks = 10 s**.
- Combustible: palo **5 s**, tabla **15 s**, tronco **15 s**, carbón/charcoal **80 s**.
- `src/smelting.ts`: `SMELTING` + `FUEL`.
  - `OAK_LOG` → `CHARCOAL`
  - `RAW_IRON` → `IRON_INGOT`
  - `RAW_GOLD` → `GOLD_INGOT`
  - `SAND` → `GLASS`
- `src/furnace.ts`: `FurnaceManager`, estado por posición
  `{ input, fuel, output, litTime, litDuration, cookTime }`, `tick(delta)` en el game loop.

### Fase 5 — GUI del horno
- Assets: `gui/furnace_gui.png`, `gui/Lit_progress.png` (llama), `gui/Burn_progress.png` (flecha).
- `index.html`: `<section id="furnace">` con slots input/fuel/output + espejo de los 36
  slots del inventario.
- `src/furnace-ui.ts`: calcado de `CraftingTableUI` (`attachExtraSlots`, `setExternalUiOpen`).
- El horno sigue cocinando con la GUI abierta.

### Fase 6 — Antorcha
- `textures/blocks/torch.png` ya está en el repo (desbloqueada).
- Una `TORCH` + facing ("up" = suelo, 0..3 = pared) usando el `BlockDataStore`.
- `opacity 0`, `emission 15`, `cull false`. Geometría dedicada tipo la de `FIRE`
  (poste 2x2x10 px + llama); variante pared inclinada con offset ~0.27.
- Requiere soporte sólido debajo/detrás. Dureza 0, self-drop, sonidos `wood_*`.

### Fase 7 — Recetas de crafteo (`crafting.ts`)
- Horno: `[[C,C,C],[C,_,C],[C,C,C]]` con `C = COBBLESTONE` → 1 `FURNACE`.
- Antorcha: `[[COAL],[STICK]]` → 4 `TORCH`.

## Notas de arquitectura útiles
- El mesher corre en el **hilo principal**, sin worker.
- Añadir un bloque toca: `block.ts` (enum + `blockLightProperties` + material),
  `mesher.ts` (`MATERIAL_*` + `MATERIAL_COUNT` + `materialForFace`), `subchunk.ts`
  (lista de materiales, el orden define los índices), `block-sounds.ts`,
  `block-hardness.ts`, `drops.ts`, `creative-palette.ts`, `particles.ts`,
  `block-inspector.ts`.
- `blockLightProperties`, `blockSounds` y `HARDNESS` son `Record<BlockId, …>` exhaustivos:
  si falta la clave nueva, TypeScript falla.

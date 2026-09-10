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

### Fase 3 — Bloque Horno (`FURNACE`)  ✅ HECHO
- `block.ts`: `BlockId.FURNACE = 25`; material array `[side, off, on, top]`;
  `blockLightProperties` opaco emisión 0 (dinámica via `emissionAt`);
  en `STATEFUL_BLOCKS` + `ORIENTABLE_BLOCKS` + `INTERACTIVE_BLOCKS`;
  const `FURNACE_LIT_LIGHT = 15`.
- `mesher.ts`: `MATERIAL_FURNACE_SIDE/_FRONT_OFF/_FRONT_ON/_TOP` (31..34), `MATERIAL_COUNT 35`.
  `materialForFace(FURNACE)`: top/bottom → `_TOP`; cara == `FACING_TO_FACE_INDEX[data.facing]`
  → `data.lit ? _FRONT_ON : _FRONT_OFF`; resto → `_SIDE`.
- `subchunk.ts`: `this.materials[BlockId.FURNACE]` en la lista (índices 31..34).
- `world.ts`: `emissionAt(id, x, y, z)` (dinámica para el horno); `setBlockData` re-propaga
  la luz de bloque cuando `lit` cambia (`queueBlockUpdate`).
- `light-engine.ts`: los 3 puntos que leían `blockLightProperties[id].emission` ahora usan
  `world.emissionAt(...)`.
- `block-hardness.ts` (3.5, pico requerido → sin pico no dropea), `block-sounds.ts` (`stone_*`),
  `drops.ts` (self-drop), `creative-palette.ts` (`/give furnace`), `particles.ts`, `block-inspector.ts`.
- `interaction.ts`: al colocar captura la posición exacta desde el callback de `add` y
  escribe `facing`. El click derecho sobre el horno llama `onInteract(FURNACE)` (no-op hasta
  la GUI de la Fase 5).

**Estado `lit`:** aún nunca se pone a `true` (lo hará el `FurnaceManager` de la Fase 4);
toda la ruta on/off + relight está lista.

### Fase 4 — Combustible y fundido  ✅ HECHO
- `item.ts`: `ItemId.CHARCOAL = 112` (textura `items/charcoal.png`). Además `MAX_BLOCK_ID`
  ahora se calcula del enum (bug: GLASS/FURNACE quedaban fuera de `isBlock`).
- `src/smelting.ts`: `COOK_SECONDS = 10`; `SMELT` (`OAK_LOG→CHARCOAL`, `SAND→GLASS`,
  `RAW_IRON→IRON_INGOT`, `RAW_GOLD→GOLD_INGOT`); `FUEL` en segundos
  (palo 5, tabla/tronco/mesa 15, carbón/charcoal 80). Helpers `smeltResult`, `isSmeltable`,
  `fuelSeconds`, `isFuel`.
- `block-data.ts`: `FurnaceState { input, fuel, output, cookTime, litTime, litDuration }`
  dentro de `BlockData.furnace`; `emptyFurnace()`; `BlockDataStore.forEach` para descubrir
  hornos al cargar.
- `world.ts`: `getFurnaceState` / `setFurnaceState` (sin remesh) / `eachFurnace`.
- `src/furnace.ts`: `FurnaceManager.tick(delta)` — enciende consumiendo 1 combustible cuando
  hay algo que fundir, quema `litTime`, avanza `cookTime` hasta 10s → mueve 1 al output;
  progreso decae sin receta; al cambiar encendido/apagado llama `setBlockData({lit})`;
  horno frío y vacío se borra del side-table. Cableado en `main.ts` (`tick` en el loop,
  gated por pausa).
- `interaction.ts`: al romper un horno suelta su contenido (input/fuel/output) antes de
  que se borre el block-data.
- **Verificado** con un test de nodo: 3 raw iron + 1 carbón → 3 lingotes, combustible
  consumido, `lit` [true→false] correcto.

**Falta la GUI (Fase 5)** para meter/sacar items; hasta entonces el `FurnaceManager` está
inerte (nadie llena `FurnaceState`).

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

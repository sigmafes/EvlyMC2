# Plan: bugfixes del cliente multiplayer

Diagnóstico hecho leyendo el código actual (no son suposiciones) antes de
planear nada. Cada fase abajo cita el archivo/línea donde está la causa real.
Orden pensado por dependencia: los sistemas base (luz, culling, GUI) van antes
que lo que se apoya en ellos, y lo más rápido de arreglar va primero para
tener victorias tempranas.

## Diagnóstico resumido

La causa raíz de la mayoría de estos bugs es la misma, repetida: **el
`multiplayer-game.ts` original nunca inicializó ni corrió varios sistemas del
singleplayer que no son opcionales**, no que estén rotos. No hace falta
reescribir nada — hace falta terminar de cablear lo que ya existe y funciona
en `src/`.

## Fase 10 — Ítems no se renderizan en slots/hotbar  ✅ HECHO
**Causa confirmada:** `renderSlot()` (`src/inventory.ts`) llama a
`renderBlockPreview()`/`renderItemIcon()` (`src/block-preview.ts`), que
dependen de que `initPreviewAtlases(sharedBlockAtlas)` se haya llamado antes
— sin eso, los recortes de textura fallan silenciosamente y el slot queda
vacío. `main.ts` lo llama; multiplayer nunca lo había hecho.

Cómo quedó: una línea, `await initPreviewAtlases(materials.atlas)` en
`initTerrain()`, justo después de crear `materials`. Sin efectos secundarios
raros — `initPreviewAtlases` solo reasigna dos variables de módulo, así que
es seguro llamarlo de nuevo si el jugador se reconecta en la misma pestaña.

## Fase 1 — Luz rota (bloques rotos aparecen negros)  ✅ HECHO
**Causa confirmada:** `applyBlockChange()` cambiaba el bloque y remesheaba el
chunk, pero nunca llamaba a `lightEngine.queueBlockUpdate()` ni a
`processUpdates()` — ninguna de las dos existía en todo el archivo. La luz se
calculaba una sola vez al generar el chunk y nunca se volvía a tocar. Un
bloque roto quedaba con la luz vieja (la de un bloque opaco, 0) → negro.

Cómo quedó: `applyBlockChange()` ahora captura `oldSkyLight`/`oldBlockLight`
vía `lightWorld.getLight(...)` ANTES de aplicar el cambio (igual que
`world.ts`), llama `lightEngine.queueBlockUpdate(...)` y drena la cola con
`processUpdates()` en el momento — no se esperó al loop de frame porque una
edición sola es barata y ya existía el mismo patrón de "un rebuild por
edición" sin batching (incluido el reemplazo histórico de ediciones al unirse
a un mundo).

## Fase 2 — Culling entre chunks no funciona  ✅ HECHO
**Causa confirmada:** `generateChunk()` mesheaba el chunk nuevo una vez pero
nunca avisaba a los chunks vecinos ya cargados que ahora tenían un vecino
real. Si un chunk se cargó antes de que su vecino existiera, su malla en ese
borde quedaba calculada asumiendo "vecino = aire" — cuando el vecino real
aparecía después, esa cara nunca se recalculaba. Singleplayer soluciona esto
con `markAdjacentChunksDirty(cx, cz)` en `world.ts`.

Cómo quedó: se creó `rebuildAdjacentChunks(cx, cz)`, compartida por dos
causas distintas (documentado en el propio código): un chunk que llega tarde
deja a sus vecinos con la cara del borde mal calculada, y la luz que se
propaga cruzando un límite de chunk deja al vecino con sombreado viejo aunque
el dato de luz ya esté bien. Se llama tanto en `generateChunk()` (cuando un
chunk nuevo entra) como al final de `applyBlockChange()` (Fase 1) — mismo
fix, dos disparadores.

## Fase 3 — Corazones/XP sin textura, HUD que no es el mismo  ✅ HECHO
**Causa confirmada:** `healthEl.textContent = '❤ '.repeat(...)` era texto
emoji, no la clase `Hud` real de singleplayer (`src/hud.ts`), que dibuja
`heart_full.png`/`heart_half.png` como elementos reales. No había ninguna
barra de XP en el DOM de multiplayer. La barra de XP en singleplayer **no
tiene lógica real** — `Hud.setXp()` existe pero `main.ts` nunca la llama con
un valor distinto de 0. Es puramente decorativa; no hacía falta portar
ningún sistema de progreso, solo el elemento.

Cómo quedó: `Hud` ya no tiene los ids hardcodeados a `#hud-hearts` etc. —
toma un parámetro opcional `{ hearts, bubbles, xpFill }` con esos mismos ids
como default, así `new Hud()` en singleplayer sigue funcionando sin tocar
nada ahí (mismo patrón de extracción que `third-person-camera.ts`).
Multiplayer crea su propio `#mp-hud` por `createElement` como cualquier otro
panel de este archivo, y pasa una instancia nueva de `Hud` apuntando a esos
ids — cero lógica duplicada, la animación de pop de burbuja y el conteo de
corazones son la clase real. `#mp-health`/`#mp-air` (los viejos, de texto) se
borraron de `index.html` y `style.css`.

## Fase 4 — Inventario/crafteo: GUI real + 2x2 embebido  ✅ HECHO
**Causa confirmada:** el inventario de multiplayer (`#mp-backpack`,
`#mp-craft-menu`) es CSS propio (flex/grid con fondo sólido), no reusa las
texturas reales (`gui/inventory.png`, `gui/Crafting_table_gui.png`,
`gui/slot.png`) que sí carga singleplayer vía `#backpack-panel`,
`#crafting-table-panel`, etc. (`src/style.css` línea ~151+). Además, el 2x2
de crafteo (Fase 10 del port anterior) quedó como panel separado (tecla C),
mientras que en singleplayer el 2x2 está **embebido dentro del propio
inventario** (`#backpack-craft`, 4 slots + resultado, ver `index.html` línea
~189) y el 3x3 es lo único que abre aparte (clic derecho a una mesa).

**Fix:**
- Fusionar el grid 2x2 de `#mp-craft-menu` (cuando `craftSide === 2`) DENTRO
  de `#mp-backpack`, igual que singleplayer — deja de abrirse con `C`
  independiente; se abre solo con `E`.
- El 3x3 (`craftSide === 3`, abierto al hacer clic en una mesa) sigue siendo
  su propio overlay, como el `#crafting-table` de singleplayer.
- CSS: reusar las mismas imágenes de `gui/` con el mismo posicionamiento por
  píxel que ya tiene singleplayer, aplicado a los ids de multiplayer
  (`#mp-backpack-panel`, etc.) — no reinventar el layout, copiar las reglas
  ya calibradas y solo cambiar el selector.

Cómo quedó: `#mp-backpack`/`#mp-backpack-panel` y `#mp-crafting-table`/
`#mp-crafting-table-panel` con `gui/inventory.png` y `gui/Crafting_table_gui.png`
reales, mismas coordenadas por píxel que singleplayer. El 2x2 quedó embebido
de verdad — `setBackpackOpen()` ahora manda `craftOpen({ table: null })` al
abrir, así el grid de 4 celdas dentro del panel tiene datos reales del
servidor todo el tiempo que la mochila está abierta, no un panel aparte con
`C`. `C` se eliminó del todo; `E` sigue siendo la única tecla, igual que
singleplayer.

**Simplificación real, no solo estética:** el click-to-pick-then-place que ya
existía usaba dos mensajes distintos (`moveSlot` para mochila↔mochila,
`craftMove` con zonas para todo lo que tocara el grid) — dos máquinas de
estado paralelas para lo mismo. Como abrir la mochila ahora abre siempre un
grid de crafteo del lado servidor, `session.craft` nunca es null mientras el
panel está visible, así que `craftMove` con `zone:'inventory'` en los dos
extremos ya hace exactamente lo mismo que `moveOrMergeSlot` en el servidor
(`arrayFor` devuelve `session.inventory` para ambos). Se unificó todo bajo un
solo estado "picked" y un solo handler de click — se borró el código
duplicado, no se agregó nada. El mensaje `moveSlot` se deja intacto en el
protocolo/servidor (nadie lo usa ya del lado cliente, mismo criterio que se
usó antes con `craft`/`craftableRecipes`).

**Nota de alcance:** al hacer este arreglo se notó que el horno
(`#mp-furnace`) tiene el mismo problema (caja gris genérica en vez de
`furnace_gui.png`) — no estaba en la lista de bugs reportada, así que no se
tocó. El horno además usa una interacción deliberadamente distinta (botones
"Meter combustible"/"Meter para fundir" en vez de click-to-pick, ya
documentado en el propio código como simplificación), así que el arreglo
ahí sería solo de coordenadas/textura, no una reestructuración — queda
anotado para cuando se pida.

## Fase 5 — Bloques instaminables + drops incorrectos  ✅ HECHO
Dos síntomas, una causa raíz compartida: `world-do.ts`'s `handleBreakBlock`
llama `getDrops(brokenId, true)` con `canHarvest` **fijo en `true`**, y el
cliente manda `breakBlock` apenas se hace clic, sin ningún tiempo de minado.

Singleplayer resuelve ambas cosas con **una sola función pura**,
`breakTime(id, heldItemId)` en `src/block-hardness.ts` — sin dependencias de
DOM/THREE, importable directo:
```ts
export function breakTime(id: BlockId, held: number | null | undefined): BreakInfo
// devuelve { time: segundos, canHarvest: boolean }
```
Ya calcula todo: si la herramienta correcta hace falta, si la que tenés
alcanza el tier, la velocidad según el tier, y el tiempo resultante.

**Fix (servidor, autoridad):**
- `world-do.ts`'s `handleBreakBlock` deja de asumir instantáneo: el cliente
  manda `breakBlock` recién cuando termina su temporizador local (ver abajo),
  y el servidor **valida de nuevo** con `breakTime()` usando el item
  seleccionado — nunca confía en el tiempo que dice el cliente.
- `getDrops(brokenId, breakTime(brokenId, heldId).canHarvest)` en vez de
  `true` fijo — así una piedra sin pico no dropea cobblestone, etc.

**Fix (cliente, sensación):**
- Portar el sistema de progreso de minado de `interaction.ts` (barra/overlay
  de "break stage" sprite, más rápido con la herramienta correcta) al
  cliente multiplayer: mientras se mantiene el clic, animar el overlay de
  rotura sobre el bloque apuntado usando el mismo `time` de `breakTime()`, y
  recién al completarse mandar `breakBlock` al servidor.
- Los sprites de break-stage (`break-overlay.ts`) son reusables tal cual
  (no dependen de World, solo de una posición y una textura).

Cómo quedó: `breakTime()` y `BreakOverlay` resultaron ser 100% reusables sin
fork — `breakTime()` solo importa `block.ts`/`tools.ts` (ambos ya se
importaban directo en el servidor), y `BreakOverlay` solo necesita una
`THREE.Scene` y una posición.

**Protocolo nuevo:** `breakStart` (arranca el minado, el servidor CAPTURA el
item seleccionado en ese instante y lo fija para todo el minado — cambiar de
slot a mitad de camino no acelera ni frena nada, igual que
`interaction.ts` de singleplayer, que tampoco recalcula si cambiás de
herramienta a mitad de camino) y `breakBlock` (igual que antes, ahora es la
señal de "terminé"). No hizo falta un mensaje de cancelar: un minado
abandonado que nunca manda `breakBlock` simplemente queda sin usar hasta que
se sobreescribe con el próximo `breakStart` — nada que limpiar.

**Validación del servidor:** ante un `breakBlock`, el servidor vuelve a
calcular `breakTime()` con el item que capturó al `breakStart` (nunca con el
que tenga seleccionado en ese momento, ni con nada que mande el cliente) y
rechaza si no pasó al menos el 80% del tiempo esperado — el margen es por
latencia/jitter de red, no por darle el beneficio de la duda a un cliente
modificado. Un bloque irrompible (`time: Infinity`) queda protegido gratis
por la misma fórmula: ningún tiempo real llega a `Infinity * 0.8`.

**Cliente:** el clic izquierdo ahora separa dos cosas que antes eran una sola
acción — atacar sigue siendo instantáneo al presionar (como singleplayer),
pero mantener presionado dispara un minado real por frame (`updateMining()`),
con reintento de objetivo si mirás a otro lado mientras mantenés apretado
(mismo "hold-to-continue" que `interaction.ts`). Un detalle que no estaba
contemplado en el plan original: perder el pointer lock (Escape, alt-tab, o
que el navegador lo suelte solo) no dispara un `mouseup` — sin un listener de
`pointerlockchange` explícito, un minado en curso se hubiera quedado
"sostenido" para siempre.

## Fase 6 — Modo tercera persona (I) y chat (T) + comandos  ✅ HECHO
**Tercera persona y chat ya implementados** en la sesión anterior (cámara de
tercera persona compartida con singleplayer vía `third-person-camera.ts`,
chat real por red con input propio). Lo que falta de este pedido es
específicamente:

- **Comandos, abiertos a cualquier jugador** — esto es un cambio de decisión
  respecto al plan de porteo anterior (`PLAN-MULTIPLAYER-PORT.md`, Fase 9),
  que decía "nadie puede usar comandos hasta que el multiplayer esté 100%
  funcional". Se actualiza ahí también cuando se implemente esto, para que
  no quede una contradicción entre los dos documentos.
- Portar el parser de `chat-commands.ts` al servidor (`world-do.ts`), con
  superficie reducida (sin nada de modo creativo, que no existe en el
  proyecto): al menos `/summon` (ya existe el spawn de mobs server-side) y
  `/give` (ya existe `addToInventory`).
- El cliente ya manda cualquier texto como `chat`; los comandos (texto que
  empieza con `/`) los interpreta el SERVIDOR (nunca el cliente), y devuelve
  el resultado como una línea de chat de sistema.

Cómo quedó: no se portó `chat-commands.ts` entero — la mitad de esos comandos
no tiene sentido server-side (`/panorama`, `/fly`, `/mobstatus` leen o tocan
estado puramente del cliente que llamó, y `/time`/`/seed` cambiarían algo
global sin ningún sistema de permisos que decida quién puede). Se portaron
solo `/summon` y `/give`, que sí son autoridad de servidor por naturaleza (dan
de alta un mob real o modifican un inventario real), en un método nuevo,
`WorldDO.handleChatCommand()`, que intercepta cualquier `chat` cuyo texto
empiece con `/` antes de que llegue a broadcastearse — el resto del chat
sigue yendo a todos como siempre.

- `/summon <pig|cow|sheep|zombie|skeleton>`: mismo cálculo de posición que la
  versión de singleplayer (unos bloques delante del jugador, mirando hacia
  él), pero llamando a `this.mobs.spawn()` (`ServerMobManager`, Fase 9) en vez
  de al `MobManager` del cliente — el mob nace ya autoritativo y aparece para
  todos, no solo para quien tipeó el comando. Si el mundo ya está en el tope
  de `MAX_MOBS` (200, Fase 9), el comando avisa en vez de fallar en silencio.
- `/give <item|block> [cantidad]`: mismo parseo y búsqueda por nombre
  "slugificado" contra `BLOCK_CATALOG`/`ITEMS` que la versión de singleplayer
  — ambas listas son datos puros (sin THREE/DOM), así que se importan
  directo, sin fork. Escribe en `session.inventory` (la del servidor) vía
  `addToInventory()` y empuja un `inventoryUpdate` inmediato para que el
  cliente lo vea sin esperar al próximo tick regular.
- La respuesta de cualquier comando (éxito o error de uso) se manda solo a
  quien lo tipeó, como una línea de chat `from: 'server'` — nunca se
  broadcastea, igual que la salida de un comando en un server real de
  Minecraft no la ve todo el mundo.
- Sin sistema de permisos: cualquier jugador conectado puede usar ambos
  comandos, decisión explícita del pedido original ("comandos, abiertos a
  cualquier jugador") — ya documentada como cambio respecto al plan de
  porteo anterior en `PLAN-MULTIPLAYER-PORT.md`, Fase 9 (que decía "nadie
  puede usar comandos hasta que el multiplayer esté 100% funcional"), que
  también se actualizó para no dejar una contradicción entre los dos
  documentos.

## Fase 7 — Pause menu y opciones no funcionan  ✅ HECHO
**Causa confirmada:** en multiplayer, `Escape` (y el botón táctil de pausa)
están cableados directo a `disconnect('Disconnected')` — no hay ningún menú
de pausa ni panel de opciones, es un diseño deliberado del primer pase
("salir del mundo"), no un bug de una función rota.

Singleplayer's `PauseMenu` (`src/pause-menu.ts`) se abre con **Tab**, no con
Escape, y trae sensibilidad, FOV, opacidad de botones táctiles, etc.

**Fix:**
- Separar las dos acciones: `Tab` abre/cierra un panel de opciones (nueva
  instancia de multiplayer, reusando los mismos controles de `PauseMenu`
  donde tenga sentido — sensibilidad y opacidad de botones táctiles aplican
  igual; FOV/niebla/render distance necesitan revisar cuáles aplican al
  cliente MP). `Escape` pasa a abrir ESE panel en vez de desconectar directo
  (con un botón "Salir del mundo" adentro, como singleplayer tiene "Leave
  World").
- Sensibilidad y opacidad de botones ya son props que TouchControls/el mouse
  handler leen (`MOUSE_SENSITIVITY`, `setButtonOpacity`) — solo falta la UI
  para cambiarlas en runtime.

Cómo quedó: panel propio (`Tab`), mismo motivo que el chat y la muerte — el
`PauseMenu` de singleplayer vive toda la página y escucha `Tab` en su propio
listener; le agregué el mismo `setEnabled()` que ya tenía `Chat` para "T",
apagado mientras dura la sesión de multiplayer.

**Decisión de alcance: no todos los sliders de singleplayer entraron.**
Sensibilidad, FOV y opacidad de botones (táctil) sí, porque tienen un efecto
real en este cliente. **Render distance quedó afuera a propósito**: subirlo
por encima de `SIMULATION_RADIUS_CHUNKS` (la región activa de la Fase 6, del
lado servidor) mostraría mobs y fuego congelados sentados quietos en el borde
de la vista — no es un slider seguro para exponer sin además negociar un tope
con el servidor, que no existe todavía. Mejor no ofrecerlo que ofrecer uno
que rompe una invariante de otra fase.

Un hallazgo de paso: la sensibilidad táctil (`touchSensitivity`) de
singleplayer **tampoco hace nada ahí** — tiene slider y se persiste, pero
nada la lee para escalar el look táctil. No es una regresión de multiplayer,
es un gap que ya existía; se aplicó el mismo `sensitivityScale` de escritorio
al look táctil en MP en vez de reproducir un slider que no hace nada en el
original, y quedó documentado en el código.

De paso se arregló el botón de pausa táctil, que hasta ahora desconectaba
directo sin confirmación — ahora abre el panel de opciones (con su propio
botón "Leave World" adentro), igual que hace el botón de pausa táctil de
singleplayer con `pauseMenu.toggle()`.

## Fase 8 — Tecla O (diagnostics) y tecla R (hitboxes)  ✅ HECHO
**Causa confirmada:** ninguna de las dos tiene listener en
`multiplayer-game.ts`. En singleplayer:
- `O` → `Diagnostics.toggle()` (`src/diagnostics.ts` línea 69), panel
  flotante con FPS/posición/luz/chunks.
- `R` → alterna `setDebug(true/false)` en `DroppedItems`, `MobManager` y
  `ArrowProjectiles` (wireframes de hitbox), ver `main.ts` línea ~797.

**Fix:**
- `Diagnostics` toma `(panel, renderer, world, player, lightEngine)` — el
  cliente MP no tiene una clase `World`, así que hace falta parametrizar
  `Diagnostics` (o una versión reducida) para leer de las estructuras que sí
  tiene MP (chunks map, camera, lightEngine, ping del socket).
- `R`: multiplayer ya no tiene clases `MobManager`/`ArrowProjectiles`
  locales (todo es autoritativo del servidor), así que lo más honesto es un
  wireframe alrededor de cada hitbox que YA se usa para el raycast (mobs,
  jugadores remotos, flechas, ítems tirados), ya que esos objetos ya existen
  en el cliente — no hace falta portar las clases de debug de singleplayer,
  alcanza con alternar la visibilidad de esas mismas mallas.

Cómo quedó: en vez de portar la clase `Diagnostics` de singleplayer (atada a
`World`/`PlayerController`/`LightEngine`, que MP no tiene), se armó un panel
`#mp-diagnostics` propio y liviano con lo que MP sí tiene: FPS (medido cuadro
a cuadro), posición/yaw/pitch (de `lastServerPos` y la cámara), chunks
cargados (tamaño del `Map` de chunks), entidades remotas, modo de cámara, hora
del día del cliente, y ping. El ping no existía como concepto en el
protocolo — se agregó una extensión chica: el cliente manda `{type: 'ping',
clientTimeMs}` cada 2s y el servidor responde `{type: 'pong', clientTimeMs,
serverTimeMs}` sin tocar nada más; el cliente mide RTT como
`performance.now() - clientTimeMs` al recibir el pong.

`R` no creó geometría de debug nueva: los meshes de hitbox de jugadores
remotos y mobs ya existían (se usan para el raycast de ataque) pero se
construían con `visible: false` fijo. Se les agregó `wireframe: true, color:
0xff2222` a su material y ahora `R` alterna un flag `hitboxDebug` que se
aplica a `.material.visible` de cada hitbox existente al togglear — cero
geometría nueva, solo se hizo visible lo que ya estaba ahí.

## Fase 9 — Mobs por jugador (spawn/cooldowns/ids individuales)  ✅ HECHO
Cambio de diseño más grande de este plan. Hoy `world-do.ts` tiene **un solo**
`spawnInitialMobs()` que tira un puñado fijo de mobs una vez al crear el
mundo — compartido por todos los jugadores conectados, sin ningún sistema de
repoblación (esto ya estaba anotado como pendiente en
`PLAN-MULTIPLAYER-PORT.md`, Fase 3: "spawning natural por bioma/luz" seguía
sin implementarse).

Singleplayer's `createMobSpawning()` (`src/mob-spawning.ts`) ya resuelve
exactamente "spawn/cooldown por jugador": 16 slots (6 animales + 6 hostiles
de superficie + 4 de cueva) con cooldown individual de 30s, todos calculados
en relación a **un** `PlayerController`. La función depende de clases pesadas
de singleplayer (`World`, `PlayerController`, `DayNightCycle`, `LightEngine`)
así que no se puede importar directo — necesita un fork headless, mismo
criterio que el resto de `world-server/src/game/`.

**Fix:**
- Fork `game/mob-spawning.ts`: misma lógica de 16 slots/cooldowns/columnas
  válidas, pero contra las funciones puras que el servidor ya tiene
  (`isSolidAt`, `isWaterAt`, `getBlockAt`, día/noche del `day-night-math.ts`)
  en vez de clases del cliente.
- **Una instancia de este spawner por SESIÓN conectada**, no una global —
  así cada jugador tiene su propio set de 16 slots evaluando su propia zona,
  con sus propios cooldowns, tal como pide el punto. Los mobs que van
  naciendo siguen entrando al ÚNICO `ServerMobManager` compartido (los ids
  ya son globalmente únicos, así que no hace falta cambiar eso) — lo que
  cambia es SOLO quién decide cuándo/dónde nace cada uno.
- Al desconectarse un jugador, destruir su spawner (no sus mobs ya
  spawneados, que siguen siendo del mundo).
- `spawnInitialMobs()` (el batch fijo actual) se elimina — el spawning
  pasa a ser continuo, dirigido por cada jugador conectado, como en
  singleplayer.

Cómo quedó, y dos cosas que el plan original no había previsto:

**El servidor no tiene motor de luz por voxel, y nunca lo tuvo.** La
iluminación siempre fue una cuestión de renderizado del cliente. Dos de las
tres condiciones de spawn de singleplayer dependían de `lightEngine`:
- `isValidHostileSurfaceColumn` necesitaba `getSkyExposure` — pero esa función
  **solo se llama de noche** (el propio `update()` la gatea así). Una columna
  a cielo abierto de noche ya cae bajo el umbral que exigía esa función de
  por sí, así que se pudo sacar el chequeo entero sin cambiar el
  comportamiento real — no es un recorte, es una simplificación honesta de
  algo que nunca iba a rechazar nada en ese contexto.
- `isValidHostileCaveColumn` sí necesitaba saber si hay una antorcha cerca
  **independientemente de la hora** — esto no se podía descartar igual. Se
  resolvió con `approxBrightnessAt()`: en vez de una propagación de luz real,
  escanea los bloques EDITADOS (`edits`, ya en memoria) buscando el emisor
  más fuerte en línea recta (distancia Chebyshev, sin rodear esquinas) —
  barato porque solo corre cuando un slot de cueva está vacío y sin cooldown,
  no cada tick. Alcanza para que una sala iluminada no genere hostiles; no es
  idéntico voxel a voxel a lo que renderiza el cliente, pero nadie puede
  notar la diferencia sin instrumentar el servidor a propósito.

**Un límite global de seguridad que el plan no mencionaba.** Con un spawner
de 16 slots por jugador en vez de uno solo para todo el mundo, varios
jugadores dispersos podrían sumar muchos más mobs de los que este servidor
tuvo que simular nunca. Se agregó `MAX_MOBS = 200` en `ServerMobManager` —
pasado ese límite, dejan de nacer mobs nuevos (los que ya existen no se
tocan), mismo patrón que `MAX_FIRE_CELLS` de la Fase 6b.

La región activa de la Fase 6 (`isActiveAt`) resultó ser exactamente lo que
hacía falta para reemplazar `isChunkLoaded` — ya resolvía "¿hay alguien lo
bastante cerca de esto como para que importe?" para agua/fuego, y la misma
pregunta es la que necesita un slot para saber si su mob se alejó demasiado.

---

## Orden de implementación

1. ~~**Fase 10**~~ ✅ (una línea, arregla slots/hotbar de golpe)
2. ~~**Fase 1**~~ ✅ (luz) — bloqueante para que el juego se vea jugable
3. ~~**Fase 2**~~ ✅ (culling) — mismo tipo de arreglo, mismo archivo
4. ~~**Fase 3**~~ ✅ (HUD real) — ahora que Fase 10 ya carga texturas
5. ~~**Fase 4**~~ ✅ (GUI de inventario/crafteo)
6. ~~**Fase 5**~~ ✅ (minado con tiempo + drops correctos)
7. ~~**Fase 9**~~ ✅ (mobs por jugador)
8. ~~**Fase 7**~~ ✅ (pause/opciones) y ~~**Fase 8**~~ ✅ (O/R)
9. ~~**Fase 6**~~ ✅ (comandos de chat: `/summon`, `/give`)

Todas las fases de esta lista de bugs están completas.

# Plan: segunda tanda de bugfixes del cliente multiplayer

Mismo criterio que `PLAN-MULTIPLAYER-BUGFIXES.md`: cada fase cita dónde está
la causa real (archivo/línea) leyendo el código actual, no suposiciones, y
cada fix reusa/porta lo que singleplayer YA hace en vez de inventar un
comportamiento nuevo. Diagnóstico hecho con tres pasadas de lectura completas
sobre src/ y world-server/src/ (no solo grep superficial).

Ya implementado y desplegado (no forma parte de este plan, mencionado por si
se pregunta): el atajo "xatatestserver" en el campo Server URL de la pantalla
de conexión multiplayer (`src/main-menu.ts`'s `openMultiplayerConnect`),
que resuelve a `wss://evlymc-world-server.mrfierrocarrilgames.workers.dev/world/prueba1`
antes de la validación normal de `/world/<id>`.

## Fase 1 — Cursor invisible al abrir inventario/pausa
**Causa confirmada:** el cursor visual (`#custom-cursor`) tiene
`z-index: 100` (`src/style.css:1869`), pero los paneles propios de
multiplayer están todos por encima: `#mp-backpack`/`#mp-crafting-table`
(`z-index: 950`, `style.css:2049`) y `#mp-options` (`z-index: 950`,
`style.css:1478`). El cursor se sigue mostrando, pero queda pintado DEBAJO
del panel que se supone debería estar usando. La lógica de
`unlockPointerForGui()` (`is-touch.ts:33-36`) ya se llama correctamente
desde `setBackpackOpen()`/`toggleOptionsPanel()` (`multiplayer-game.ts`) —
no es un bug de JS, es puro apilamiento CSS.

**Cómo lo resuelve singleplayer:** `#backpack`/`#crafting-table`/`#furnace`
son `z-index: 3` y `#pause-menu` es `z-index: 10` (comentario en
`style.css:1972` documenta el orden real), todos por debajo del cursor.

**Fix:** bajar el `z-index` de `#mp-backpack`, `#mp-crafting-table`,
`#mp-options` (y cualquier otro panel de captura de puntero en multiplayer)
a un valor por debajo de 100, manteniendo el orden relativo entre ellos que
ya tienen hoy. Un solo archivo (`style.css`), sin tocar JS.

**Nota:** esto probablemente también explica (o al menos agrava) el bug de
"no me deja seleccionar items del inventario" del reporte — con el cursor
real invisible, es muy fácil hacer click al lado del slot que se cree estar
apuntando. Ver Fase 6 para el resto de ese bug.

## Fase 2 — Rueda del mouse no cambia de slot en la hotbar
**Causa confirmada:** singleplayer tiene un handler de rueda dedicado,
`Inventory.onWheel` (`src/inventory.ts:814-828`), atado con
`document.addEventListener('wheel', this.onWheel, { passive: false })`
(`inventory.ts:165`): calcula `(selectedIndex + dirección + HOTBAR_SIZE) %
HOTBAR_SIZE` y llama `select()`. En `multiplayer-game.ts` no existe NINGÚN
listener de `'wheel'` — no es que esté roto, nunca se escribió.

**Fix:** agregar un listener de `wheel` en multiplayer con la misma fórmula
circular de `inventory.ts:814-828`, gateado igual que el original (no activo
mientras el backpack/tabla/horno/opciones estén abiertos, ni sin pointer
lock), enviando `{ type: 'selectSlot', index }` como ya hace el atajo de
dígitos (`multiplayer-game.ts:1281-1282`).

## Fase 3 — Android no puede cambiar de slot en la hotbar
**Causa confirmada:** los botones de la hotbar de multiplayer se crean
`disabled = true` a propósito, con un comentario que dice "clicking a hotbar
slot to move items only works from inside the backpack panel"
(`multiplayer-game.ts:664`). Ese comentario está equivocado: confunde el
comportamiento de los SLOTS DE ALMACENAMIENTO de singleplayer (que sí
requieren abrir la mochila) con el de la FILA DE LA HUD, que singleplayer
permite tocar/clickear directamente para seleccionar — `Inventory
.createSlotElement()` engancha `element.addEventListener('click', () =>
this.select(index))` en la fila de hotbar de la HUD (`inventory.ts:306-309`),
sin necesidad de abrir nada. Sin ese handler, ni mouse ni touch pueden
seleccionar desde la hotbar visible — hoy sólo funcionan las teclas 1-9
(`multiplayer-game.ts:1281-1282`, sin equivalente táctil).

**Fix:** sacar `disabled = true` de los botones de `hotbarSlotEls`
(`multiplayer-game.ts:660-666`) y agregarles el mismo
`addEventListener('click', () => client.send({ type: 'selectSlot', index:
i } ))` que ya usa el atajo de dígitos — mismo mensaje, un origen más. Un tap
en Android ya dispara `click` de forma nativa, así que esto resuelve ambos
bugs (Fase 3 y el pedido de mouse-wheel es un camino aparte, Fase 2) con un
solo cambio de UI.

## Fase 4 — Textura de bloques/ítems en blanco en hotbar/inventario
**Causa confirmada:** singleplayer llama `createBlockMaterials()` y luego
`await initPreviewAtlases(materials.atlas)` en el scope de módulo de
`main.ts:140-141`, ANTES de que el juego arranque — nada puede renderizar un
slot todavía. Multiplayer hace la misma llamada (`multiplayer-game.ts:352-
361`, dentro de `initTerrain()`), pero **la invoca sin esperarla**: `void
initTerrain(msg.worldSeed);` en el handler de `welcome`
(`multiplayer-game.ts:1890`). Si el primer mensaje `inventory` del servidor
llega antes de que esa promesa resuelva, `renderHotbar()`/`renderBackpack()`
llaman a `renderSlot()` → `renderBlockPreview()`/`buildBlockMesh()` con el
atlas todavía en `null`. `blockAtlasKeyFor()` (`block-preview.ts:24-29`)
devuelve `null` sin atlas, así que cae al camino lento de
`loadTexture()` (`block-preview.ts:454-474`), que arranca con
`MeshBasicMaterial({ color: base })` (blanco/`previewColor`, SIN mapa) y
recién pinta la textura real cuando el `<img>` de red termina de cargar — y
`renderBlockPreview()` descarta y reconstruye el preview mesh dos
`requestAnimationFrame` después (`block-preview.ts:307`), lo que puede pisar
ese redraw tardío y dejar el slot blanco para siempre.

**Fix:** no dejar `initTerrain()` como fire-and-forget. La forma más simple
que iguala la garantía que ya tiene singleplayer es bloquear cualquier
render de inventario/hotbar hasta que `initTerrain()` resuelva (por ejemplo,
guardando el `Promise` y haciendo que el handler de `inventory` la espere
antes de llamar a `renderHotbar()`/`renderBackpack()`, o re-renderizando una
vez más cuando la promesa resuelve). No se toca `block-preview.ts` — es
código compartido sin bugs, el problema es sólo el orden de arranque de
multiplayer.

## Fase 5 — Sin "doll" (muñeco de vista previa) en el inventario
**Causa confirmada:** singleplayer tiene `<canvas id="backpack-doll">`
dentro de `#backpack-panel` (`index.html:186`), estilizado en
`style.css:182-191`, manejado por la clase `InventoryDoll`
(`inventory-doll.ts:41`, un render Three.js del jugador que sigue al
cursor). El panel `#mp-backpack-panel` de multiplayer sólo agrega
`backpackCraftEl, backpackCraftResultEl, backpackGridEl, backpackHotbarEl`
(`multiplayer-game.ts:751-770`) — nunca se creó el `<canvas>`, nunca se
escribió CSS para `#mp-backpack-doll`, y `InventoryDoll` no se importa en
todo el archivo. No es un bug, es una pieza que nunca se portó.

**Fix:** agregar un `<canvas id="mp-backpack-doll">` dentro de
`#mp-backpack-panel` (mismas coordenadas relativas que
`style.css:182-191`, con el prefijo `mp-`), instanciar `InventoryDoll`
apuntando a él con `containerSelector: '#mp-backpack'`, igual que
`main.ts` hace con el de singleplayer. `InventoryDoll` en sí no necesita
cambios — ya acepta selectors por parámetro (mismo patrón que `Hud` de la
Fase 3 del plan anterior).

## Fase 6 — No se pueden mover/seleccionar ítems del inventario
**Causa investigada a fondo, sin bug de lógica encontrado:** se trazó todo
el camino click → `onGridSlotClick()` (`multiplayer-game.ts:698`) → mensaje
`craftMove` → `world-do.ts`'s `handleCraftMove` (`world-do.ts:834-844`) →
`moveOrMergeBetween` (`game/inventory.ts:118-139`) → `sendInventory`, y los
índices/zonas coinciden en ambos extremos. **La sospecha principal es la
Fase 1**: con el cursor real invisible, es fácil hacer click al lado del
slot correcto y percibir "no hace nada". Hay además una carrera menor real:
`setBackpackOpen()`/`setTableOpen()` (`multiplayer-game.ts:790-867`) llaman
`renderBackpack()`/`renderTable()` de forma SÍNCRONA, antes de que el
servidor confirme `craftOpen` — el primer render tras abrir usa datos
`craftInputs`/`inventorySlots` posiblemente viejos hasta que llegue el
próximo mensaje `inventory`/`craftGrid`. Singleplayer no tiene esta carrera
porque su `CraftingGrid`/inventario es 100% local, sin ida y vuelta de red.

**Fix:** (a) arreglar Fase 1 primero y volver a probar — es la explicación
más probable. (b) si el problema persiste, cerrar la ventana de carrera no
renderizando el panel hasta recibir la confirmación del servidor (o
deshabilitando los botones por un frame), mismo principio que ya usa este
archivo en otros lados (esperar el ack antes de considerar el estado
"fresco").

## Fase 7 — Mensajes de chat no desaparecen
**Causa confirmada:** `addChatLine()` (`multiplayer-game.ts:919-926`) sólo
recorta por CANTIDAD (`while (chatLogEl.children.length > 50)
chatLogEl.firstElementChild!.remove()`) — no hay ningún `setTimeout`,
animación ni lógica de expiración por tiempo en absoluto.

**Fix:** en `addChatLine()`, además de crear la línea, armar un
`setTimeout(() => line.remove(), 15000)` individual por línea (no un
temporizador global — cada mensaje vive sus propios 15s desde que se
agregó, tal como pide el pedido). Esto es puramente nuevo en multiplayer
porque singleplayer no tiene un chat en pantalla persistente equivalente
que necesite expirar (su consola de comandos es distinta) — no hay una
función de singleplayer para portar acá, es una mejora de UX propia de
multiplayer.

## Fase 8 — Tag de nombre muy arriba y sin fondo
**Causa confirmada:** el label de cada jugador remoto se crea con estilos
inline en `multiplayer-game.ts:1662-1667`:
```
label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
```
con `labelOffsetY: 1.1` (línea 1667) sumado a la posición del jugador antes
de proyectar a pantalla (línea ~2065). No hay fondo, sólo un
`text-shadow` de 1px — y el offset de 1.1 bloques es lo que lo deja "muy
arriba". Los mobs usan el mismo patrón (`multiplayer-game.ts:1724-1729`,
`stats.height + 0.3`), pero el pedido es específicamente sobre el tag de
JUGADORES.

**Fix:** bajar `labelOffsetY` del jugador (probar algo como `0.5-0.6`, más
cerca de la cabeza) y mover el estilo a una clase CSS real (ej.
`.mp-name-tag`) en `style.css` con `background: rgba(0,0,0,.5)`, `padding`,
`border-radius` — reemplazando el `cssText` inline por
`label.className = 'mp-name-tag'`. No hay equivalente en singleplayer para
portar (ahí no hay multiplayer ni tags de otros jugadores), así que esto es
una mejora visual propia, no un "arreglar para que coincida con
singleplayer".

## Fase 9 — Q dropea el stack completo en vez de un solo ítem
**Causa confirmada:** singleplayer distingue "soltar uno" vs "soltar todo"
con `ctrlKey`: `if (event.code === 'KeyQ' && this.engaged && !event.repeat)
this.onDropSelected?.(event.ctrlKey);` (`interaction.ts:688`), pasando un
booleano `all` (`interaction.ts:105`). El handler de Q en multiplayer
(`multiplayer-game.ts:1283-1286`) manda `{ type: 'dropItem', dir }` **sin
ningún flag**, y el servidor (`world-do.ts:636-650`, `handleDropItem`) hace
`removeFromSlot(slot, Infinity)` (línea 648) SIEMPRE — nunca tuvo la opción
de sacar sólo 1.

**Fix:** agregar `all: boolean` al mensaje `dropItem` en
`net/protocol.ts`, mandar `event.ctrlKey` desde el cliente (mismo criterio
que singleplayer: Q sólo = 1 ítem, Ctrl+Q = todo el stack), y en
`handleDropItem` usar `removeFromSlot(slot, all ? Infinity : 1)` en vez del
`Infinity` fijo actual.

## Fase 10 — Menú de pausa no es visualmente el de singleplayer
**Causa confirmada:** el `#pause-menu` real de singleplayer
(`index.html:217-249`) tiene dos vistas intercambiables —
`#pause-view` (botones "Back to game"/"Options"/"Leave World", clase
`.texture-button`) y `#options-view` (sliders con `.slider-row`, toggles
con `.option-toggle`) — estilizadas en `style.css:458-528`. El `#mp-options`
de multiplayer es un panel plano de una sola vista, con clases propias
desde cero (`.mp-options-row`, `style.css:1475-1488`) — una reimplementación
deliberada, documentada en el propio código como "own element ... see
multiplayer-game.ts's optionsEl doc comment for why this isn't
singleplayer's #pause-menu" (comentario junto a `style.css:1474`).

**Fix (pedido explícito: copiar tal cual, no reinventar):** reconstruir
`#mp-options` con la MISMA estructura de dos vistas
(`pause-view`/`options-view`) y las MISMAS clases CSS
(`.texture-button`, `.slider-row`, `.option-toggle`) que usa
`#pause-menu`, sólo con ids `mp-` para no chocar con la instancia real de
singleplayer que sigue viva en el DOM (mismo patrón de "mismo look, ids
propios" que ya usan `#mp-backpack`/`#mp-hud` desde fases anteriores).
Los sliders que ya se decidió NO incluir (render distance, ver Fase 7 del
plan anterior) siguen afuera; el resto reusa el layout real en vez del
propio.

## Fase 11 — Sin animación de agachado ni de swing de mano
**Causa confirmada:** `PlayerModel` ya expone `swingArm()`
(`player-model.ts:243-247`) y `setSneaking()`/`updateSneak()`
(`player-model.ts:483-493`). Singleplayer los llama todos los frames que
corresponde: `swingArm()` en cada minado/ataque (`main.ts:241`),
`setSneaking()`/`updateSneak()` todos los frames según
`player.state.sneaking` (`main.ts:733-734`). **Ninguno de los tres se llama
en absoluto en `multiplayer-game.ts`** (confirmado por grep en todo el
archivo) — ni para el cuerpo local (`localPlayerModel`) ni para el de
jugadores remotos en `updateRemoteAnimation` (`multiplayer-game.ts:1767-
1795`, que sólo llama `startWalking`/`stopWalking`/`setOrientation`/
`updateWalkingAnimation`).

**Fix:**
- Swing local: llamar `localPlayerModel?.swingArm()` en los mismos puntos
  donde ya se dispara un ataque/mina (dentro de `performInteraction()` y
  `startMining()`), igual que singleplayer lo hace en `main.ts:241`.
- Sneak local: llamar `localPlayerModel?.setSneaking(...)`/`updateSneak()`
  cada frame según el estado de sneak local (`keys.has('ShiftLeft')` o el
  botón táctil), igual que `main.ts:733-734`.
- Para jugadores REMOTOS, el servidor no manda hoy si están agachados o
  atacando en el `EntitySnapshot` (`net/protocol.ts:73-86` no tiene
  `sneaking` ni un pulso de "atacó este tick"). Hace falta agregar
  `sneaking: boolean` al snapshot (el servidor ya guarda
  `session.intent.sneaking`, sólo hay que incluirlo al armar el snapshot) y
  un evento de "atacó" (puede reusar la misma lógica que ya dispara sonidos
  de golpe, mandando un pulso de un tick) para que `updateRemoteAnimation`
  pueda llamar `swingArm()`/`setSneaking()` en los otros clientes también.

## Fase 12 — Ítem equipado no se ve en la mano
**Causa confirmada:** `PlayerModel.setHeldItem(id)` existe
(`player-model.ts:428+`, comentario "Show the selected hotbar block/item in
the model's right fist"). Singleplayer lo llama al cambiar de slot:
`(id) => { interaction.selectBlock(id); hand.setSlotById(id);
playerModel.setHeldItem(id); }` (`main.ts:290`). **Nunca se llama en
multiplayer-game.ts** (grep vacío) — ni para `localPlayerModel` al mandar
`selectSlot` (`multiplayer-game.ts:1282`), ni para entidades remotas.

**Fix:**
- Local: llamar `localPlayerModel?.setHeldItem(id)` cada vez que cambia
  `selectedSlotIndex` (mismo punto donde se manda `selectSlot` al
  servidor).
- Remoto: el `EntitySnapshot` tampoco manda qué ítem tiene seleccionado
  cada jugador. Hace falta agregar `heldItem: number | null` al snapshot
  (el servidor ya sabe `session.selectedSlot`/`session.inventory` al
  armarlo) y llamar `entity.playerModel?.setHeldItem(...)` en
  `updateRemoteAnimation` cuando cambia.

## Fase 13 — Sin animación de daño en el jugador local
**Causa confirmada:** `PlayerModel.hurt()` existe y YA se llama para
entidades remotas (`multiplayer-game.ts:1943`,
`op.playerModel?.hurt();`). El `onState` handler que detecta la baja de
vida propia (`multiplayer-game.ts:1893-1904`, el mismo bloque que ya
dispara el sonido de dolor) nunca llama `localPlayerModel?.hurt()`.

**Fix:** una línea — agregar `localPlayerModel?.hurt();` junto al
`soundManager.playRandom('player/Player_hurt', ...)` existente en ese mismo
bloque, mismo patrón que Fase 13 usa para jugadores remotos.

## Fase 14 — Cabeza del modelo no sube/baja al mirar arriba/abajo
**Causa confirmada, alcance = sólo jugadores remotos.** Para el cuerpo
LOCAL, `multiplayer-game.ts:2101` ya pasa el pitch real:
`localPlayerModel.setOrientation(yaw, pitch, ...)` — correcto. Para
jugadores remotos, `updateRemoteAnimation` llama
`entity.playerModel.setOrientation(entity.lastYaw, 0, ...)` con **el pitch
hardcodeado en 0** (`multiplayer-game.ts:1794`). `PlayerModel.
setOrientation()` sí aplica `head.rotation.x = lookPitch`
(`player-model.ts:420`) — el modelo puede hacerlo, sólo nunca recibe el
dato real de otros jugadores porque el protocolo no lo manda.

**Fix:** agregar `pitch: number` al `EntitySnapshot` (el servidor ya guarda
`session.pitch` por sesión, `world-do.ts:124`, sólo falta incluirlo al
armar el snapshot de jugadores), guardarlo en `RemoteEntity` (como ya se
hace con `lastYaw`) y pasar ese valor real en vez del `0` fijo en la
llamada de la línea 1794.

## Fase 15 — Agua/lava "sólidas" (no se puede nadar en bloques editados)
**Causa confirmada:** `world-do.ts`'s `isSolidAt()` (líneas ~1667-1671):
```ts
private isSolidAt(x, y, z): boolean {
  const edit = this.edits.get(`${x},${y},${z}`);
  if (edit !== undefined) return edit !== BlockId.AIR;   // <- bug
  return this.terrain!.isSolid(x, y, z);
}
```
Para cualquier bloque EDITADO (colocado o cambiado por un jugador — balde
de agua, lava, antorcha, fuego que se propagó), el camino rápido de
`this.edits` sólo excluye `AIR`, así que agua/lava/fuego/antorchas
colocados quedan sólidos como piedra. El terreno generado (no editado) sí
pasa por `terrain.isSolid()` (`world-server/src/terrain.ts:60-64`), que
correctamente usa `isSolidBlock()` (`src/block.ts:135-137`,
`NON_SOLID_BLOCKS = new Set([AIR, WATER, LAVA, FIRE, TORCH])`) — por eso el
agua/lava/fuego NATURAL del mundo generado sí es transitable/nadable
(la física de nado en sí, `inWater` en `game/player-physics.ts`, YA es un
fork completo e idéntico al de singleplayer, constantes incluidas) pero lo
que el jugador coloca o lo que se propaga (fuego) no.

**Sobre las "diagonales" del agua pedidas:** se confirmó leyendo
`src/chunk.ts` que singleplayer TAMPOCO tiene mesh de agua con
profundidad/diagonales por nivel — el agua se renderiza como cubo completo
en los dos lados. No es una regresión de multiplayer ni algo que
singleplayer ya resuelve; no se va a inventar esa función nueva acá (va
contra el pedido explícito de "no improvisar, usar lo que ya hace
singleplayer" — si se quiere esa mejora visual es un pedido aparte, no un
bugfix).

**Fix:** cambiar `isSolidAt()` para usar `isSolidBlock(edit)` en vez de
`edit !== BlockId.AIR`, igual que ya hace `terrain.isSolid()`. Un solo
cambio soluciona agua sólida, lava sólida Y fuego sólido (Fase 16) a la
vez, porque las tres comparten exactamente esta única función.

## Fase 16 — Fuego sólido
**Mismo bug y mismo fix que la Fase 15** (`isSolidAt()` en
`world-do.ts`) — el fuego colocado/propagado es un `edit` no-`AIR`, así que
cae en el mismo camino roto. No hace falta nada adicional más allá del fix
de la Fase 15.

## Fase 17 — Filtro azul y cambio de FOV bajo el agua no se ven
**Investigado a fondo — dos hallazgos distintos:**
- El TINTE AZUL (`#mp-underwater-overlay`) está correctamente cableado:
  `underwater.update(currentSkyColor)` se llama todos los frames sin
  condición (`multiplayer-game.ts:2122`), el CSS existe y tiene
  `opacity: 0 → 1` con `.active` (`style.css:1354-1363`), y
  `UnderwaterManager.update()` (`underwater-manager.ts:24-49`) alterna esa
  clase. No se encontró una causa de código para que el tinte no aparezca
  — si sigue sin verse tras las demás fases (en particular la Fase 4, que
  toca el mismo arranque asíncrono), hay que reprobar en vivo antes de
  tocar nada más acá.
- El CAMBIO DE FOV bajo el agua **confirmado ausente**: en singleplayer no
  lo hace `UnderwaterManager` — lo hace `PauseMenu.setUnderwater(bool)`
  (`pause-menu.ts:206-210`), que resta 10 al FOV
  (`updateFov()`, `pause-menu.ts:212-215`) cuando está activo, y algo en
  `main.ts` llama `pauseMenu.setUnderwater(state.isUnderwater)` cada vez
  que cambia. Multiplayer construye su propio FOV en el panel de opciones
  (Fase 10 de este plan) pero nunca resta nada al entrar al agua.

**Fix:** replicar la resta de 10 al FOV cuando `submerged` (ver variable ya
existente en `multiplayer-game.ts:312`) sea `true`, aplicada sobre
`camera.fov` en el mismo lugar donde se llama `underwater.update(...)`
(`multiplayer-game.ts:2122`) — mismo número mágico (10) y mismo criterio
que `pause-menu.ts:213`.

## Fase 18 — Las hojas no desaparecen al talar el tronco
**Causa confirmada: no existe ningún puerto server-side.** Singleplayer
tiene un sistema completo de decay de hojas, `LeavesManager`
(`src/leaves-manager.ts`, BFS de distancia a un tronco con
`RANGE`/`DECAY_RATE_PER_SECOND`), instanciado en `world.ts:35` y disparado
desde `world.ts:330` (`addLeaf`, al colocar) y `world.ts:351-353`
(`removeLeaf`/`onLogRemoved`, al romper un tronco), tickeado cada frame
(`world.ts:397`). `grep -rl "leaf" world-server/src/` no devuelve NADA — ni
un archivo, ni un stub.

**Fix:** fork headless nuevo, `world-server/src/game/leaves-manager.ts`,
mismo criterio que el resto de `game/*.ts` (mismo algoritmo BFS/constantes
de `leaves-manager.ts`, pero contra las funciones puras del servidor en
vez de una clase `World` de cliente). Conectarlo en `world-do.ts`: llamar
al equivalente de `addLeaf`/`onLogRemoved` desde el mismo lugar donde ya se
aplican los cambios de bloque (`applyBlockChange`/`setBlockFromPlayer`), y
tickearlo desde el loop principal del Durable Object, igual que
`world.ts:397` lo hace por frame en singleplayer.

## Fase 19 — Sin sonido al recibir daño
**Investigado — parece ya implementado correctamente.**
`multiplayer-game.ts:1903` ya tiene
`if (msg.self.health < lastSelfHealth) soundManager.playRandom
('player/Player_hurt', 3, 0.7);`, mismo patrón y mismo asset que
singleplayer (`main.ts:447`). Si el sonido realmente no se escucha en la
práctica, los candidatos más probables no están en esta línea sino en:
`soundManager.initialize()` corriendo detrás de un gesto del usuario
(`multiplayer-game.ts:242`, atado a `pointerdown`) que podría no haber
disparado todavía la primera vez que el jugador recibe daño, o el valor
inicial `lastSelfHealth = Infinity` (línea 461) enmascarando el primer
golpe si `welcome`/el primer `state` llegan en un orden inesperado. Este
ítem queda para reproducir en vivo antes de tocar código — no se encontró
una causa de código concreta para "arreglar a ciegas".

## Fase 20 — El sonido de un mob herido se escucha a cualquier distancia
**Causa confirmada:** el bark de IDLE de un mob remoto SÍ filtra por
distancia (`multiplayer-game.ts:1804-1805`,
`entity.mesh.position.distanceTo(camera.position) <= MOB_SOUND_RADIUS`),
pero los de HURT/DEATH no tienen ese filtro — se llaman directo
(`multiplayer-game.ts:1934` y `:1945`,
`playMobSound(soundManager, op.kind as MobKind, 'hurt'|'death', 0.7)`), y
como cada cliente conectado recibe el mismo snapshot y detecta la misma
baja de vida, TODOS reproducen el sonido a volumen fijo sin importar dónde
esté su propia cámara.

**Cómo lo hace singleplayer:** `mob-manager.ts:497-500`,
`inSoundRange(mob, pos)`, con la misma constante
`MOB_SOUND_RADIUS = 4` (`mob-manager.ts:65`), usada antes de reproducir
tanto en `hurt` (`mob-manager.ts:332`) como en `death`
(`mob-manager.ts:323`).

**Fix:** agregar el mismo chequeo de distancia
(`entity.mesh.position.distanceTo(camera.position) <= MOB_SOUND_RADIUS`)
antes de las llamadas de las líneas 1934 y 1945 — la misma condición que ya
existe dos líneas más arriba para el bark idle, sólo repetida en los dos
sitios que la omiten.

## Fase 21 — Mobs sueltos en el spawn que no son de nadie
**Causa confirmada — no es un spawn activo, es estado persistido viejo.**
`spawnInitialMobs()` ya no existe (confirmado, Fase 9 del plan anterior lo
eliminó) y el spawner por jugador (`game/mob-spawning.ts`) sólo spawnea
relativo a `getPlayerPos()` — nunca en un punto fijo de spawn. Lo que
queda son `MobRecord[]` viejos guardados bajo `MOBS_KEY` en el storage del
Durable Object (de ANTES del rediseño de la Fase 9, cuando sí existía un
batch fijo), que `onJoin`/arranque del DO restaura fielmente
(`world-do.ts:376-387`, `this.mobs.restore(saved)`) cada vez que el DO se
despierta.

**Gap de diseño relacionado, mismo bug de fondo:** un mob spawneado por el
slot de un jugador que se DESCONECTA queda "húerfano" a propósito (decisión
ya documentada en la Fase 9 del plan anterior: "no destruir sus mobs ya
spawneados, que siguen siendo del mundo") — razonable para un mundo
persistente, pero como ningún slot de ningún jugador vuelve a mirar ese mob
nunca más, nunca se despawnea aunque nadie esté cerca (sólo se "congela" via
`isActiveAt`, nunca se libera el cupo de `MAX_MOBS`).

**Fix:**
- Limpieza puntual: los `MobRecord[]` heredados de antes de la Fase 9 hay
  que purgarlos del storage del mundo ya desplegado (operación de datos,
  no de código — se puede hacer con un comando chico agregado
  temporalmente o limpiando la entrada `MOBS_KEY` directo).
- Fix estructural para que no vuelva a pasar: agregar un barrido en el
  `tick()` de `WorldDO`, independiente de cualquier spawner de jugador, que
  llame `forceRemove()` sobre un mob que lleva un tiempo fuera de TODAS las
  regiones activas de todos los jugadores conectados (reusando el mismo
  `isActiveAt`/`forceRemove` que ya existe, sólo aplicado de forma global
  en vez de sólo por el slot que lo originó) — mismo patrón de
  "housekeeping" que ya usa `MAX_FIRE_CELLS`/`MAX_MOBS`.

## Fase 22 — El jugador no debe poder colocar un bloque donde está parado
**Causa confirmada:** `world-do.ts`'s `handlePlaceBlock` llama
`this.setBlockFromPlayer(x, y, z, slot.id)` directo con las coordenadas que
manda el cliente — CERO validación geométrica contra la posición del
jugador. Singleplayer sí la tiene: `BlockPlacer.placeBlock()`
(`src/block-placer.ts:38`) gatea con
`const canPlace = isLiquid || !playerIntersectsBlock(x, y, z);`, y ese
callback es `player.intersectsBlock(x, y, z)`
(`src/player-physics.ts:365-371`), que arma un `THREE.Box3` del bloque
target y chequea solapamiento horizontal+vertical contra el AABB del
jugador (radio/altura de ojos ya existentes).

**Fix:** portar ese mismo chequeo (`intersectsBlock`/
`overlapsHorizontally`/`overlapsVertically`, mismos radios/alturas que ya
usa `game/player-physics.ts` por sesión) dentro de `handlePlaceBlock`,
evaluado contra `session.physics.state.position` de quien está pidiendo
colocar el bloque — igual que singleplayer sólo chequea contra SU PROPIO
jugador, no contra otros.

## Fase 23 — El jugador no corre (sprint)
**Investigado a fondo — el pipeline ya está completo y correcto en el
código.** Cliente: `sprinting: keys.has('ControlLeft') || touchSprint`
(`multiplayer-game.ts:2054`), mismo código que singleplayer usa para
detectar la tecla (`player.ts:403`, aunque ahí es un toggle en vez de
"mientras se mantenga apretado" — diferencia de UX, no de que "no ande").
Servidor: `session.intent.sprinting` se guarda (`world-do.ts:466`) y se
aplica cada tick (`world-do.ts:1165`,
`session.physics.updatePhysics(direction, wantJump,
session.intent.sprinting, dt)`). `game/player-physics.ts` es un fork
constante-por-constante de `src/player-physics.ts`
(`WALK_SPEED=4.5`, `SPRINT_SPEED=6.5` en ambos), con la rama
`sprinting ? SPRINT_SPEED : ...` presente.

**No se encontró una causa de código.** Este ítem necesita reproducirse en
vivo (¿se mantiene Ctrl izquierdo? ¿hay foco/pointer-lock perdido que
trague el keydown antes de que llegue a `keys.add()`?) antes de escribir
ningún fix — cambiar algo a ciegas acá arriesga romper lo que ya funciona
según la lectura del código.

## Fase 24 — Actualización de luz por día/noche sólo en el chunk actual
**Investigado a fondo — el mecanismo YA relighteá TODOS los chunks
cargados, no sólo el actual.** `applyDayNightState()`
(`multiplayer-game.ts:473-479`) hace, en cada cambio entero de
`skyDarken`:
```ts
if (lightEngine.setSkyDarken(skyDarken)) {
  relightQueue.length = 0;
  for (const key of chunks.keys()) relightQueue.push(key);  // TODOS los cargados
}
```
y el loop de `frame()` drena esa cola (`RELIGHT_CHUNKS_PER_FRAME = 2`,
línea 289; consumo en líneas 2123-2124) — mismo diseño que
`day-night-cycle.ts:80`'s llamada a `world.rebuildMeshes()` en
singleplayer, sólo repartido en varios frames en vez de un solo hitch
(`world.ts:269-271`, que si marca TODOS los chunks sucios de una sola vez).
`setSkyDarken()` (`light-engine.ts:100-105`) también se leyó y su lógica de
"sólo devuelve true en un cambio de entero" es correcta.

**No se encontró una causa de código para "sólo el chunk actual".** Es
posible que el síntoma reportado en realidad venga de la Fase 4 (bundle
viejo en caché, o una carrera de arranque distinta) y no de este mecanismo.
Se deja documentado para volver a probar después de las fases anteriores;
si se sigue reproduciendo, el próximo paso es instrumentar (contar cuántos
chunks entran a `relightQueue` por cambio de `skyDarken`) en vez de
adivinar un fix.

## Fase 25 — Mismos problemas de líquidos con la lava
Cubierto por la Fase 15 (mismo bug, `isSolidAt()`) para el problema de
"sólida". La física de nado en lava no existe ni en singleplayer (el
`inWater` de `player-physics.ts` está atado únicamente al callback
`isWater`, sin rama equivalente para lava en NINGUNO de los dos códigos) —
no es una regresión de multiplayer, así que no corresponde inventarla acá
por el mismo criterio que el agua (Fase 15): no improvisar comportamiento
que singleplayer tampoco tiene.

---

## Orden de implementación sugerido

Agrupado por costo/riesgo, no por el orden en que aparecen arriba:

1. **CSS/JS chicos, sin tocar servidor** (Fases 1, 2, 3, 7, 8) — cursor,
   rueda del mouse, hotbar táctil, expiración de chat, tag de nombre.
2. **Una función compartida, arregla 3 bugs a la vez** (Fases 15/16/25) —
   `isSolidAt()` en `world-do.ts`.
3. **Arranque/orden de carga** (Fase 4) — probablemente destrabe también la
   Fase 6 y ayude a reproducir mejor las Fases 17/24.
4. **UI que falta portar** (Fases 5, 10) — doll del inventario, menú de
   pausa real.
5. **Animaciones + extensión de protocolo** (Fases 11, 12, 13, 14) — swing/
   sneak/held-item/pitch; agrupadas porque las tres de jugadores remotos
   comparten el mismo cambio de `EntitySnapshot`.
6. **Servidor: drop parcial y self-collision** (Fases 9, 22) — cambios
   acotados a un handler cada uno.
7. **Sonido por distancia de mobs** (Fase 20) — un chequeo repetido dos
   veces.
8. **Sistemas nuevos del lado servidor** (Fase 18, decay de hojas; Fase 21,
   limpieza/despawn global de mobs huérfanos) — lo más grande de la lista,
   al final porque no bloquean nada de lo anterior.
9. **Verificar en vivo sin tocar código todavía** (Fases 19, 23, 24) — no
   se encontró causa de código; reproducir de nuevo después de todo lo
   anterior (en especial la Fase 4) antes de decidir qué tocar.

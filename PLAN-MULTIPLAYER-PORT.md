# Plan: portear el resto del singleplayer al multiplayer

Alcance: todo lo que el singleplayer (`src/main.ts` y compañía) ya tiene resuelto
pero que el multiplayer (`world-server/src/*` + `src/multiplayer-game.ts`) todavía
no soporta o no hace autoritativo. Ignora explícitamente **modo creativo** (no
existe en ningún lado del proyecto, no es un gap de multiplayer).

Este documento asume el patrón ya establecido en `world-server/src/game/README.md`:
lógica pura que debe coincidir byte a byte entre cliente y servidor se **importa
directo** desde `../../src/`; lo que necesita adaptarse para correr sin DOM/Three.js
se **forkea** dentro de `world-server/src/game/`. Cada fase de abajo dice cuál de
los dos casos es.

Orden pensado por: (1) impacto en la sensación de "juego completo" al jugar en
grupo, (2) costo de implementación relativo a lo que ya existe reusable, (3)
dependencias entre fases (ítems físicos antes que drops de mobs, por ejemplo).

## Fase 1 — Ítems físicos tirados en el mundo  ✅ HECHO
El más bloqueante: sin esto, ni "romper bloque lejos del jugador", ni "drop de
mob", ni "tirar ítem con Q" tienen dónde aterrizar del lado servidor.

- Reusar `src/dropped-items.ts`/`src/dropped-items-store.ts` (import directo,
  son lógica pura de física/lifetime de ítem en el suelo, no dependen de DOM).
- `world-do.ts`: mantener un `Map<id, DroppedItemState>` por mundo, tick de
  física simple (caída + colisión con el terreno ya existente), expiración por
  tiempo.
- Protocolo: nuevo tipo de entidad `droppedItem` en `EntitySnapshot` (posición,
  itemId, count) para que el cliente lo renderice y detecte pickup por
  proximidad — o pickup autoritativo server-side por radio, a decidir contra
  cómo ya funciona el pickup en singleplayer para no divergir en la sensación.
- Cliente (`multiplayer-game.ts`): renderizar el mismo mesh/ícono que usa
  singleplayer para ítems en el suelo (ya existe, ver `item-stack.ts`/render de
  singleplayer), sonido de pop al aparecer/recoger (ya portado parcialmente).
- Cablear `dropItem` (soltar con Q) y "romper bloque lejos" para que generen
  una entidad real en vez de ir directo al inventario.

## Fase 2 — Drops y muerte real de mobs  ✅ HECHO
Depende de Fase 1 (los drops necesitan dónde caer).

Cómo quedó: el mob a 0 HP se marca `dying` y sigue en el snapshot durante
DEATH_SPIN_DURATION (0.75s, igual que singleplayer) mientras cae y se
desploma; recién ahí se tira el loot con `rollDrops()` (import directo de
`src/mob-drops.ts`) y desaparece. No hizo falta el mensaje `mobDied` que
proponía este plan: `EntitySnapshot` ya llevaba el campo `dying`, así que el
cliente dispara el sonido y la caída con lo que ya recibía.

La persistencia guarda solo lo necesario para respawnear (id, kind, pos, yaw,
health), en una cadencia lenta (30s) más un guardado inmediato ante muertes o
spawns — escribir posiciones a 20Hz sería el gasto más caro posible del DO
para el menor beneficio.

- `world-server/src/mobs.ts`: en el punto donde hoy se marca `mob.dying = true`
  y desaparece el próximo tick, llamar a `getDrops()` (import directo desde
  `../../src/drops.ts`, ya se usa así para bloques) y spawnear las entidades de
  Fase 1 en la posición del mob.
- Persistir mobs en `state.storage` igual que los bloques editados, para que
  sobrevivan un reciclado del Durable Object (hoy el comentario dice
  explícitamente "not persisted").
- Animación de muerte: no hace falta portar el sistema completo de singleplayer
  tal cual; alcanza con un evento `mobDied` en el protocolo que el cliente use
  para disparar un efecto local (fade out / partículas de Fase 8) sin que el
  servidor tenga que simular nada de eso.

## Fase 3 — Sonidos y modelos reales de mobs en el cliente multiplayer  ✅ HECHO
Puramente cliente, no toca `world-server/`. Reusa módulos ya escritos.

Cómo quedó: `makeMobAvatar()` construye el mismo `MobModel`/`BipedMobModel`
que usa singleplayer, con un box invisible como único blanco de raycast (mismo
truco que ya usaba `buildPlayerHitbox` para los jugadores). Se exportaron
`isBipedKind` y `AnyMobModel` desde `mob-manager.ts` para que el cliente
multiplayer no tenga su propia lista de qué mob es bípedo — esa lista se
volvería obsoleta sola el día que se agregue un tercer bípedo.

Ojo con las texturas al liberar memoria: `mob-model.ts` las cachea y las
comparte entre todos los mobs de la misma especie, así que al sacar un mob se
liberan sus materiales pero NUNCA su `map` — hacerlo dejaría en blanco a todas
las demás vacas en pantalla.

- Reemplazar las cápsulas de color en `multiplayer-game.ts` por los modelos
  reales (`pig-model.ts`, `cow-model.ts`, `sheep-model.ts`, `zombie-model.ts`,
  `skeleton-model.ts`, todos ya existen y son renderer puro — se pueden
  importar directo desde `src/` sin fork, igual que hace singleplayer).
- Conectar `sound-manager.ts` para hurt/death/idle de mobs en vez del
  placeholder reactivo actual.
- Animación de caminata/idle ya viene con los modelos — solo hace falta
  alimentarlos con el estado de movimiento que ya viaja en `EntitySnapshot`.

## Fase 4 — Combate/supervivencia del jugador: caída, ahogamiento, fuego  ✅ HECHO
Barato: `player-physics.ts` (ya forkeado en `game/`) ya trackea velocidad
vertical y contacto con bloques, solo falta leer esa info en `world-do.ts`.

Cómo quedó: todo junto en `applyEnvironmentDamage()`, llamado justo después
del paso de física de cada sesión. `src/player-air.ts` resultó ser lógica pura
(sin DOM ni THREE), así que se importa DIRECTO, sin fork.

Dos detalles que importan:
- El daño por caída se lee del campo `fallImpact` que el fork ya calculaba;
  **no** hace falta un `consumeFallImpact()` porque `updatePhysics` lo
  recalcula desde cero cada tick — leerlo un tick tarde daría 0.
- Al morir hay que resetear aire y timers de fuego, o el jugador reaparece
  ahogándose/ardiendo y se vuelve a morir en tierra firme.

El `onFire` del jugador ahora es real en `EntitySnapshot` (antes iba fijo en
`false`), así que los demás jugadores ven las llamas. El overlay de pantalla
en primera persona sigue siendo de la Fase 8.

Head-underwater es un test simple de bloque a la altura de los ojos, no el de
`UnderwaterManager` (que además considera la altura real de un bloque de agua
fluyendo) — el servidor no tiene agua que fluya hasta la Fase 6b.

- **Daño por caída**: portar el cálculo de `consumeFallImpact()` (singleplayer,
  en `player-air.ts`/física) al `game/player-physics.ts` forkeado, y aplicarlo
  en el tick de `world-do.ts` igual que ya hace con el daño de mob.
- **Ahogamiento**: portar la lógica de `player-air.ts` (barra de aire, daño
  periódico bajo el agua) al fork server-side; agregar `air` al estado del
  jugador en el protocolo para que el cliente pinte la barra.
- **Daño por fuego/lava**: requiere que el bloque en la posición del jugador se
  chequee contra fuego (ver Fase 6) o contra `BlockId.lava` si existe; aplicar
  daño periódico igual que ahogamiento. Incluye poner `onFire: true` real en
  vez del `false` fijo actual.
- Cliente: overlays de pantalla (bajo el agua, quemándose) — ver Fase 8, van
  juntos porque comparten el mecanismo de "overlay full-screen reactivo a
  estado del jugador".

## Fase 5 — Arco y flechas reales (jugador + esqueleto)  ✅ HECHO

Cómo quedó: fork en `game/arrow-projectiles.ts` con solo la física (misma
gravedad, drag, hitbox, fórmula de daño, pickup y despawn). El esqueleto ya no
hace "impacto garantizado": dispara un proyectil real que puede fallar,
esquivarse o frenarse contra una pared.

Diferencias propias del multiplayer, deliberadas (no son divergencias
accidentales):
- Una flecha guarda `ownerId`, cosa que en singleplayer no hace falta porque
  hay un solo jugador. Sirve para que el daño y el recupero se atribuyan bien.
- Flecha de jugador pega a mobs, flecha de mob pega a jugadores. Jugador
  contra jugador queda para la Fase 7 (PvP), hoy deshabilitado.
- Cualquiera puede recoger una flecha gastada, no solo quien la tiró — misma
  regla de "lo que está en el suelo es público" que ya siguen los ítems.

Ojo con la orientación: una flecha clavada tiene velocidad cero, así que el
rumbo NO se puede derivar del vector en ese momento (quedaría apuntando a una
dirección fija sin sentido). Se guarda mientras vuela y se congela al impactar.

`SKELETON_SHOT_POWER` tiene que ser la misma velocidad que usa la
compensación de arco de `mob-ai.ts`, o la flecha aterriza donde la IA nunca
apuntó.
- Reusar `src/arrow-projectiles.ts` como base, pero **forkear** una versión sin
  las dependencias de mallas/texturas 3D (mismo criterio que ya se aplicó a
  `mob-ai.ts` con `ARROW_GRAVITY`/`powerToSpeed`) dentro de `game/`, con solo
  la física del proyectil (posición, gravedad, detección de impacto contra
  jugador/mob/bloque).
- Protocolo: `shootBow` (ya aceptado pero ignorado) pasa a spawnear un
  proyectil real con velocidad/dirección; nuevo tipo de entidad `arrow` en
  `EntitySnapshot` para que el cliente lo renderice en vuelo.
- Reemplazar el "hit garantizado instantáneo" del esqueleto (`onShootArrow` en
  `mobs.ts`) por un proyectil real usando el mismo sistema.
- Cliente: mesh de flecha en vuelo (ya existe en singleplayer) + sonido de
  impacto.

## Fase 6 — Región activa de simulación (infraestructura para Fase 6b)  ✅ HECHO

Cómo quedó, y dos correcciones a lo que este plan asumía:

1. **El servidor no tenía NADA de chunks.** Este plan decía "se reusa el
   cálculo del streaming actual" — falso: el streaming de chunks es 100% del
   cliente (genera el terreno desde la seed). Hubo que construir la noción de
   coordenada de chunk en el servidor desde cero, respetando el offset `+8`
   del cliente (los bloques son centre-based, el chunk 0 va de -8 a 7). Si eso
   se desalinea, servidor y cliente hablan de chunks distintos.
2. **No hay bookkeeping de tiempo por chunk, y es a propósito.** El plan
   proponía guardar "el timestamp del último tick real". Llevar un reloj por
   chunk es justamente lo que CREA el fast-forward que se quería evitar.
   Congelar = saltear el tick, sin más. Al volver, se sigue con el dt normal.

`SIMULATION_RADIUS_CHUNKS` (4) tiene que seguir siendo mayor que
`VIEW_RADIUS_CHUNKS` del cliente (3), o se vería lo que no se simula: mobs
congelados parados dentro del campo de visión.

Le di un consumidor real de una vez en vez de dejarlo como código muerto
esperando la 6b: **la IA de mobs**, que hasta ahora corría en todo el mundo
hubiera o no alguien cerca. Pathfinding y AI son el trabajo por entidad más
caro del servidor y no es observable sin nadie en rango.

Ítems tirados y flechas **no** se congelan, a propósito: congelar un ítem
pausaría también su despawn de 60s, así que se acumularían para siempre en
zonas que nadie visita — lo contrario del objetivo. Y una flecha en vuelo
congelada se vería rota. Los dos son baratos y de vida corta igual.
Decisión: agua y fuego se simulan **completos** server-side (no visual-only),
pero acotados a un **render distance fijo de 4 chunks alrededor de cada
jugador** para no pagarle a Cloudflare por CPU de Durable Object simulando
chunks que nadie está viendo. Esto es infraestructura nueva, no existe hoy
nada parecido en `world-do.ts` (el streaming de chunks actual es solo para
saber qué mandar al cliente, no filtra qué se simula).

- `world-do.ts`: mantener un set de "chunks activos" = unión de los chunks
  dentro de radio 4 de cada jugador conectado, recalculado cuando algún
  jugador se mueve de chunk (mismo evento que ya dispara el streaming actual,
  se reusa el cálculo, no hace falta uno nuevo).
- Cualquier sistema de simulación continua (fuego y agua acá, y a futuro
  cualquier otro) consulta este set antes de avanzar su tick en un chunk dado.
- **Congelamiento, no reseteo**: si un chunk con fuego activo queda fuera del
  set (todos los jugadores se alejan), el estado de fuego/agua de ese chunk
  se guarda tal cual está (mismo storage que bloques editados) y su tick se
  salta por completo — no se "apaga" ni avanza el tiempo, literalmente se
  congela. Si un jugador vuelve a acercarse, el chunk retoma la simulación
  desde donde quedó, con el timestamp del último tick real para no acumular
  "tiempo perdido" de golpe (evitar que un árbol que estuvo 10 minutos fuera
  de rango se consuma en fast-forward apenas alguien vuelve).
- Esto responde directamente al ejemplo que diste: un árbol prendido fuego que
  sale del rango de visión de todos deja de propagarse/consumirse hasta que
  alguien vuelva a estar a 4 chunks o menos.

## Fase 6b — Agua y fuego dinámicos (simulación completa, acotada a Fase 6)  ✅ HECHO
Requiere Fase 6 ya en pie. Simulación real por voxel, no aproximada.

Cómo quedó: forks de `water-engine.ts` (con `LavaEngine`) y `fire-engine.ts`
en `game/`. La simulación es idéntica — mismas distancias, mismos intervalos
de tick, misma regla de fuente infinita, mismas probabilidades de propagación.
Solo se sacó `getWaterFlow()` y sus ayudantes, que devuelven un THREE.Vector3
y sirven únicamente para empujar al jugador y animar la superficie del lado
cliente.

Resultó que **el singleplayer ya tenía el mismo concepto de congelar por
distancia** (`fluid-sim-radius.ts`, 24 bloques), así que la adaptación fue
sustituir "radio alrededor del único jugador" por el predicado de la región
activa (unión de todos los jugadores). El comportamiento buscado ya estaba.

**El detalle más peligroso de esta fase**, por si se toca de nuevo: hay DOS
caminos de escritura de bloque y no se pueden mezclar.
- `setBlock()` es el de bajo nivel, el que usan los motores. Solo notifica al
  motor de fuego.
- `setBlockFromPlayer()` agrega avisarle a agua/lava que apareció una FUENTE.

Si se notificara agua/lava desde `setBlock()`, cada celda que el propio motor
va colocando al fluir se convertiría en una fuente nueva y el mundo se
inundaría. El singleplayer mantiene exactamente la misma separación entre
`World.setBlock` y `World.place`, por la misma razón.

También se porteó `resolveLiquidInteractionAt` (agua + lava → obsidiana si era
fuente, adoquín si era flujo): sin eso los dos líquidos se atraviesan, porque
ninguno de los dos motores sabe que el otro existe.

Dos cosas propias del servidor:
- **Tope de celdas de fuego simultáneas** (512). Pasado el tope el fuego
  existente sigue envejeciendo y apagándose, pero no prende ninguna celda
  nueva, así que un incendio desbocado se estanca y después retrocede en vez
  de crecer sin límite. Red de seguridad para la CPU, no regla de juego.
- **Adopción de fuego huérfano al despertar el DO.** El estado de los motores
  vive en memoria; si el DO es reciclado en medio de un incendio, los bloques
  de FUEGO siguen persistidos pero nada los rastrea — y solo las celdas
  rastreadas se apagan. Sin esto, arderían por el resto de la vida del mundo.

Limitación conocida, para la Fase 12: las FUENTES de agua/lava no se persisten
(no se puede distinguir fuente de flujo mirando solo el bloque). Tras un
reciclado del DO el agua ya colocada se queda quieta, comportándose como el
agua estática de antes de esta fase, hasta que alguien coloque una fuente
nueva.

- **Agua**: portar `src/water-engine.ts` server-side tal cual (import directo
  si no toca DOM/Three.js, o fork mínimo si sí) pero con su tick de
  propagación filtrado por el set de chunks activos de Fase 6. Cada celda que
  cambia de nivel se emite como una edición de bloque más (mismo mecanismo
  que romper/colocar), así el cliente no necesita saber nada de "simulación
  de agua", solo recibe bloques que cambian.
- **Fuego**: portar `src/fire-engine.ts` server-side con el mismo filtro de
  chunks activos — propagación a bloques inflamables vecinos con
  probabilidad/tiempo, también expresada como ediciones de bloque hacia el
  cliente. El detalle visual (partículas de llama, chisporroteo) se queda del
  lado cliente (Fase 8), el servidor solo es dueño de "qué bloque es fuego
  ahora y cuál no".
- Cliente: overlay de fuego en pantalla al estar dentro de una llama (comparte
  mecanismo con Fase 4/8).
- Ojo con el costo aun acotado a 4 chunks: si varios jugadores están lejos
  entre sí, cada uno arrastra su propia región de 4 chunks simulándose en
  paralelo — vale la pena poner un límite razonable de "focos de fuego activos
  simultáneos" como salvaguarda adicional si en pruebas el CPU del DO se
  dispara con varios incendios grandes a la vez.

## Fase 7 — PvP con spawn protection de 3x3 chunks  ✅ HECHO

Cómo quedó, y lo que este plan no había previsto:

**La muerte tuvo que cambiar de forma, no solo de presentación.** Antes el
servidor reseteaba vida y teletransportaba en el mismo instante, así que el
cliente NUNCA veía la vida llegar a 0 — no había momento en el cual mostrar
una pantalla de muerte. Ahora el jugador queda muerto de verdad: congelado en
0 de vida, sin física, sin input, sin ser blanco de nada, y sale de la lista
de entidades (los demás dejan de verlo). El respawn ocurre recién cuando lo
pide, vía los mensajes nuevos `died` / `respawn`.

La zona protegida chequea **al atacante además de a la víctima**: chequear
solo a la víctima dejaría abierto pararse adentro de la zona y cazar a
quien pase por el borde.

El centro de la zona se cachea. `findLandSpawn()` ya era determinístico (una
espiral desde el origen, sin azar), así que siempre devolvía lo mismo; el
caché solo evita recorrer la espiral de nuevo y le da a la protección un
centro fijo en vez de algo recalculado en cada chequeo.

La pantalla de muerte es propia del multiplayer, NO se reusa el
`#death-screen` del singleplayer: `main.ts` ya tiene sus botones atados al
respawn del singleplayer, así que compartir el elemento ejecutaría la lógica
de ese mundo desde adentro de una sesión multiplayer.

Sin knockback en PvP, igual que mob→jugador, que tampoco lo tiene.

- Quitar el filtro `if (msg.targetId < 0)` que hoy bloquea todo ataque a otro
  jugador, y aplicar el mismo camino de `hurtPlayer`/daño/knockback que ya
  existe para mob→jugador, ahora también jugador→jugador.
- **Zona protegida**: un área fija de 3x3 chunks centrada en el punto de spawn
  del mundo. Dentro de esa zona, `attack` con `targetId` de otro jugador se
  ignora server-side (igual de silencioso que el filtro actual, solo que
  acotado por posición en vez de bloqueado siempre). Chequeo simple: convertir
  la posición del atacante y del objetivo a coordenadas de chunk y comparar
  contra el rango del spawn — si cualquiera de los dos está dentro, no hay
  daño.
- Pantalla y animación de muerte del jugador (hoy es un reset silencioso):
  portar el flujo de `main.ts` (death screen, freeze de input, respawn con
  cuenta regresiva o botón) al cliente multiplayer — beneficia tanto a PvP
  como a muerte por mob/caída/ahogamiento/fuego, conviene resolverlo una sola
  vez acá.

## Fase 8 — Ambiente: sonido, música, partículas, overlays  ✅ HECHO
Todo puramente cliente (`multiplayer-game.ts`), sin tocar `world-server/`.

Cómo quedó: se reusan los módulos del singleplayer tal cual. Para no tener que
inventarles un `World` falso, se ensanchó el tipo de dos constructores a la
superficie mínima que de verdad usan (`Pick<World, 'getBlock'>` en
`ambient-sound.ts`, y `getBlock` + `getWaterDistance` en
`underwater-manager.ts`). Nada más cambió en esos archivos.

**El bug más sutil de esta fase**, por si se toca de nuevo: el overlay bajo el
agua no se veía al principio. `UnderwaterManager` pinta su azul UNA sola vez,
en el frame en que entrás al agua; pero `applyDayNightState` del cliente
multiplayer repinta el cielo CADA frame, así que borraba ese azul en el mismo
frame y nunca llegaba a verse. El singleplayer no tiene el problema porque
solo repinta cuando el color del ciclo cambia de verdad. Acá la guarda es
explícita: se calcula siempre el color de superficie en `currentSkyColor`,
pero solo se pinta si no estás sumergido, y `underwater.update()` corre
DESPUÉS del ciclo día/noche para que al salir del agua se restaure el cielo de
la hora actual y no un azul de mediodía fijo.

Los overlays (fuego, agua) son elementos propios del multiplayer, no los del
singleplayer: el loop de `main.ts` sigue corriendo por detrás de la sesión y
maneja los suyos desde su propio estado, así que compartirlos sería pelearse
por la clase CSS cada frame.

Las partículas de romper bloque salen para las ediciones de TODOS los
jugadores, no solo las propias, porque el handler de `blockChanged` ya las ve
todas.

- Sonido ambiente por bioma/altura: portar `ambient-sound.ts` tal cual (ya es
  reusable, solo hay que instanciarlo en `multiplayer-game.ts` con el estado
  de posición/bioma que el cliente ya tiene disponible).
- Música de mundo: portar `world-music.ts` igual de directo.
- Partículas de humo y de bloque roto: portar `smoke-particles.ts`/
  `particles.ts`, dispararlas en reacción a eventos que ya viajan por
  protocolo (bloque roto, mob muerto de Fase 2).
- Overlay bajo el agua (`underwater-manager.ts`) y overlay de fuego (nuevo,
  ver Fase 4/6): ambos son "pintar un rectángulo semitransparente según un
  booleano de estado del jugador", se implementan igual una vez que el
  booleano exista en el protocolo.

## Fase 9 — Comandos de chat: descartado por ahora (revertido)
Decisión original: **nadie puede usar comandos en multiplayer** hasta que el
resto del modo esté 100% funcional — se revisaba recién en ese punto, no
antes. No se implementaba nada de `chat-commands.ts` server-side en este plan.

**Revertido en `PLAN-MULTIPLAYER-BUGFIXES.md`, Fase 6**: con las 13 fases de
este plan más las bugfixes ya completas, el modo se considera funcional, así
que se implementó `/summon` y `/give`, abiertos a cualquier jugador conectado
(sin sistema de permisos/creativo, que no existe en el proyecto), parseados y
resueltos por el servidor — nunca por el cliente. Ver ese documento para el
detalle.

## Fase 10 — Grid de crafteo real 2x2/3x3  ✅ HECHO
Hoy multiplayer usa una lista simplificada de "lo craftable ahora". Portar el
grid real:

Cómo quedó: las celdas viven en la sesión del servidor (no en el inventario),
igual que el `CraftingGrid` del singleplayer tiene sus propios slots. El
resultado lo deriva el servidor con `matchRecipe()` — la misma función pura de
`src/crafting.ts`, importada directo — así que el cliente nunca necesita la
lista de recetas ni las reglas de coincidencia de formas para dibujar lo que
sale.

**No se usó un cursor de "ítem en la mano" por la red.** Se reusó el patrón de
dos clics que ya tenía la mochila (`moveSlot`): cada movimiento es un mensaje
autocontenido. Lo único que se agregó es una *zona* en cada extremo
(`inventory` o `grid`), porque ahora los movimientos cruzan entre dos arrays
distintos. Por eso `moveOrMergeSlot` se generalizó a `moveOrMergeBetween` en
vez de duplicar la semántica de fusionar-o-intercambiar en dos lados.

El 3x3 **solo** lo concede una mesa de crafteo real: el servidor verifica que
el bloque sea `CRAFTING_TABLE` en vez de confiar en lo que pide el cliente,
que si no podría pedir siempre el grid grande.

Cuidado con perder ítems: cerrar el grid (y desconectarse) devuelve todo lo
que haya en las celdas al inventario. El `closeCraftGrid` en `onDisconnect`
hoy no cambia nada visible, porque el inventario se pierde igual al
desconectar — pero pasa a importar en cuanto la Fase 12 lo persista, y
dejarlo puesto ahora significa que esa fase no se puede olvidar.

La lista simplificada se sacó del cliente. Los mensajes `craft` /
`craftableRecipes` siguen existiendo en el protocolo y el servidor los sigue
atendiendo; simplemente ya no hay UI que los use.

- Reusar `crafting-grid.ts`/`crafting.ts` (ya son lógica pura, import directo).
- `world-do.ts`: nuevo estado de grid por jugador (4 o 9 slots) + mensaje de
  protocolo para colocar/mover ítems dentro del grid, con el servidor
  recalculando la receta resultante en cada cambio (mismo patrón que ya usa
  para el horno).
- Cliente: portar `crafting-table-ui.ts` para el render del grid.

## Fase 11 — Comer ítems  ✅ HECHO

Cómo quedó, con una decisión que el plan no había considerado: **el bocado NO
es instantáneo.** Tarda los mismos 1.6s (EAT_DURATION) que en singleplayer.

El plan decía solo "leer foodValue, curar y consumir el ítem", que hubiera
dado una curación instantánea. Pero ahora que existe PvP (Fase 7), curarse a
full en medio de una pelea sin ningún tiempo de carga no es una diferencia
cosmética con el singleplayer, es una diferencia de balance real. Así que el
servidor arranca el bocado con `useItem` y lo completa un tick después de
EAT_DURATION.

Un pedido compromete el bocado entero (no hay mensaje de "solté el botón"); se
cancela si cambiás de slot, si la comida deja el slot, o si morís.

Del lado cliente hay sonido de masticado local durante esos 1.6s: sin una
señal inmediata, el click se sentiría como que no hizo nada hasta que los
corazones saltan de golpe.

Sigue sin haber sistema de hambre en NINGUNO de los dos modos, así que comer
solo cura (y la curación se clampea al máximo), igual que en singleplayer.
- El protocolo ya acepta `useItem`; falta el handler server-side: leer
  `foodValue` (ya existe en `item.ts`, ver el cambio reciente en
  `multiplayer-game.ts`), curar vida o restaurar hambre si Fase de hambre
  llegara a implementarse (hoy no existe en ningún lado, no es parte de este
  plan salvo que se pida aparte), y consumir el ítem del slot.

## Fase 12 — Persistencia entre sesiones  ✅ HECHO
La última porque conviene que el resto del gameplay esté más asentado antes de
comprometerse al formato de guardado (cambiar el esquema de storage después de
que la gente ya tenga partidas guardadas es más costoso que hacerlo una vez).

### Identidad verificada  ✅ RESUELTO
Al principio el guardado se keyeaba por el nombre que el cliente escribía, que
era la única identidad disponible — y cualquiera que abriera un WebSocket
crudo con el nombre de otro heredaba su inventario.

Ya está cerrado: el access worker **firma un token** al iniciar sesión
(`src/net/auth-token.ts`, HMAC-SHA256 con un secreto compartido) y el world
server lo **verifica** al entrar, sacando el nombre de adentro del token.
`join` ya no lleva ningún nombre. Ver `AUTH_SECRET` en el README del access
worker; sin el secreto el sistema falla hacia el lado seguro (no se emite
token y se rechazan todos los joins).

El módulo de firma lo comparten los dos workers a propósito: firmar y
verificar son justo el par que se rompe en silencio si se duplica.

### Cómo quedó
- Los guardados se **precargan** al despertar el DO en vez de leerse dentro de
  `onJoin`, que es síncrono. Volverlo async dejaría una ventana donde los
  primeros `input` del cliente llegan antes de que exista la sesión y se
  descartan.
- Cadencias de escritura pensadas para no gastar de más: jugadores cada 30s
  (más un guardado inmediato al desconectar), hornos cada 30s más cuando
  entran o salen ítems — el progreso de cocción cambia cada tick y no se
  escribe por eso solo.
- El guardado al desconectar corre DESPUÉS de vaciar el grid de crafteo, así
  lo que estaba puesto en las celdas entra al inventario que se guarda en vez
  de perderse (era justo lo que la Fase 10 dejó preparado).
- Nunca se restaura a alguien con 0 de vida, aunque el guardado lo diga: sería
  revivir dentro de un cadáver del que no se puede salir.

Dos trampas de aliasing que costaron atención:
1. `savePlayer` tiene que actualizar el mapa en memoria, no solo el storage.
   Si no, desconectarse y volver dentro de la misma vida del DO restauraba el
   registro viejo cargado al arrancar, y el siguiente guardado pisaba el
   progreso real.
2. El inventario se copia en profundidad al restaurar. Si se adoptara por
   referencia, dos sesiones con el mismo nombre (una segunda pestaña)
   escribirían sobre los mismos objetos de slot.

- Inventario del jugador: guardar por `player-store.ts` (ya existe el patrón
  en singleplayer) keyeado por identidad de jugador en `state.storage`, cargar
  en `onJoin` en vez de `createEmptyInventory()` siempre.
- Posición/spawn del jugador: mismo mecanismo, guardar última posición conocida
  y restaurarla en reconexión en vez de buscar spawn nuevo.
- Estado del horno: persistir `FurnaceState` en `state.storage` igual que ya
  se hace con bloques editados, para que sobreviva un reciclado del DO.
- Mobs: ya cubierto en Fase 2.

## Fase 13 — Medición de tick time (para fijar el cap de jugadores con datos)  ✅ HECHO

**Corrección importante a lo que este plan proponía:** medir con
`performance.now()` alrededor del cuerpo del tick NO funciona en Cloudflare.
Los Workers congelan los temporizadores como mitigación de Spectre, así que
`Date.now()`/`performance.now()` no avanzan a lo largo de un bloque de código
síncrono — ese par de mediciones habría leído 0ms para siempre y habría dado
una falsa sensación de que todo está holgado.

Lo que sí se mide es el **hueco de reloj entre ticks**, que cruza un límite
asíncrono real y por lo tanto sí avanza. Y además es el número más útil:
`tick()` corre con un `dt` FIJO, así que un tick que no llega a tiempo es
literalmente un mundo en cámara lenta, que es justo el síntoma que siente el
jugador.

**Cómo leerlo:** `GET /stats/<worldId>` devuelve JSON con jugadores, mobs,
chunks activos, ítems, flechas, y el promedio/pico del hueco entre ticks sobre
los últimos 100 ticks (5 segundos). El hueco debería quedarse en 50ms
(`targetTickMs`). Sostenidamente por encima = el mundo va atrasado; ahí está
el techo real de jugadores de ese mundo.

Ojo: el endpoint está **sin autenticar**. Solo expone contadores, nada de
quién juega — pero pedirlo DESPIERTA el Durable Object, así que cualquiera que
sepa un id de mundo podría mantenerlo facturando a fuerza de polling. Vale
revisarlo antes de un deploy público.
Un Durable Object es un solo hilo: todos los jugadores de un mundo comparten el
mismo tick de 20Hz (50ms de presupuesto). Si el tick promedio se pasa de ese
presupuesto, el lag lo sufren todos, no solo quien lo causó.

- `world-do.ts`: medir con `performance.now()` antes/después del loop de tick y
  guardar un promedio móvil + el pico de los últimos N ticks.
- Exponerlo por algún canal barato de leer mientras se prueba (log periódico, o
  un endpoint `/stats` en `index.ts` que devuelva JSON con: jugadores
  conectados, mobs activos, chunks activos de Fase 6, tick promedio, tick pico).
- Sirve para fijar el número real de jugadores máximo por mundo con datos
  medidos en vez de una estimación: la referencia es que el tick promedio no
  pase de ~30-40ms (deja margen sobre los 50ms antes de que se note).
- Estimación de arranque mientras no haya datos: **6-10 jugadores por mundo**.
  Para más gente en total, la salida es más mundos (más Durable Objects, que sí
  corren en paralelo entre sí), no más jugadores en el mismo DO.
- Conviene tenerlo funcionando **antes** de Fase 6b (agua/fuego), que es la que
  más CPU va a agregar — así se mide el antes y el después.

---

## Decisiones ya tomadas (para no reabrir la discusión más adelante)
- **PvP**: habilitado, con spawn protection de 3x3 chunks (Fase 7).
- **Comandos de chat**: implementados y abiertos a cualquier jugador (`/summon`,
  `/give`) — ver Fase 9 arriba y `PLAN-MULTIPLAYER-BUGFIXES.md`, Fase 6.
- **Agua/fuego**: simulación completa server-side (no visual-only), acotada a
  un render distance fijo de 4 chunks por jugador vía la región activa de
  Fase 6, para controlar el costo de CPU del Durable Object.

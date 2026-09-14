# `world-server/src/game/`

Copias deliberadas de módulos de `src/` (el singleplayer), a propósito
bifurcadas para poder iterar rápido del lado del servidor sin depender de
que cada archivo de singleplayer siga siendo "seguro de importar" en el
runtime de Cloudflare Workers (sin DOM, sin `document`/`Image`, sin
`import.meta.glob`).

## Qué se copió y por qué

- `player-physics.ts` - física del jugador.
- `mob-manager.ts` - **no** es una copia completa: solo los tipos (`Mob`,
  `MobKind`, `AnyMobModel`) y las stats (`MOB_STATS`, `isHostileKind`) que
  `mobs.ts`/`mob-ai.ts`/`mob-physics.ts` realmente usan, sin la cadena de
  renderizado (`MobModel`/`BipedMobModel`, sonidos, drops) que el archivo
  real trae consigo.
- `mob-ai.ts` - IA de mobs. `ARROW_GRAVITY`/`powerToSpeed` quedaron
  inlineados en vez de importados de `arrow-projectiles.ts` (esa cadena
  arrastra mallas/texturas 3D que no aplican server-side).
- `mob-physics.ts` - física de mobs.
- `mob-pathfinding.ts` - A* de mobs (sin dependencias, copia 1:1).
- `day-night-math.ts` - matemática pura del ciclo día/noche. Singleplayer y
  el servidor llevan relojes independientes (cada mundo el suyo), así que
  no hace falta que coincidan bit a bit - se copió por comodidad, no por
  necesidad de identidad.

## Qué sigue importado desde `../../../src/` (NO copiado)

- `block.ts` - IDs y propiedades de bloques. Los valores del enum `BlockId`
  tienen que ser exactamente los mismos en cliente y servidor (viajan como
  números crudos por el protocolo); copiarlo arriesgaría que diverjan sin
  que nadie lo note.
- `chunk.ts` / `terrain-noise.ts` / `worldgen/*` - generación de terreno.
  Cliente y servidor DEBEN generar el mismo mundo byte a byte - el cliente
  lo usa para renderizar, el servidor para colisión real. Una diferencia
  acá (aunque sea una constante cambiada "sin querer tocar nada importante")
  produce el tipo de bug más difícil de diagnosticar que hay: el jugador
  atraviesa paredes invisibles o queda flotando sobre bloques que no
  existen, sin ningún error en consola.
- `net/protocol.ts` - el contrato de mensajes cliente↔servidor. Si diverge,
  los mensajes simplemente se ignoran (el type guard `isServerMessageType`/
  `isClientMessageType` no reconoce el tipo) en vez de tirar un error obvio.

## Si tocás algo acá

Estos archivos NO se sincronizan solos con `src/`. Si arreglás un bug de
física/IA en singleplayer y también aplica al servidor (o viceversa),
tenés que aplicar el cambio a mano en los dos lugares. Cada archivo copiado
lleva un comentario de cabecera con la fecha de la bifurcación para que
quede claro que es intencional, no un olvido.

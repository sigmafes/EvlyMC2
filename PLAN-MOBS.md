# Plan: cerdo, vaca y oveja — modelos y animaciones (sin IA)

Alcance de esta tanda: que los 3 mobs existan visualmente en el mundo (modelo 3D,
textura correcta, animación de idle + caminata) y se puedan invocar para probarlos.
**Sin IA todavía**: no caminan solos, no huyen, no hay spawn natural ni reproducción.
Eso queda para una fase posterior por separado.

Texturas ya presentes en `textures/mobs/`: `pig.png`, `cow.png`, `sheep.png`, las 3
de 64×32 px (formato clásico de mob de Minecraft — mismo formato que `player.png`
pero la mitad de alto). Las revisé a simple vista: `pig.png` y `cow.png` parecen el
layout vainilla estándar (cabeza + cuerpo + 4 patas); `sheep.png` tiene la capa de
lana como una región aparte (igual al truco de "hat/jacket" del jugador: caja base +
caja inflada con alpha por encima).

## Por qué no reinventar la rueda: reusar lo que ya existe en player-model.ts

`player-model.ts` ya tiene resuelto todo lo genérico que un mob cuadrúpedo necesita:
- `applyAtlasUVs()` / `FACE_ORDER` — mapea rects de píxeles del atlas a las 6 caras
  de un `BoxGeometry`, con flips de U/V. Hoy es privado a ese archivo.
- `applyFaceShading()` — el mismo shading direccional por cara (`FACE_SHADE`) que ya
  usan el jugador y los bloques del mundo, así los mobs se ven consistentes sin luces
  reales de Three.js.
- El patrón de "capa exterior inflada + alphaTest" (`addOverlay`, `INFLATE_WD/H`) —
  exactamente lo que necesita la lana de la oveja.
- El patrón de animación de caminata (`isWalking`/`isReturning`, ángulos de pierna
  por fase, `WALK_CYCLE_DURATION`, retorno suavizado a idle) — aplicable tal cual a
  patas de cuadrúpedo.
- `tintByLight()` (en `block-preview.ts`) — mismo mecanismo que ya usan los items
  dropeados para teñirse según la luz del mundo en su posición.

Así que la Fase A es extraer lo reusable a un módulo compartido en vez de duplicar
~150 líneas de matemática de UVs en cada mob.

## Fase A — Extraer utilidades de atlas/caja compartidas  ✅ HECHO
Mover `FaceKey`, `FACE_ORDER`, `applyAtlasUVs()`, `applyFaceShading()` (y el tipo
`FaceRects`/`PixelRect`) de `player-model.ts` a un nuevo `src/atlas-box.ts`, sin
cambiar su comportamiento. `player-model.ts` pasa a importarlos desde ahí. Riesgo
bajo (mover código, no reescribirlo) — es la base para todo lo demás y conviene
dejarla aparte para no mezclar "mover" con "escribir cosas nuevas" en el mismo diff.

## Fase B — `MobModel`: builder genérico de cuadrúpedo  ✅ HECHO
Nueva clase (o función factory) `src/mob-model.ts` que arma cabeza + cuerpo + 4
patas a partir de una tabla de configuración por especie:
```ts
type QuadrupedSpec = {
  texturePath: string;
  textureW: number; textureH: number;      // 64x32 para los 3 actuales
  head: { size: [w,h,d]; pivot: [x,y,z]; uv: FaceRects };
  body: { size: [w,h,d]; pivot: [x,y,z]; uv: FaceRects; rotateX90?: boolean };
  leg:  { size: [w,h,d]; uv: FaceRects };   // misma caja para las 4, distinta pivot
  legPivots: [x,y,z][];                      // FL, FR, BL, BR
  overlay?: { size:[w,h,d]; pivot:[x,y,z]; uv: FaceRects; inflate: number }; // lana
};
```
La clase expone lo mínimo que un futuro sistema de IA va a necesitar enganchar
después (sin implementarlo ahora): `getGroup()`, `setWalking(bool)`,
`update(delta)`, `setLightLevel(level01)`. Mismo espíritu que `PlayerModel`, pero
sin nada de first-person-hand ni inventory-doll ni sneak/pose especial — un mob no
tiene esas necesidades.

## Fase C — Medir los UV rects reales de cada textura
Nada de asumir el layout vainilla de memoria: repetir el método que ya usé para el
horno y el slot de crafteo (leer los PNG con Python, detectar los bloques de color
sólido por flood-fill o inspección directa, anotar rects `[x0,y0,x1,y1]`) para
`pig.png`, `cow.png` y `sheep.png` — incluida la región de lana de la oveja. Esto
evita adivinar mal un offset y que la textura quede desalineada, mismo bug que
arreglamos con la flecha del horno.

## Fase D — Pig
`PIG_SPEC` con las dimensiones vainilla (cabeza 4×3×3, cuerpo 10×8×6 rotado 90° para
quedar horizontal, patas 4×6×4, más pivots) traducidas a las unidades de bloque del
juego (mismo factor que usa `PlayerModel`, 16 px = 1 bloque). `new MobModel(PIG_SPEC)`
+ escala/altura total ≈ 0.9 bloques como referencia.

## Fase E — Cow
Igual que el pig pero con las dimensiones de la vaca (más alta y más grande, cabeza
más angosta). Mismo `MobModel`, otro `QuadrupedSpec`.

## Fase F — Sheep (con lana)
Igual, más el `overlay` de lana: caja inflada sobre cuerpo+patas con alpha, mismo
truco que `addOverlay()` del jugador. Esto valida que `MobModel` soporte overlays
antes de darlo por cerrado (si algo del diseño de la Fase B no alcanza, se ajusta
acá, con los 3 casos reales ya sobre la mesa en vez de reabrir el diseño después).

## Fase G — Animación idle + caminata
Dentro de `MobModel.update(delta)`: bob de cabeza sutil en idle, y cuando
`setWalking(true)` un ciclo de piernas alternadas (mismo patrón de fase/retorno
suave que `PlayerModel`). Sin input de movimiento real todavía — esto es lo que la
futura IA va a llamar, pero se puede probar ya mismo forzando `setWalking(true)` a
mano.

## Fase H — Scaffold mínimo para verlos en el mundo (sin IA)
Sin un sistema de entidades todavía, hace falta ALGO para poder mirarlos en el
juego. Propuesta acotada, en la línea de `DroppedItems`/`FurnaceManager`:
- `MobManager` simple: lista de mobs activos, cada uno con posición fija (world
  space) + su `MobModel`; `update(delta, getLight)` solo avanza la animación y
  aplica `tintByLight` — nada de física ni movimiento.
- Comando de chat `/summon <pig|cow|sheep>` (mismo patrón/gating por cheats que
  `/give`, `/panorama`, `/fly`) que instancia uno frente al jugador, quieto, con
  `setWalking(true)` fijo para poder ver el ciclo de caminata sin esperar a la IA.
- Sin persistencia todavía (no sobreviven un reload) — no tiene sentido guardarlos
  hasta que exista colocación/spawn real.

## Explícitamente fuera de esta tanda
IA/pathing, colisión con el terreno, spawn natural por bioma, reproducción/breeding,
daño/muerte y drops, sonidos de mob, hitbox para golpearlos. Todo eso presupone que
el modelo+animación ya estén sólidos, que es justo lo que cierra este plan.

## Orden sugerido
A → B son la base (sin esto no hay dónde colgar C-F). C es un prerrequisito de
D/E/F pero rápido. D antes que E/F porque el pig es el más simple (sin overlay) —
sirve para validar el diseño de MobModel con el caso fácil antes de sumarle la
complejidad de la lana en F. G se puede hacer en paralelo con D-F (una vez que hay
un `MobModel` cualquiera armado, la animación no depende de qué especie sea). H va
al final porque es sólo para poder ver el resultado de todo lo anterior.

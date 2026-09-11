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

## Fase C — Medir los UV rects reales de cada textura  ✅ HECHO (pig) / pendiente por fase (cow, sheep)
Nada de asumir el layout vainilla de memoria. Los 3 PNG tienen canal alfa real (no
todo opaco), así que primero probé detectar los rects por huecos transparentes
(flood-fill de regiones opacas) — no funcionó: las partes están pegadas sin huecos
reales entre sí (todo queda como un solo blob conectado), y los huecos que sí se ven
fila por fila son irregularidades del propio dibujo (bordes redondeados de una pata,
por ejemplo), no bordes de región UV.

Lo que sí funcionó: aplicar la fórmula estándar de unfold de caja de Minecraft
(texOffs `(u,v)` + tamaño `(dx,dy,dz)` → 6 rects fijos) y **validarla contra los
píxeles reales** de `pig.png` en vez de confiar de memoria. Coincidió exacto:

- **Head** — texOffs (0,0), tamaño 8×8×8. Fila top/bottom en `x:[8,24) y:[0,8)`
  (confirmado pixel a pixel), fila right/front/left/back en `x:[0,32) y:[8,16)`.
- **Body** — texOffs (28,8), tamaño 10×16×8, rotada 90° en X (se modela acostada,
  se para con la rotación). Fila top/bottom en `x:[36,56) y:[8,16)`; fila
  right/front/left/back en `x:[28,64) y:[16,32)` (coincide exacto con la franja
  larga que se ve en la imagen de y=16 a y=31).
- **Leg** (compartida por las 4 patas, solo reposicionada) — texOffs (0,16),
  tamaño 4×6×4. Fila top/bottom en `x:[4,12) y:[16,20)`; fila
  right/front/left/back en `x:[0,16) y:[20,26)`.
- Rects completos (6 caras c/u) para las 3 partes quedan documentados directo en
  el código de la Fase D (`PIG_SPEC`), no acá, para no duplicar y desincronizar.
- Nota: hay un bloque de 8×4px sin usar en `x:[16,25) y:[16,20)` — arte suelto que
  no corresponde a ninguna parte del modelo vainilla, lo dejo sin mapear.

Para `cow.png` y `sheep.png` la misma fórmula predice bien cabeza/cuerpo a grandes
rasgos (verificado por encima), pero `cow.png` tiene extras que la vaca vainilla no
tiene en el template base (cuernos, ubre — se ven como bloques sueltos arriba/abajo
del área principal) y no los voy a inventar a ojo. Lo correcto es medirlos con el
mismo método **dentro de la Fase E/F de cada especie**, contra la textura real y
con un render de prueba para confirmar visualmente — así no repito trabajo si algo
no encaja, y cada fase queda con su propia verificación en vez de una tanda
"medí las 3 de una" con menos rigor en las últimas dos.

## Fase D — Pig  ✅ HECHO
`src/pig-model.ts`: `PIG_SPEC` con los rects reales medidos en la Fase C (cabeza
8×8×8 px, cuerpo 10×16×8 px rotado 90° para pararse, pata 4×6×4 px compartida por
las 4), convertidos a bloques a 16px/bloque (sin la inflación +10% que usa
`PlayerModel` - no hace falta acá). Pivots derivados de esas mismas medidas (alto
de pata = base del cuerpo, centro del cuerpo ajustado por la rotación, cabeza
pegada a la cara frontal del cuerpo) en vez de inventados - son una aproximación
razonada, no números vainilla exactos, así que van a necesitar un ajuste fino
visual una vez que exista la Fase H para verlo puesto en el mundo.
Compila y buildea limpio; no instanciado en ningún lado todavía (eso es H).

## Fase E — Cow  ✅ HECHO
`src/cow-model.ts`. Mismo método de medición que la Fase C/D, esta vez contra
`cow.png`: texOffs hipotetizado + verificado exacto contra los píxeles reales -
cabeza 8×8×6 px, cuerpo 12×18×10 px rotado 90°, pata 4×12×4 px (más alta que la
del pig, tiene sentido para un animal más grande). Un parche de ~6×6px cerca de
(52-61, 0-6) no encaja con ninguna de las 3 partes (cuernos/ubre por posición y
forma) y quedó sin mapear, misma decisión que el resto suelto del pig en la Fase C.
Altura total resultante (patas + cuerpo parado) ≈ 1.375 bloques, cerca de la
proporción vainilla real de la vaca (~1.4). Compila limpio; pivots con la misma
salvedad que el pig (aproximación razonada, ajuste visual pendiente de la Fase H).

## Fase F — Sheep  ✅ HECHO
`src/sheep-model.ts`. Cabeza 6×6×8 px, cuerpo 8×16×6 px rotado 90°, pata 4×12×4 px
- mismo método de medición y verificación que pig/cow.

**Cambio de plan real:** esta textura NO tiene una capa de lana separada e
inflada como supuse en el diseño original de esta fase (ni como el `addOverlay`
del jugador) - revisé todo el archivo (nada usado más allá de x=55 en un canvas
de 64px) y el patrón de lana está directamente horneado en la textura del cuerpo
normal, no en una segunda región. `MobModel` conserva el soporte de `overlay`
que armé en la Fase B (nadie lo está usando todavía, pero sigue disponible para
cuando haga falta un mob real con dos capas), sin inventar un overlay falso acá
solo por "probarlo".

**Bug real encontrado y corregido en D y E de paso:** la fórmula que usé para
mapear las caras `left`/`back` tenía el ancho cruzado (usaba `dx` donde iba
`dz` y viceversa) - con cabezas/patas cúbicas (pig) no se notaba porque
`dx == dz`, pero en los 3 cuerpos (ninguno cúbico) sí estaba mal. Lo detecté
al derivar sheep con cuidado extra y volví para arreglar `pig-model.ts` y
`cow-model.ts` (`BODY_UV`/`HEAD_UV` de la vaca) antes de seguir. Nunca se había
visto porque el bounding box total (lo único que había verificado pixel a
pixel hasta ahora) da igual sin importar el orden interno de `dx`/`dz` - los
sub-splits internos de una textura de pelaje no tienen borde de color visible
para chequear a ojo.

## Fase G — Animación idle + caminata  ✅ HECHO (ya venía de la Fase B)
`MobModel.update(delta)` ya tenía esto desde que se escribió en la Fase B: bob de
cabeza sutil en idle + ciclo de piernas diagonales alternadas al caminar, con
easing suave in/out en vez de un state machine de retorno explícito. No hizo
falta código nuevo acá, solo quedaba marcarla como hecha una vez que las 3
especies (D/E/F) confirmaron que el diseño genérico les sirve tal cual.

## Fase H — Scaffold mínimo para verlos en el mundo (sin IA)  ✅ HECHO
- `src/mob-manager.ts`: `MobManager` simple - lista de mobs activos, cada uno
  con posición fija (world space) + su `MobModel`; `update(delta, getLight)`
  solo avanza la animación y aplica `setLightLevel` según la luz del mundo en
  la posición del mob - nada de física ni movimiento propio.
- Comando de chat `/summon <pig|cow|sheep>` (mismo patrón/gating por cheats que
  `/give`, `/panorama`, `/fly`) en main.ts: instancia uno ~3 bloques delante del
  jugador, mirando hacia él, con `setWalking(true)` fijo para poder ver el
  ciclo de caminata sin esperar a la IA.
- Sin persistencia todavía (no sobreviven un reload) - no tiene sentido
  guardarlos hasta que exista colocación/spawn real.

Con esto termina el alcance de este plan (modelos + animación, sin IA). Compila
y buildea limpio, desplegado a `evlymc.pages.dev` para probar con `/summon pig`,
`/summon cow` o `/summon sheep` (necesita cheats habilitados en el mundo, mismo
requisito que el resto de los comandos). Las proporciones/pivots de cada
especie son una aproximación razonada (documentado en sus fases D/E/F) - a
ajustar a ojo ahora que por fin se pueden ver puestos.

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

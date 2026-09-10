# Sistema de agua voxel y migracion a TypeScript + Vite + Three.js

Este documento analiza el agua de este repositorio desde tres perspectivas:

1. **Estado del mundo:** que representa un bloque de agua y como se propaga.
2. **Interaccion:** como detecta el motor que una entidad esta en agua y como aplica el flujo.
3. **Render:** como se construye la superficie, como se anima la textura y como se ordena la transparencia.

La conclusion importante es que este proyecto no simula un fluido continuo. Usa un **automata de liquido voxelizado**: cada celda guarda un nivel discreto y el agua se actualiza mediante ticks. La sensacion de movimiento procede de dos capas distintas:

```text
simulacion de bloques       -> depth/data, propagacion, corriente y colision
animacion de textura        -> pixels 16x16, desplazamiento y ondulacion visual
geometria                   -> alturas por esquina, caras visibles y sombreado
```

Para una migracion fiel conviene mantener separadas estas capas. Animar solamente el shader no reproduce el movimiento del agua del mundo; simular los voxels sin animar la textura produce agua funcional pero visualmente estatica.

## 1. Mapa del codigo original

| Responsabilidad | Implementacion original |
|---|---|
| Propiedades de material | `src/world/level/material/LiquidMaterial.h` |
| Bloque liquido comun | `src/world/level/tile/LiquidTile.h` |
| Agua que se propaga | `src/world/level/tile/LiquidTileDynamic.h` |
| Agua estable | `src/world/level/tile/LiquidTileStatic.h` |
| Registro de agua dinamica/estatica | `src/world/level/tile/Tile.cpp` |
| Colision, deteccion y corriente sobre entidades | `src/world/level/Level.cpp`, `src/world/entity/Entity.cpp` |
| Movimiento de mobs en agua | `src/world/entity/Mob.cpp` |
| Teselacion de bloques de agua | `src/client/renderer/TileRenderer.cpp` |
| Textura animada superior y lateral | `src/client/renderer/ptexture/DynamicTexture.cpp` |
| Orden de las pasadas de terreno | `src/client/renderer/GameRenderer.cpp` |

En este codigo hay dos IDs para la misma idea: el agua dinamica y el agua estatica. `LiquidTileDynamic::setStatic` cambia `id` por `id + 1`; el bloque estatico vuelve a ser dinamico cuando cambia un vecino. En un proyecto nuevo puede conservarse con un campo `isSourceOrStatic`, pero es mas claro separar `kind` de `isScheduled` y evitar IDs consecutivos como contrato oculto.

## 2. Representacion de una celda

Cada bloque tiene un `data` entero de 0 a 15:

| `data` | Significado practico |
|---:|---|
| `0` | Fuente o agua de nivel completo |
| `1..7` | Agua que ha perdido profundidad; cuanto mayor, mas baja |
| `8..15` | Estado descendente/falling. Para renderizar y medir altura se interpreta como nivel 0 |
| `-1` | No es agua de ese material; valor interno de `getDepth`/`getRenderedDepth` |

La altura visible se calcula en `LiquidTile::getHeight`:

```cpp
if (d >= 8) d = 0;
float h = (d + 1) / 9.0f;
```

En TypeScript:

```ts
export function liquidHeight(data: number): number {
  const renderedData = data >= 8 ? 0 : data;
  return (renderedData + 1) / 9;
}
```

Por tanto, una fuente tiene altura `1 / 9`, no `1`. Es una peculiaridad de esta implementacion: el bloque con agua encima hace que la altura de una esquina se fuerce a `1`, y el resultado visual de un estanque completo depende de los vecinos. No sustituir esta formula por `1 - data / 8` si se busca compatibilidad visual.

El material liquido no es solido, no bloquea movimiento y es reemplazable. El bloque de agua tampoco tiene una AABB propia (`getAABB` devuelve `NULL`), por lo que las entidades no chocan con el agua como con piedra.

## 3. Propagacion del agua

### 3.1 Reloj de simulacion

El agua dinamica tiene `getTickDelay() == 5`; la lava usa 30. Al colocarse o cambiar un vecino, el agua dinamica se agenda para un tick futuro. El agua estatica no se actualiza de forma normal; al recibir un cambio de vecino se convierte a dinamica.

En Three.js no conviene hacer depender la simulacion de la frecuencia de render. Usa un acumulador fijo:

```ts
const WATER_TICK_SECONDS = 5 / 20; // si el mundo tiene 20 ticks por segundo

let accumulator = 0;
function updateWorld(deltaSeconds: number): void {
  accumulator += Math.min(deltaSeconds, 0.25);
  while (accumulator >= WATER_TICK_SECONDS) {
    world.tickLiquids();
    accumulator -= WATER_TICK_SECONDS;
  }
}
```

La version original agenda actualizaciones; no recorre todo el mundo en cada tick. En un mundo por chunks, usa una cola de coordenadas y marca para reconstruccion el chunk de la celda y los vecinos cuyas caras puedan haber cambiado.

### 3.2 Regla de profundidad

Para cada celda dinamica con `depth > 0`, el algoritmo busca la menor profundidad de sus cuatro vecinos horizontales. Las fuentes (`0`) cuentan para `maxCount` y los estados `>= 8` se convierten temporalmente en `0` para esta comparacion.

```text
dropOff = 1 para agua
highest = minimo nivel horizontal valido
newDepth = highest + dropOff

si newDepth >= 8 o no existe vecino valido:
    newDepth = -1  // eliminar la celda
```

El bloque superior tiene prioridad. Si arriba hay agua:

```text
si above >= 8: newDepth = above
si no:         newDepth = above + 8
```

Esto hace que el agua que cae use `8..15` y se renderice como una columna completa abajo. La propagacion vertical hacia abajo se intenta antes que la horizontal:

```text
si la celda inferior acepta agua:
    profundidad inferior = depth >= 8 ? depth : depth + 8
si no y la celda inferior bloquea o depth == 0:
    repartir horizontalmente con neighbor = depth >= 8 ? 1 : depth + 1
```

El bloque solo se propaga horizontalmente si el nivel resultante es menor que `8`. La funcion `getSpread` calcula el camino de menor distancia alrededor de obstaculos para no extender el agua de manera arbitraria por todas las direcciones.

### 3.3 Fuentes

Cuando al menos dos de los cuatro vecinos horizontales son fuentes, el agua puede crear una nueva fuente si:

- debajo hay un bloque solido; o
- debajo hay agua y la celda actual tambien es fuente.

Esta regla es deliberadamente especifica de la implementacion. Si el nuevo proyecto necesita fuentes infinitas mas simples, se puede reemplazar, pero debe documentarse como cambio de gameplay.

### 3.4 Pseudocodigo TypeScript

```ts
type LiquidCell = { kind: 'water'; data: number; dynamic: boolean };

function tickWater(x: number, y: number, z: number): void {
  const cell = world.getLiquid(x, y, z);
  if (!cell || !cell.dynamic) return;

  let depth = getDepth(x, y, z);
  let dropOff = 1;
  let maxSources = 0;
  let highest = -1;

  for (const [dx, dz] of horizontalDirections) {
    const neighbor = getDepth(x + dx, y, z + dz);
    if (neighbor < 0) continue;
    if (neighbor === 0) maxSources++;
    const rendered = neighbor >= 8 ? 0 : neighbor;
    highest = highest < 0 ? rendered : Math.min(highest, rendered);
  }

  let newDepth = highest < 0 || highest + dropOff >= 8
    ? -1
    : highest + dropOff;

  const above = getDepth(x, y + 1, z);
  if (above >= 0) newDepth = above >= 8 ? above : above + 8;

  if (maxSources >= 2 && world.isSolidBlocking(x, y - 1, z)) {
    newDepth = 0;
  }

  if (newDepth !== depth) {
    if (newDepth < 0) world.removeBlock(x, y, z);
    else world.setLiquidData(x, y, z, newDepth);
  }

  if (canReceiveWater(x, y - 1, z)) {
    setWater(x, y - 1, z, depth >= 8 ? depth : depth + 8);
  } else if (depth >= 0 && (depth === 0 || isWaterBlocking(x, y - 1, z))) {
    const spreadLevel = depth >= 8 ? 1 : depth + 1;
    if (spreadLevel < 8) {
      for (const direction of getLowestSpreadDirections(x, y, z)) {
        trySpread(x + direction.dx, y, z + direction.dz, spreadLevel);
      }
    }
  }
}
```

El pseudocodigo muestra la estructura, no pretende ser una copia literal: la implementacion original tambien reagenda la celda, notifica vecinos y convierte agua dinamica en estatica cuando ya no cambia.

## 4. Flujo y fisica de entidades

### 4.1 Deteccion de interseccion

`Entity::isInWater()` expande la caja de colision solamente hacia abajo `0.4` y llama a `Level::checkAndHandleWater`. El nivel recorre todas las celdas cubiertas por la AABB:

```text
x0 = floor(box.x0), x1 = floor(box.x1 + 1)
y0 = floor(box.y0), y1 = floor(box.y1 + 1)
z0 = floor(box.z0), z1 = floor(box.z1 + 1)
```

Una celda cuenta como agua si su material coincide y el extremo superior de la AABB alcanza la superficie:

```cpp
liquidTop = y + 1 - liquidHeight(data);
isInside = box.y1 >= liquidTop;
```

Esto no calcula un porcentaje de volumen sumergido. Basta tocar la parte liquida de una celda para activar la respuesta.

`isUnderLiquid` es distinto: toma la altura de la cabeza, busca solo la celda bajo esa posicion y comprueba si la cabeza esta por debajo de la superficie. Se usa para la interfaz y para efectos de camara bajo el agua.

### 4.2 Campo de corriente

`LiquidTile::getFlow` inspecciona cuatro vecinos. Para cada vecino calcula una diferencia de nivel:

```text
vecino horizontal: dir = neighborDepth - currentDepth
vecino no liquido con agua debajo: dir = belowDepth - (currentDepth - 8)
flow += direccionHorizontal * dir
```

Si la celda actual es descendente (`data >= 8`) y tiene una cara lateral visible, añade una componente vertical fuerte:

```text
flow = normalize(flow) + (0, -6, 0)
flow = normalize(flow)
```

Si el flujo es cero, el agua no empuja. Durante la deteccion, cada celda acumula `flow * 0.5`. Al final se normaliza la fuerza acumulada y se suma a la velocidad de la entidad con magnitud fija `0.004`:

```cpp
pow = 0.004f / current.length();
velocity += current * pow;
```

La fuerza es pequena y se aplica por tick, no por frame. En TS:

```ts
function applyWaterFlow(entity: Entity): boolean {
  const box = entity.bounds.clone().expand(0, -0.4, 0);
  const total = new THREE.Vector3();
  let inside = false;

  for (const cell of world.cellsIntersecting(box)) {
    if (cell.material !== 'water') continue;
    if (box.max.y < cell.y + 1 - liquidHeight(cell.data)) continue;
    inside = true;
    total.add(getFlow(cell.x, cell.y, cell.z).multiplyScalar(0.5));
  }

  if (total.lengthSq() > 0) {
    total.normalize().multiplyScalar(0.004);
    entity.velocity.add(total);
  }
  return inside;
}
```

### 4.3 Movimiento de un mob

Cuando un mob esta en agua, `Mob::travel` usa aceleracion horizontal `0.02`, mueve la entidad, aplica inercia `0.80` en los tres ejes y gravedad `0.02`. Si choca horizontalmente y puede subir, salta con velocidad vertical `0.3`.

```ts
if (isInWater(entity)) {
  moveRelative(entity, inputX, inputZ, 0.02);
  move(entity, entity.velocity);
  entity.velocity.multiply(new THREE.Vector3(0.8, 0.8, 0.8));
  entity.velocity.y -= 0.02;
  if (horizontalCollision(entity) && isFree(entity, 0, 0.6, 0)) {
    entity.velocity.y = 0.3;
  }
}
```

Proyectiles usan una variante distinta: inercia `0.80` y gravedad propia. Al entrar generan burbujas. No mezclar automaticamente la fisica de mobs con la de objetos lanzados.

## 5. Geometria que se renderiza

### 5.1 Culling de caras

El agua se renderiza como `SHAPE_WATER`, no como un cubo solido. Una cara lateral no se dibuja si el vecino tiene el mismo material; la cara superior se permite aunque el vecino no sea solido. Tampoco se dibuja contra hielo en esta implementacion.

La malla de un bloque puede tener:

- cara superior;
- cara inferior;
- cuatro caras laterales visibles.

Si ninguna cara es visible, la teselacion termina sin emitir vertices. En Three.js aplica el mismo criterio antes de crear geometria; es una optimizacion importante en oceanos grandes.

### 5.2 Alturas de las cuatro esquinas

La cara superior no es un plano horizontal fijo. Para las esquinas `(x,z)`, `(x,z+1)`, `(x+1,z+1)`, `(x+1,z)` se consultan celdas locales y diagonales mediante `getWaterHeight`.

La regla de `getWaterHeight` es:

1. Inspeccionar cuatro celdas alrededor de la esquina.
2. Si hay agua en la celda superior, devolver `1` inmediatamente.
3. Si la celda es agua, sumar su altura. Las fuentes y estados descendentes pesan diez veces en el promedio.
4. Si el material no es solido, sumar `1`.
5. Devolver `1 - h / count`.

En forma matematica, si las muestras son alturas `q_i` con pesos `w_i`:

$$
H_{corner} = 1 - \frac{\sum_i w_i q_i}{\sum_i w_i}
$$

Es un promedio ponderado de los niveles bajos. Esta formula explica por que el borde del agua se inclina suavemente hacia celdas vacias y por que las fuentes dominan la superficie. En una implementacion nueva conviene precalcular las cuatro alturas al reconstruir el chunk, no recalcularlas dentro de cada draw call.

### 5.3 Emision de vertices

La cara superior emite cuatro vertices con alturas independientes:

```ts
const top = [
  new THREE.Vector3(x,     y + h0, z),
  new THREE.Vector3(x,     y + h1, z + 1),
  new THREE.Vector3(x + 1, y + h2, z + 1),
  new THREE.Vector3(x + 1, y + h3, z),
];
```

Cada lateral usa la altura de sus dos esquinas superiores y baja hasta `y`. Las coordenadas UV verticales de los vertices superiores tambien se ajustan a la altura (`v = yTex + (1 - h) * 16`); por eso la textura lateral no queda estirada de forma uniforme cuando el borde esta inclinado.

El renderer original usa una textura atlas `terrain.png` de 256x256. `getTexture(0/1)` devuelve la textura superior y `getTexture(2..5)` la textura lateral. Al migrar a Three.js, un `DataTexture` o un atlas cargado con `TextureLoader` puede conservar esta estrategia, pero hay que configurar:

```ts
texture.wrapS = THREE.RepeatWrapping;
texture.wrapT = THREE.RepeatWrapping;
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.colorSpace = THREE.SRGBColorSpace;
```

El `colorSpace` debe decidirse junto con el resto de la pipeline. Para reproducir los valores de color antiguos de forma estricta, prueba primero sin tone mapping y valida una captura; una pipeline PBR no sera pixel-identica.

## 6. Sombreado y transparencia

Las caras usan factores direccionales fijos:

| Cara | Factor |
|---|---:|
| Inferior | `0.5` |
| Superior | `1.0` |
| Norte/sur | `0.8` |
| Este/oeste | `0.6` |

El brillo de un bloque liquido toma el maximo entre la celda y la celda superior. En Three.js, para una version sencilla, guarda `brightness` por vertice y multiplica el color base. Para una version escalable, guarda luz y factor de cara como atributos y calcula el color en un shader.

El agua usa la capa de render `BLEND`; la lava usa `OPAQUE`. El `GameRenderer` dibuja primero terreno opaco, despues una pasada alpha general y finalmente el agua. Antes de la pasada de agua desactiva la escritura de profundidad (`depthMask(false)`), activa blending y vuelve a restaurar el estado al terminar.

Equivalente aproximado con Three.js:

```ts
const waterMaterial = new THREE.MeshLambertMaterial({
  map: waterTexture,
  vertexColors: true,
  transparent: true,
  opacity: 0.58,
  depthWrite: false,
  side: THREE.DoubleSide,
});
```

Notas practicas:

- `depthWrite: false` evita que la primera cara de agua oculte indebidamente las siguientes.
- `DoubleSide` reproduce mejor el comportamiento cuando se mira desde dentro, aunque aumenta el coste; si el winding es consistente, puede usarse `FrontSide` y una pasada interior separada.
- `transparent` no resuelve por si solo el orden entre muchos chunks. Ordena los chunks transparentes por distancia a la camara o usa una estrategia de depth pre-pass.
- Para agua visible desde dentro, añade un color/fog submarino en la camara cuando `isUnderLiquid('water')` sea verdadero. El codigo original tambien dibuja un plano de agua sobre la vista en `ItemInHandRenderer::renderWater`.

## 7. Animacion de textura

La textura dinamica no mueve vertices. Mantiene cuatro buffers de `16 * 16` floats:

```text
current: estado de la onda actual
next:    siguiente estado
heat:    energia acumulada por pixel
heata:   impulso y decaimiento de la energia
```

### 7.1 Agua superior

Para cada pixel, suma los tres pixels horizontales vecinos con wrap-around y actualiza:

$$
next[x,y] = \frac{current[x-1,y] + current[x,y] + current[x+1,y]}{3.3}
           + 0.8 \cdot heat[x,y]
$$

Despues:

```text
heat += heata * 0.05
heat = max(heat, 0)
heata -= 0.1
con probabilidad 0.05: heata = 0.5
swap(current, next)
```

El valor se limita a `[0,1]`, se eleva al cuadrado y se convierte a RGBA:

```text
pp = pow * pow
R = 32  + pp * 32
G = 50  + pp * 64
B = 255
A = 146 + pp * 50
```

### 7.2 Agua lateral

La cara lateral usa el mismo concepto, pero la suma se hace en tres posiciones verticales (`y-2..y`) y divide entre `3.2`. El impulso decae mas rapido (`0.3`) y aparece con probabilidad `0.2`. Antes de generar el pixel final desplaza el indice:

```cpp
current[(i - tickCount * 16) & 255]
```

Esto crea un desplazamiento vertical continuo en la textura lateral, mientras que la superficie superior solo ondula localmente.

### 7.3 Migracion como `DataTexture`

La traduccion directa a Three.js es un `THREE.DataTexture` RGBA de 16x16:

```ts
const pixels = new Uint8Array(16 * 16 * 4);
const texture = new THREE.DataTexture(
  pixels,
  16,
  16,
  THREE.RGBAFormat,
  THREE.UnsignedByteType,
);
texture.wrapS = THREE.RepeatWrapping;
texture.wrapT = THREE.RepeatWrapping;
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;
texture.needsUpdate = true;
```

Implementa el tick con `Float32Array` y dos referencias intercambiables, igual que el codigo original. No uses `Math.random()` si necesitas determinismo de replay: inyecta un PRNG del mundo.

Para muchos bloques de agua, una alternativa mas eficiente es trasladar `current`, `heat` y `heata` a un shader con ping-pong de `WebGLRenderTarget`. La textura de 16x16 es global y no necesita una simulacion por bloque. Mantenerla como `DataTexture` es mas simple y suficiente para el look original.

## 8. Arquitectura recomendada para el proyecto TS/Vite

Una division pequena y comprobable:

```text
src/world/liquid/LiquidTypes.ts       tipos, data y formulas puras
src/world/liquid/WaterSimulation.ts   cola, ticks y propagacion
src/world/liquid/WaterFlow.ts         getFlow y respuesta de entidades
src/render/liquid/WaterHeights.ts     alturas por esquina y culling
src/render/liquid/WaterMesher.ts      BufferGeometry por chunk
src/render/liquid/WaterTexture.ts     DataTexture y animacion 16x16
src/render/liquid/WaterMaterial.ts    material/shader y estados alpha
```

Mantener funciones puras para `liquidHeight`, `getFlow` y `getCornerHeight` permite probarlas sin WebGL. La simulacion debe emitir un evento como:

```ts
type LiquidChange = { x: number; y: number; z: number };
onLiquidChanged(change: LiquidChange): void;
```

El renderer convierte esos eventos en `dirtyChunks`. Una celda cambiada puede afectar geometria de su chunk y de los chunks vecinos por las muestras de esquinas y por el culling de caras.

## 9. Orden recomendado del bucle

```text
requestAnimationFrame
    -> acumular delta
    -> ejecutar ticks fijos del mundo
        -> propagar agua y notificar celdas modificadas
        -> actualizar entidades y aplicar corriente
    -> reconstruir solo chunks de agua dirty
    -> actualizar WaterTexture una vez por tick visual
    -> renderizar opacos
    -> renderizar agua transparente ordenada
    -> aplicar overlay/fog si la camara esta bajo agua
```

La textura puede actualizarse a frecuencia de render si se desea mas fluidez, pero la simulacion voxel y la corriente deben permanecer ligadas al tick fijo. Si se hace todo en `requestAnimationFrame`, el comportamiento cambiara con los FPS.

## 10. Diferencias y trampas de la implementacion original

- `getHeight(0)` devuelve `1/9`; no representa por si sola un cubo lleno.
- Los niveles `>= 8` son falling y se tratan como `0` para la altura.
- El agua no tiene colision solida, pero si puede impedir que `isFree` devuelva verdadero porque el nivel considera cualquier liquido.
- `isInWater` aplica la corriente como efecto secundario. Una funcion equivalente que solo consulte el estado no debe olvidar separar `containsWater` de `applyFlow` si se busca una arquitectura mas limpia.
- La cara superior y las laterales consultan vecinos diferentes para el brillo.
- Agua y lava comparten gran parte del algoritmo, pero no deben compartir material visual: agua mezcla alpha; lava es opaca y tiene otros delays y reglas.
- La textura dinamica usa wrap-around bitwise (`& 15`, `& 255`), que solo funciona porque las dimensiones son potencias de dos.
- La textura de agua usa canales RGBA con alpha calculado, mientras el material original decide el blending con estado OpenGL global.
- El render de chunks transparentes necesita una politica explicita de orden; WebGL no garantiza que el orden de objetos produzca transparencias correctas en todas las vistas.
- El agua estatica mantiene el mismo `data`, pero deja de recibir ticks. Si se edita un bloque cercano, debe reactivarse.

## 11. Plan de implementacion incremental

1. Crear una grilla de bloques con `material`, `data` y `dynamic`; probar `liquidHeight`.
2. Implementar ticks fijos y propagacion vertical/horizontal con una cola.
3. Implementar `getFlow`, AABB y movimiento de una entidad de prueba.
4. Crear el mesher de una celda con alturas `h0..h3` y culling de caras.
5. Reemplazar la textura estatica por `DataTexture` animada.
6. Separar la malla de agua en una pasada transparente con `depthWrite: false`.
7. Añadir fog/overlay submarino, burbujas y ordenamiento de chunks.
8. Comparar capturas con los casos: fuente aislada, cascada, borde con aire, dos fuentes, esquina contra bloque solido y camara bajo agua.

## 12. Pruebas minimas

Las pruebas mas valiosas son deterministas y no necesitan Three.js:

```text
liquidHeight(0) == 1/9
liquidHeight(8) == liquidHeight(0)
agua cae a la celda inferior con data >= 8
agua horizontal baja de data 0 a 1, 2, ...
dos fuentes pueden recrear una fuente bajo las reglas del mundo
getFlow devuelve vector cero en un estanque simetrico
una cascada tiene componente vertical hacia abajo
una entidad bajo la superficie pero con la cabeza fuera no esta underLiquid
una celda cambiada marca su chunk y los vecinos necesarios
```

En el render, valida que los cuatro vertices de la cara superior tienen alturas distintas cuando el agua limita con aire y que el agua no escribe profundidad. En movil, limita la reconstruccion a chunks dirty y evita una geometria independiente por bloque cuando la superficie pueda fusionarse por chunk.

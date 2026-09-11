# Plan: tanda de 17 bugfixes

17 bugs reportados de una vez. Diagnostiqué la causa raíz de cada uno (leyendo el código
real, y en 3 casos con un test de nodo) antes de planear, para no adivinar durante la
implementación. Agrupados en 7 fases por subsistema — cada fase es un commit+deploy
independiente, de menor a mayor riesgo.

## Fase A — Horno: pulido  ✅ HECHO
1. **Sprite atascado en el slot de input.** Causa real: `lastSig` se reseteaba a
   `''` (string vacío) tanto en `open()` como al inicializar, y `''` es también la
   firma legítima de un slot vacío. Si el horno terminó de cocinar (input pasó a
   vacío) mientras el GUI estaba cerrado, al reabrir el reset a `''` coincidía con
   la firma real (también `''`) → `paintSlot` creía que no había cambiado nada y
   nunca volvía a llamar `renderSlot`, dejando el canvas viejo pegado. Fix: `lastSig`
   ahora es `string | null`, inicializado/reseteado a `null` (una firma que un slot
   real nunca puede tener), así el primer repintado tras abrir u cerrar siempre
   fuerza el render. También se resetea en `close()` por robustez.
2. **Receta `cobblestone → stone`** añadida a `smelting.ts`.
3. **Cara on/off del horno.** Encontrada la causa real (no era la matemática, que ya
   había verificado): en `interaction.ts`, `this.onPlace?.()` —que llama
   `inventory.consumeSelected()`— se ejecutaba *antes* de leer `this.selectedBlock`
   para decidir la orientación. Si el jugador colocaba el *último* horno de un stack,
   `consumeSelected()` vacía el slot y dispara `onSelect(null)` →
   `interaction.selectBlock(null)`, que pone `this.selectedBlock = null` en caliente,
   justo antes de que el código de `isOrientable`/torch/sonido lo leyera — se saltaba
   la escritura del `facing` (y también el sonido de colocar, mismo bug). Reproducible
   con `/give furnace 1` o al craftear solo 1. Fix: capturar `this.selectedBlock` en
   una variable local *antes* de llamar `onPlace()`, y usar esa copia después.

## Fase B — Antorcha: pulido  ✅ HECHO
4. **No debe ser sólida + no debe mostrar el delineado.** Nuevo `isSolidBlock(id)`
   compartido en `block.ts` (excluye AIR/WATER/LAVA/FIRE/TORCH), usado en
   `chunk.ts getCollidersInBounds()` (colisión física) — reutilizable en la Fase F
   para la cámara 3ª persona. `block-highlight.ts` ahora oculta el wireframe por
   completo cuando el bloque mirado es una antorcha (no es un cubo, un box 1×1×1
   flotando encima no tenía sentido visualmente).
5. **Antorcha de pared floja/flotando.** Confirmado: en `mesher.ts addTorch()` el
   offset hacia el muro era `0.30`, pero la cara del bloque de soporte está a `0.5`
   del centro de la celda — le faltaban 0.2 bloques. Subido a `0.44`.
6. **Antorcha más grande.** Mismo `addTorch()`: `hw`/`H` subidos de `0.34/0.7` a
   `0.45/0.9`.
7. **Debe renderizarse como item en la mano.** `isBlock(TORCH)` es `true`, así que
   `first-person-hand.ts`/`player-model.ts` la metían por la rama de bloque (pose de
   cubo pesado) aunque la geometría ya era plana. Ambas ahora tratan `TORCH` como caso
   especial *antes* del chequeo `isBlock`, usando `buildItemMesh('blocks/torch.png')`
   (la extrusión de píxeles de herramientas/items) con la pose de item — en el modelo
   de 3ª persona, sin el flip vertical que usan las herramientas (esa serviría para
   apuntar el filo hacia abajo; en la antorcha invertiría la llama).
7. **Debe renderizarse como item en la mano, no como bloque.** `isBlock(TORCH)` es
   `true`, así que `first-person-hand.ts`/`player-model.ts` la meten por la rama de
   bloque (pose/escala de cubo pesado), aunque `buildBlockMesh` ya la dibuja como quad
   plano — el problema es la POSE, no la geometría. Fix: tratarla como caso especial en
   esas dos ramas de "sostener en mano", usando `buildItemMesh('blocks/torch.png')`
   (la extrusión de píxeles que ya usan herramientas/items) en vez de `buildBlockMesh`,
   con la pose/escala de item.

## Fase C — Delineado de bloque (todas)  ✅ HECHO
8. **El wireframe muestra aristas por dentro del bloque.** Causa exacta encontrada:
   `block-highlight.ts` usa `depthTest: false` en el `LineBasicMaterial` — dibuja las
   12 aristas del cubo sin importar qué haya delante, incluidas las del lado opuesto a
   la cámara (efecto rayos-X). Fix: `depthTest: true` (mantener `depthWrite: false`);
   como la caja ya está inflada 1% (`scale 1.01`), las aristas del lado visible pasan
   el depth-test por estar justo delante de la superficie real, y las del lado oculto
   quedan tapadas por el propio bloque — que es exactamente el comportamiento pedido.

## Fase D — Chat en Android  ✅ HECHO
9. **Borrar texto no funciona.** Encontré la causa: `Chat.onKeyDown` (listener global
   en `document`, capture-phase) intercepta *todas* las teclas cuando el chat está
   abierto, incluido Backspace, hace `preventDefault()` y recorta `this.buffer`
   manualmente — pero el `<input>` oculto que levanta el teclado táctil (`softInput`)
   nunca se entera (su `.value` no cambia porque el backspace nativo quedó
   bloqueado). Al siguiente carácter tecleado, el listener de `input` relee
   `softInput.value` (que todavía tiene el texto viejo completo) y **deshace** el
   borrado visual. Fix: si `document.activeElement === this.softInput`, dejar que el
   `<input>` nativo maneje todo (no interceptar en `onKeyDown`) y confiar solo en el
   listener `input` para sincronizar `buffer`.
10. **El botón de chat debe cerrar el chat si ya está abierto.** Hoy `onChat` solo
    llama `chat.openInput()`. Añadir `chat.closeInput()` (público) y que el botón
    alterne según `chat.isOpen`.

## Fase E — Hojas / decay
11. **Decaen demasiado rápido.** `LeavesManager.DECAY_CHANCE = 0.06` se evalúa en
    `world.updateLeavesDecay()`, llamado una vez por frame del game-loop (no por
    "tick" de Minecraft) — a 60 fps eso es ~0.28s de vida media, casi instantáneo, y
    además la velocidad de decay queda atada al framerate del dispositivo. Fix:
    convertir a probabilidad **por segundo** (`chance = RATE * delta`), independiente
    del framerate, con `RATE` afinado para que un árbol talado tarde unos 10-20s en
    perder toda la copa (sensación tipo MC).
12. **Las hojas decaídas vuelven tras salir/entrar al mundo.** Causa exacta: `world.
    updateLeavesDecay()` quita la hoja con `this.setBlock(x,y,z,AIR)`, que es el
    método interno para cambios "de simulación" (agua/lava) que **deliberadamente no
    persiste** (`editStore.record` nunca se llama). Al recargar, la generación
    determinista reconstruye el árbol completo con todas sus hojas. Fix: usar
    `this.remove(x,y,z)` en su lugar (sí persiste, ya limpia block-data, etc.) —
    mismo patrón que rompe cualquier otro bloque.
13. **Las hojas decaídas deben soltar palos/manzanas.** Hoy la remoción por decay no
    pasa por `getDrops`/`onDrop` en absoluto. Fix: inyectar un callback de drop
    opcional en el constructor de `World` (mismo patrón que `soundManager`), y en
    `updateLeavesDecay()` llamar `getDrops(BlockId.OAK_LEAVES, true)` por cada hoja
    antes de removerla, igual que al minar a mano.

## Fase F — Física del jugador
14. **La cámara en 3ª persona atraviesa bloques.** `PlayerController.updateCamera()`
    coloca la cámara en un offset fijo sin ningún chequeo contra el mundo. Fix: un
    sondeo por pasos (voxel stepping, sin necesitar el raycaster de Three.js) desde el
    ojo del jugador hacia la posición deseada de la cámara, usando el `isSolidBlock()`
    compartido de la Fase B; si hay un bloque sólido en el camino, la cámara se acerca
    hasta justo antes de tocarlo (el clásico "camera boom collision").
15. **Mantener Space en agua debe hundir un poco por cada "flotada".** Hoy
    `player-physics.ts` amortigua `velocity.y` hacia un objetivo fijo `+3.2` mientras
    Space está presionado — sube de forma continua e indefinida, sin nada de
    hundimiento. Voy a convertirlo en un sistema de "brazadas": mientras se mantiene
    Space, un impulso hacia arriba cada ~0.35s con una leve caída entre impulsos, en
    vez de una subida perfectamente suave — se siente como nadar de verdad en lugar de
    flotar sin esfuerzo. Afinaré las constantes durante la implementación.
16. **No se debería poder correr en sneak ni viceversa.** Confirmado: `sprinting` y
    `sneaking` se controlan totalmente independiente en `player.ts` (Ctrl y Shift no se
    consultan entre sí). Fix: una sola vía de entrada que fuerza exclusión mutua —
    activar sneak apaga sprint y viceversa. Incluye sincronizar el botón táctil de
    sneak si el sprint lo cancela programáticamente.

## Fase G — Simulación de agua (la más delicada)
17. **Romper un bloque bajo el mar no hace bajar el agua; queda "flotando".** Causa
    raíz: el océano generado proceduralmente **nunca se registra en `WaterEngine`** —
    solo el agua colocada por el jugador (o recargada desde edits) se vuelve una
    "source" simulada (`reapplyLiquidEdits` solo mira `editStore`, no la generación).
    Así que minar bajo el mar crea un hueco de aire que la simulación ni sabe que
    existe. Simular el océano completo sería costoso (miles de celdas). Fix
    quirúrgico de bajo riesgo: en `World.remove()`, si la celda vaciada tiene un
    vecino `WATER`, rellenarla con agua inmediatamente (reconciliación de un solo
    bloque, no simulación completa) y persistir eso como el edit en vez de `AIR`. Cubre
    el caso real reportado (minar dentro de una masa de agua) sin tocar el motor de
    simulación existente.

## Orden sugerido
A → B → C → D son independientes y de bajo riesgo (UI/render, sin tocar física).
E toca persistencia (mismo patrón que ya usa `ChunkEditStore`, riesgo medio).
F y G tocan movimiento/agua — las dejo al final y por separado para poder probarlas con
calma sin arrastrar cambios de las fases anteriores.

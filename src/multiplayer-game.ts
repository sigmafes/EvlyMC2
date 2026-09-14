import * as THREE from 'three';
import { MpClient } from './net/mp-client';
import { BlockId } from './block';
import { lockPointer, unlockPointerForGui } from './is-touch';
import type { EntitySnapshot } from './net/protocol';

/**
 * Fase 6 of the multiplayer migration plan: the client side of the world
 * server built in Fase 5. Deliberately self-contained (its own scene/camera/
 * renderer/canvas, own input handling) rather than woven into main.ts's
 * singleplayer flow - that keeps this first version from risking any
 * regression to the existing (much larger, much more capable) singleplayer
 * game while the multiplayer path is still this early/limited.
 *
 * What this does NOT do yet (matches world-do.ts's own documented scope):
 * no real terrain (a flat ground plane only), no mobs, no inventory/crafting/
 * furnace, no client-side prediction (camera POSITION always comes from the
 * server's last `state` message - only look direction is local, for
 * responsiveness). Every one of those is a real follow-up, not a corner cut
 * by accident.
 */

const TICK_HZ = 20;
const SEND_INTERVAL_MS = 1000 / TICK_HZ;
const MOUSE_SENSITIVITY = 0.0022;
const PLACE_BLOCK_ID = BlockId.STONE;
const REACH = 5;

type OtherPlayer = {
  mesh: THREE.Group;
  label: HTMLDivElement;
};

export function startMultiplayer(serverUrl: string, worldId: string, playerName: string): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#mp-canvas')!;
  const crosshair = document.querySelector<HTMLElement>('#mp-crosshair')!;
  const hint = document.querySelector<HTMLElement>('#mp-hint')!;
  const menu = document.querySelector<HTMLElement>('#main-menu')!;
  const connectScreen = document.querySelector<HTMLElement>('#multiplayer-connect')!;

  canvas.hidden = false;
  crosshair.hidden = false;
  hint.hidden = false;
  menu.hidden = true;
  connectScreen.hidden = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7fb8ff);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.6);
  sun.position.set(3, 10, 2);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 500);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // Placeholder flat world, matching world-do.ts's collision exactly: solid
  // for y<=0, so the ground's visible top surface sits at y=0.5.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshLambertMaterial({ color: 0x4a8f3c }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.5;
  scene.add(ground);

  const blockGeo = new THREE.BoxGeometry(1, 1, 1);
  const blockMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
  const placedBlocks = new Map<string, THREE.Mesh>();

  const otherPlayers = new Map<number, OtherPlayer>();
  const labelLayer = document.createElement('div');
  labelLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;';
  document.body.appendChild(labelLayer);

  let selfId = -1;
  let yaw = 0;
  let pitch = 0;
  let seq = 0;
  let running = true;
  let lastServerPos = new THREE.Vector3(0, 2, 0);

  const keys = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === 'Escape') disconnect('Disconnected');
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) return;
    yaw -= e.movementX * MOUSE_SENSITIVITY;
    pitch -= e.movementY * MOUSE_SENSITIVITY;
    pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  };
  document.addEventListener('mousemove', onMouseMove);

  const raycaster = new THREE.Raycaster();
  const onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== canvas) { lockPointer(canvas); return; }
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const targets = [ground, ...placedBlocks.values()];
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits.find((h) => h.distance <= REACH);
    if (!hit || !hit.face) return;
    const worldNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).round();
    if (e.button === 0) {
      // Left click: break - only meaningful on an actual placed block, not the infinite ground plane.
      const userData = hit.object.userData as { bx?: number; by?: number; bz?: number };
      if (userData.bx === undefined) return;
      client.send({ type: 'breakBlock', x: userData.bx, y: userData.by!, z: userData.bz! });
    } else if (e.button === 2) {
      const p = hit.point.clone().addScaledVector(worldNormal, 0.5);
      const bx = Math.round(p.x), by = Math.round(p.y), bz = Math.round(p.z);
      client.send({ type: 'placeBlock', x: bx, y: by, z: bz, blockId: PLACE_BLOCK_ID, face: 0 });
    }
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  function makePlayerAvatar(name: string): OtherPlayer {
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.2, 4, 8),
      new THREE.MeshLambertMaterial({ color: 0x3a7bd5 }),
    );
    body.position.y = -0.9; // camera-height origin -> feet roughly at ground
    mesh.add(body);
    scene.add(mesh);
    const label = document.createElement('div');
    label.textContent = name;
    label.style.cssText = 'position:absolute;color:#fff;font:12px Tricraft,sans-serif;text-shadow:1px 1px 0 #000;transform:translate(-50%,-100%);white-space:nowrap;';
    labelLayer.appendChild(label);
    return { mesh, label };
  }

  function applyBlockChange(x: number, y: number, z: number, id: BlockId): void {
    const key = `${x},${y},${z}`;
    const existing = placedBlocks.get(key);
    if (id === BlockId.AIR) {
      if (existing) { scene.remove(existing); placedBlocks.delete(key); }
      return;
    }
    if (existing) return;
    const mesh = new THREE.Mesh(blockGeo, blockMat);
    mesh.position.set(x, y, z);
    mesh.userData = { bx: x, by: y, bz: z };
    scene.add(mesh);
    placedBlocks.set(key, mesh);
  }

  const messageEl = document.querySelector<HTMLElement>('#multiplayer-connect-message')!;
  function disconnect(reason: string): void {
    if (!running) return;
    running = false;
    client.disconnect();
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('resize', onResize);
    document.exitPointerLock();
    canvas.hidden = true;
    crosshair.hidden = true;
    hint.hidden = true;
    labelLayer.remove();
    for (const [, p] of otherPlayers) { scene.remove(p.mesh); p.label.remove(); }
    renderer.dispose();
    unlockPointerForGui();
    connectScreen.hidden = false;
    messageEl.textContent = reason;
    messageEl.classList.toggle('mp-error', reason !== 'Disconnected');
  }

  const client = new MpClient();
  client.connect(serverUrl, worldId, playerName, {
    onWelcome: (msg) => {
      selfId = msg.playerId;
      lastServerPos.set(msg.spawn.x, msg.spawn.y, msg.spawn.z);
      camera.position.copy(lastServerPos);
    },
    onRejected: (reason) => disconnect(`Rejected: ${reason}`),
    onState: (msg) => {
      lastServerPos.set(msg.self.pos.x, msg.self.pos.y, msg.self.pos.z);
      const seen = new Set<number>();
      for (const e of msg.entities as EntitySnapshot[]) {
        if (e.kind !== 'player') continue; // no mobs from the server yet (see class doc comment)
        seen.add(e.id);
        let op = otherPlayers.get(e.id);
        if (!op) { op = makePlayerAvatar(e.name ?? `Player${e.id}`); otherPlayers.set(e.id, op); }
        op.mesh.position.set(e.pos.x, e.pos.y, e.pos.z);
        op.mesh.rotation.y = e.yaw;
      }
      for (const [id, op] of otherPlayers) {
        if (seen.has(id)) continue;
        scene.remove(op.mesh); op.label.remove(); otherPlayers.delete(id);
      }
    },
    onBlockChanged: (msg) => applyBlockChange(msg.x, msg.y, msg.z, msg.blockId),
    onEntityRemoved: (id) => {
      const op = otherPlayers.get(id);
      if (op) { scene.remove(op.mesh); op.label.remove(); otherPlayers.delete(id); }
    },
    onChat: (from, text) => console.log(`[chat] ${from}: ${text}`),
    onClose: (reason) => disconnect(reason),
  });

  let lastSend = 0;
  function sendInput(now: number): void {
    if (now - lastSend < SEND_INTERVAL_MS) return;
    lastSend = now;
    let moveX = 0, moveZ = 0;
    if (keys.has('KeyW')) moveZ -= 1;
    if (keys.has('KeyS')) moveZ += 1;
    if (keys.has('KeyA')) moveX -= 1;
    if (keys.has('KeyD')) moveX += 1;
    client.send({
      type: 'input',
      seq: ++seq,
      moveX, moveZ,
      wantJump: keys.has('Space'),
      sprinting: keys.has('ControlLeft'),
      sneaking: keys.has('ShiftLeft'),
      yaw, pitch,
      dtMs: SEND_INTERVAL_MS,
    });
  }

  function updateLabels(): void {
    const v = new THREE.Vector3();
    for (const [, p] of otherPlayers) {
      p.mesh.getWorldPosition(v);
      v.y += 1.1;
      v.project(camera);
      if (v.z > 1) { p.label.style.display = 'none'; continue; }
      p.label.style.display = 'block';
      p.label.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
      p.label.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    }
  }

  function frame(now: number): void {
    if (!running) return;
    requestAnimationFrame(frame);
    // Position is always the server's last confirmed value (no local
    // prediction yet - see the class doc comment); look direction is local
    // for a responsive camera despite network latency on movement itself.
    camera.position.copy(lastServerPos);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    sendInput(now);
    updateLabels();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);

  canvas.addEventListener('click', () => { if (document.pointerLockElement !== canvas) lockPointer(canvas); });
}

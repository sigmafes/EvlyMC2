import * as THREE from 'three';
import type { Chat } from './chat';
import type { PlayerController } from './player';
import type { MobManager, MobKind } from './mob-manager';
import type { DayNightCycle, TimePhase } from './day-night-cycle';
import type { Inventory } from './inventory';
import type { MobSpawning } from './mob-spawning';
import { MOB_SPECS } from './mob-spawning';
import { isTouchDevice } from './is-touch';
import { capturePanorama, downloadPanoramaZip } from './panorama';
import { BLOCK_CATALOG } from './creative-palette';
import { ITEMS, maxStackOf } from './item';
import { makeStack } from './item-stack';

const TIME_PHASES = ['day', 'night', 'sunset', 'sunrise'] as const;

export type ChatCommandDeps = {
  player: PlayerController;
  mobManager: MobManager;
  dayNightCycle: DayNightCycle;
  worldSeed: number;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  inventory: Inventory;
  mobSpawning: MobSpawning;
};

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Registers every /command the game itself adds on top of Chat's built-ins. */
export function registerGameChatCommands(chat: Chat, deps: ChatCommandDeps): void {
  const { player, mobManager, dayNightCycle, worldSeed, renderer, scene, camera, inventory, mobSpawning } = deps;

  chat.registerCommand('time', (args) => {
    if (args[0] === 'set' && (TIME_PHASES as readonly string[]).includes(args[1])) {
      dayNightCycle.setPhase(args[1] as TimePhase);
      return `Set the time to ${args[1]}`;
    }
    return 'Usage: /time set day|night|sunset|sunrise';
  });

  chat.registerCommand('seed', () => `World seed: ${worldSeed}`);

  let panoramaInFlight = false;
  chat.registerCommand('panorama', () => {
    if (isTouchDevice()) return 'The /panorama command is not available on Android.';
    if (panoramaInFlight) return 'Already capturing a panorama...';
    panoramaInFlight = true;
    const capturePos = camera.position.clone();
    capturePanorama(renderer, scene, capturePos)
      .then((blob) => {
        downloadPanoramaZip(blob);
        chat.system('Panorama saved.');
      })
      .catch((err) => chat.system(`Panorama capture failed: ${(err as Error).message}`))
      .finally(() => { panoramaInFlight = false; });
    return 'Capturing 360° panorama...';
  });

  chat.registerCommand('fly', () => {
    const enabled = !player.flyEnabled;
    player.setFlyEnabled(enabled);
    return enabled
      ? 'Flight enabled. Double-tap jump to fly, hold jump to ascend, sneak to descend.'
      : 'Flight disabled.';
  });

  chat.registerCommand('summon', (args) => {
    const kind = (args[0] ?? '').toLowerCase() as MobKind;
    const spec = MOB_SPECS[kind];
    if (!spec) return 'Usage: /summon <pig|cow|sheep|zombie>';

    // A few blocks in front of the player, facing back toward them; forward
    // direction matches PlayerController's own yaw convention. state.position
    // is eye height, so drop back down to ground level for the mob's origin.
    const dir = new THREE.Vector3(-Math.sin(player.state.yaw), 0, -Math.cos(player.state.yaw));
    const pos = player.state.position.clone().addScaledVector(dir, 3);
    pos.y -= 1.62;
    mobManager.spawn(kind, spec, pos, player.state.yaw + Math.PI);
    return `Summoned a ${kind}.`;
  });

  chat.registerCommand('mobstatus', () => {
    const [animals, surface, cave, summary] = mobSpawning.debugStatus();
    chat.system(animals);
    chat.system(surface);
    chat.system(cave);
    return summary;
  });

  chat.registerCommand('give', (args) => {
    if (args.length === 0) return 'Usage: /give <item|block> [count]';

    // Trailing pure-number argument is the count; the rest is the item name.
    let count = 1;
    let nameParts = args;
    const last = args[args.length - 1];
    if (args.length > 1 && /^\d+$/.test(last)) {
      count = Math.max(1, Math.min(6400, parseInt(last, 10)));
      nameParts = args.slice(0, -1);
    }
    const query = slugify(nameParts.join(' ').replace(/^minecraft:/, ''));

    let id: number | null = null;
    let label = '';
    for (const b of BLOCK_CATALOG) {
      if (slugify(b.name) === query || String(b.id) === query) { id = b.id; label = b.name; break; }
    }
    if (id == null) {
      for (const [key, def] of Object.entries(ITEMS)) {
        if (slugify(def.name) === query || key === query) { id = Number(key); label = def.name; break; }
      }
    }
    if (id == null) return `Unknown item: ${nameParts.join(' ')}`;

    const per = maxStackOf(id);
    let remaining = count;
    while (remaining > 0) {
      const take = Math.min(remaining, per);
      const leftover = inventory.addItem(makeStack(id, take));
      remaining -= take - leftover;
      if (leftover > 0) break;
    }
    const gave = count - remaining;
    return gave > 0 ? `Gave ${gave} × ${label}` : 'Inventory full';
  });
}

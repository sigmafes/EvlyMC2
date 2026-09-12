import type { SoundManager } from './sound-manager';
import type { MobKind } from './mob-manager';

export type MobSoundEvent = 'death' | 'hurt' | 'idle' | 'step';

/** `count` omitted -> single un-numbered file (soundManager.playOne); otherwise `<relPath>1..count` (playRandom). */
type SoundSpec = { relPath: string; count?: number };

// Matched directly against what's actually in sounds/mobs/: Cow_death1-2,
// Cow_hurt1-3, Cow_idle1-3, Cow_step1-3; Pig_death (single file, no numeric
// suffix), Pig_hurt1-2, Pig_idle1-3, Pig_step1-3; Sheep1-3 (shared across
// death/hurt/idle - there's no separate set per event for sheep) + Sheep_step1-3.
const MOB_SOUNDS: Record<MobKind, Record<MobSoundEvent, SoundSpec>> = {
  cow: {
    death: { relPath: 'mobs/Cow_death', count: 2 },
    hurt: { relPath: 'mobs/Cow_hurt', count: 3 },
    idle: { relPath: 'mobs/Cow_idle', count: 3 },
    step: { relPath: 'mobs/Cow_step', count: 3 },
  },
  pig: {
    death: { relPath: 'mobs/Pig_death' },
    hurt: { relPath: 'mobs/Pig_hurt', count: 2 },
    idle: { relPath: 'mobs/Pig_idle', count: 3 },
    step: { relPath: 'mobs/Pig_step', count: 3 },
  },
  sheep: {
    death: { relPath: 'mobs/Sheep', count: 3 },
    hurt: { relPath: 'mobs/Sheep', count: 3 },
    idle: { relPath: 'mobs/Sheep', count: 3 },
    step: { relPath: 'mobs/Sheep_step', count: 3 },
  },
  zombie: {
    death: { relPath: 'mobs/Zombie_death' },
    hurt: { relPath: 'mobs/Zombie_hurt', count: 2 },
    idle: { relPath: 'mobs/Zombie_idle', count: 3 },
    step: { relPath: 'mobs/Zombie_step', count: 3 },
  },
  skeleton: {
    death: { relPath: 'mobs/Skeleton_death' },
    hurt: { relPath: 'mobs/Skeleton_hurt', count: 3 },
    idle: { relPath: 'mobs/Skeleton_idle', count: 3 },
    step: { relPath: 'mobs/Skeleton_step', count: 3 },
  },
};

export function playMobSound(soundManager: SoundManager, kind: MobKind, event: MobSoundEvent, volume = 1): void {
  const spec = MOB_SOUNDS[kind][event];
  if (spec.count) soundManager.playRandom(spec.relPath, spec.count, volume);
  else soundManager.playOne(spec.relPath, volume);
}

import { BlockId } from './block';
import { ItemId } from './item';
import type { MobKind } from './mob-manager';

export type DropStack = { id: number; count: number };

const ri = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));

/**
 * Drop tables (exact ranges as specified): cow gives 0-2 raw beef + 0-1
 * leather, pig gives 0-2 raw porkchop, sheep gives a flat 1 wool + 1 raw
 * mutton. Rolled independently per item, same "may give nothing" pattern as
 * getDrops() in drops.ts.
 *
 * `wasOnFire`: true if the mob was still on fire (mob.onFire) at the moment
 * it died - meat drops come out already cooked, same as vanilla killing an
 * animal with fire/lava.
 */
export function rollDrops(kind: MobKind, wasOnFire = false): DropStack[] {
  switch (kind) {
    case 'cow': {
      const out: DropStack[] = [];
      const beef = ri(0, 2);
      if (beef > 0) out.push({ id: wasOnFire ? ItemId.COOKED_BEEF : ItemId.RAW_BEEF, count: beef });
      const leather = ri(0, 1);
      if (leather > 0) out.push({ id: ItemId.LEATHER, count: leather });
      return out;
    }
    case 'pig': {
      const out: DropStack[] = [];
      const pork = ri(0, 2);
      if (pork > 0) out.push({ id: wasOnFire ? ItemId.COOKED_PORKCHOP : ItemId.RAW_PORKCHOP, count: pork });
      return out;
    }
    case 'sheep':
      return [{ id: BlockId.WOOL, count: 1 }, { id: wasOnFire ? ItemId.COOKED_MUTTON : ItemId.RAW_MUTTON, count: 1 }];
    case 'zombie': {
      const out: DropStack[] = [];
      const flesh = ri(0, 2);
      if (flesh > 0) out.push({ id: ItemId.ROTTEN_FLESH, count: flesh });
      if (Math.random() < 0.005) {
        const rare = [ItemId.FLINT, ItemId.FEATHER, ItemId.POTATO, ItemId.CARROT, ItemId.IRON_INGOT];
        out.push({ id: rare[Math.floor(Math.random() * rare.length)], count: 1 });
      }
      return out;
    }
    case 'skeleton': {
      // LCE Skeleton::dropDeathLoot: random(3) of each, independently rolled.
      const out: DropStack[] = [];
      const arrows = ri(0, 2);
      if (arrows > 0) out.push({ id: ItemId.ARROW, count: arrows });
      const bones = ri(0, 2);
      if (bones > 0) out.push({ id: ItemId.BONE, count: bones });
      return out;
    }
    case 'spider': {
      // LCE Spider::dropDeathLoot: 0-2 string, plus a spider eye about a third of the time.
      const out: DropStack[] = [];
      const string = ri(0, 2);
      if (string > 0) out.push({ id: ItemId.STRING, count: string });
      if (Math.random() < 1 / 3) out.push({ id: ItemId.SPIDER_EYE, count: 1 });
      return out;
    }
  }
}

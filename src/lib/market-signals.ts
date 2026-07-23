// Serves homepage market signals from a per-snapshot-generation cache:
// the universe query and 2600x buildMarketSignal only rerun when a new
// scan lands, so filter/sort/page interactions pay one cheap timestamp
// probe instead of recomputing the whole market on every request.
import { buildMarketSignal, type MarketSignal } from "@/lib/analytics";
import type { MarketHistory } from "@/lib/market-data";
import { getLatestSnapshotTime, getMarketUniverse } from "@/lib/repositories";

type SignalFetchers = {
  getLatestSnapshotTime: () => Promise<Date | null>;
  getMarketUniverse: () => Promise<MarketHistory[]>;
};

export function createMarketSignalSource(fetchers: SignalFetchers) {
  let cachedAtMs: number | null = null;
  let cachedSignals: MarketSignal[] = [];

  return {
    async getMarketSignals(): Promise<{ signals: MarketSignal[]; latestSnapshotAt: Date | null }> {
      const latestSnapshotAt = await fetchers.getLatestSnapshotTime();
      if (latestSnapshotAt === null) {
        return { signals: [], latestSnapshotAt: null };
      }
      if (cachedAtMs !== latestSnapshotAt.getTime()) {
        const universe = await fetchers.getMarketUniverse();
        // `now` is frozen per generation; med7's 7-day window drifting by
        // one scan interval (<=15 min) is immaterial next to scan cadence.
        const now = new Date();
        cachedSignals = universe
          .filter((item) => item.snapshots.length > 0)
          .map((item) => buildMarketSignal(item, now));
        cachedAtMs = latestSnapshotAt.getTime();
      }
      return { signals: cachedSignals, latestSnapshotAt };
    }
  };
}

const defaultSource = createMarketSignalSource({ getLatestSnapshotTime, getMarketUniverse });

export const getMarketSignals = defaultSource.getMarketSignals;

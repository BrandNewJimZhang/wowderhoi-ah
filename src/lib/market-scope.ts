// One market per terminal view. Generations, series, positions and trades
// are scoped to a Market row (realm + faction); without this, two
// characters or two realms mix their books into one signal. The scope is
// the market of the newest generation unless AQT_MARKET=realm|faction pins it.
import { prisma } from "@/lib/prisma";

export type MarketScope = {
  id: string;
  realm: string;
  faction: string;
  cash: number;
  // Character whose scan produced the ledger; "" when the import carried none.
  character: string;
  // Server opening time captured by the addon. Phase age is measured from
  // it when set, so a fresh terminal install does not look like a new server.
  // Optional only for test fixtures; the market row always carries it.
  openedAt?: Date | null;
  // Earliest observation ever imported for this market. Persisted so pruning
  // old generations cannot make the market look younger (and its gates
  // looser). openedAt still takes precedence when configured.
  firstScanAt?: Date | null;
  // Free bag slots at the latest scan. Null/absent means the import never
  // reported them, so the shared core keeps its planning fallback.
  bagSlots?: number | null;
  // Committed token for the page inputs. The import transactions advance it
  // in the same commit that writes cash, the ledger and the generation, so
  // the open pages' poll cannot lag a committed change or follow a failed
  // one.
  dataVersion: number;
};

// The pin parser is shared with `npm run calibrate`: a malformed pin must
// fail in both entry points, not silently widen one of them to every market.
export function parseMarketPin(value: string | undefined): { realm: string; faction: string } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`AQT_MARKET must be "realm|faction", got ${JSON.stringify(value)}`);
  }
  return { realm: parts[0], faction: parts[1] };
}

export async function getMarketScope(): Promise<MarketScope | null> {
  const pin = parseMarketPin(process.env.AQT_MARKET);
  if (pin) {
    const market = await prisma.market.findUnique({ where: { realm_faction: pin } });
    if (!market) throw new Error(`AQT_MARKET points at ${pin.realm}|${pin.faction}, but no such market has been imported`);
    return market;
  }
  // Every generation belongs to a market, so the newest one names the scope.
  const latest = await prisma.marketGeneration.findFirst({
    orderBy: { scannedAt: "desc" },
    select: { marketId: true }
  });
  if (latest) {
    const market = await prisma.market.findUnique({ where: { id: latest.marketId } });
    if (market) return market;
  }
  return prisma.market.findFirst({ orderBy: { createdAt: "asc" } });
}

// One market per terminal view. Snapshots, daily summaries, positions and
// trades are scoped to a Market row (realm + faction); without this, two
// characters or two realms mix their books into one signal. The scope is
// the market of the newest snapshot unless AQT_MARKET=realm|faction pins it.
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
  // old snapshot rows cannot make the market look younger (and its gates
  // looser). openedAt still takes precedence when configured.
  firstScanAt?: Date | null;
  // Free bag slots at the latest scan. Null/absent means the import never
  // reported them, so the shared core keeps its planning fallback.
  bagSlots?: number | null;
};

export async function getMarketScope(): Promise<MarketScope | null> {
  const override = process.env.AQT_MARKET;
  if (override) {
    const [realm, faction] = override.split("|");
    if (!realm || !faction) {
      throw new Error(`AQT_MARKET must be "realm|faction", got ${JSON.stringify(override)}`);
    }
    const market = await prisma.market.findUnique({ where: { realm_faction: { realm, faction } } });
    if (!market) throw new Error(`AQT_MARKET points at ${realm}|${faction}, but no such market has been imported`);
    return market;
  }
  // Every snapshot belongs to a market, so the newest one names the scope.
  const latest = await prisma.auctionSnapshot.findFirst({
    orderBy: { timestamp: "desc" },
    select: { marketId: true }
  });
  if (latest) {
    const market = await prisma.market.findUnique({ where: { id: latest.marketId } });
    if (market) return market;
  }
  return prisma.market.findFirst({ orderBy: { createdAt: "asc" } });
}

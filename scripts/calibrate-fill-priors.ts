// Prints suggested fill priors from the addon's own scans. It does not
// write the rule file: read the table, edit src/lib/market-rules.ts's
// fillPrior, then run `npm run gen:lua-rules`.
//
//   npm run calibrate
//   AQT_MARKET="无情|Alliance" npm run calibrate
import { prisma } from "@/lib/prisma";
import { calibrationObservations, formatCalibration, summarizeCalibration } from "@/lib/calibrate";
import { OBSERVATION_VERSION, SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";

async function main() {
  const scope = process.env.AQT_MARKET?.split("|");
  const markets = await prisma.market.findMany({
    where: scope ? { realm: scope[0], faction: scope[1] } : undefined,
    select: { id: true, realm: true, faction: true, openedAt: true, firstScanAt: true }
  });
  if (markets.length === 0) throw new Error("no imported market; run a scan import first");
  for (const market of markets) {
    // Observations come from clean rows only, but breadth and age are
    // properties of the whole market: a hidden-owner or pre-hygiene scan
    // still proves how many kinds were listed and when the market started.
    const [generations, rows, breadthGroups] = await Promise.all([
      prisma.marketGeneration.findMany({
        where: { marketId: market.id },
        select: { id: true, scannedAt: true },
        orderBy: { scannedAt: "asc" }
      }),
      prisma.marketQuote.findMany({
        where: {
          marketId: market.id,
          priced: true,
          observationVersion: { gte: OBSERVATION_VERSION },
          sellersInvisible: false
        },
        select: {
          itemId: true,
          marketType: true,
          quantity: true,
          soldProxyLow: true,
          observationVersion: true,
          priced: true,
          sellersInvisible: true,
          flowObserved: true,
          generation: { select: { scannedAt: true } }
        },
        orderBy: { generation: { scannedAt: "asc" } }
      }),
      prisma.marketQuote.groupBy({
        by: ["generationId"],
        where: { marketId: market.id, priced: true },
        _count: { _all: true }
      })
    ]);
    const scannedAtById = new Map(generations.map((generation) => [generation.id, generation.scannedAt]));
    const breadthByScan = new Map(
      breadthGroups
        .map((entry) => [scannedAtById.get(entry.generationId)?.getTime(), entry._count._all] as const)
        .filter((entry): entry is [number, number] => entry[0] !== undefined)
    );
    // The market's persisted first observation, not the oldest retained
    // generation: pruning one day of scans must not make a mature market
    // look young and label its observations with the wrong phase.
    const firstScanAt = market.firstScanAt ?? generations[0]?.scannedAt ?? null;
    const observations = calibrationObservations(
      rows.map((row) => ({
        itemId: row.itemId,
        timestamp: row.generation.scannedAt,
        marketType: row.marketType,
        quantity: row.quantity,
        soldProxyLow: row.soldProxyLow,
        observationVersion: row.observationVersion,
        priced: row.priced,
        sellersInvisible: row.sellersInvisible,
        flowObserved: row.flowObserved,
        supply: row.quantity,
        soldLow: row.soldProxyLow
      })),
      {
        scanMinutes: SCAN_INTERVAL_MINUTES,
        marketOpenedAt: market.openedAt,
        breadthByScan,
        marketFirstScanAt: firstScanAt
      }
    );
    console.log(`\n${market.realm}|${market.faction}: ${rows.length} clean rows, ${observations.length} observations`);
    for (const line of formatCalibration(summarizeCalibration(observations))) console.log(line);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

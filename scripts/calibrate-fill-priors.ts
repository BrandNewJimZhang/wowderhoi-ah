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
    select: { id: true, realm: true, faction: true, openedAt: true }
  });
  if (markets.length === 0) throw new Error("no imported market; run a scan import first");
  for (const market of markets) {
    // Observations come from clean rows only, but breadth and age are
    // properties of the whole market: a hidden-owner or pre-hygiene scan
    // still proves how many kinds were listed and when the market started.
    const [rows, breadthByTimestamp, earliest] = await Promise.all([
      prisma.auctionSnapshot.findMany({
        where: {
          marketId: market.id,
          priced: true,
          observationVersion: { gte: OBSERVATION_VERSION },
          sellersInvisible: false
        },
        select: {
          itemId: true,
          timestamp: true,
          marketType: true,
          quantity: true,
          soldProxyLow: true,
          observationVersion: true,
          priced: true,
          sellersInvisible: true
        },
        orderBy: { timestamp: "asc" }
      }),
      prisma.auctionSnapshot.groupBy({
        by: ["timestamp"],
        where: { marketId: market.id, priced: true },
        _count: { _all: true }
      }),
      prisma.auctionSnapshot.aggregate({
        where: { marketId: market.id, priced: true },
        _min: { timestamp: true }
      })
    ]);
    const breadthByScan = new Map(breadthByTimestamp.map((entry) => [entry.timestamp.getTime(), entry._count._all]));
    const observations = calibrationObservations(
      rows.map((row) => ({ ...row, supply: row.quantity, soldLow: row.soldProxyLow })),
      {
        scanMinutes: SCAN_INTERVAL_MINUTES,
        marketOpenedAt: market.openedAt,
        breadthByScan,
        marketFirstScanAt: earliest._min.timestamp
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

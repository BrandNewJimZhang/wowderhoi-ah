// Prints suggested fill priors from the addon's own scans. It does not
// write the rule file: read the table, edit src/lib/market-rules.ts's
// fillPrior, then run `npm run gen:lua-rules`.
//
//   npm run calibrate
//   AQT_MARKET="无情|Alliance" npm run calibrate
import { prisma } from "@/lib/prisma";
import { calibrationObservations, formatCalibration, summarizeCalibration } from "@/lib/calibrate";
import { SCAN_INTERVAL_MINUTES } from "@/lib/market-rules";

async function main() {
  const scope = process.env.AQT_MARKET?.split("|");
  const markets = await prisma.market.findMany({
    where: scope ? { realm: scope[0], faction: scope[1] } : undefined,
    select: { id: true, realm: true, faction: true, openedAt: true }
  });
  if (markets.length === 0) throw new Error("no imported market; run a scan import first");
  for (const market of markets) {
    const rows = await prisma.auctionSnapshot.findMany({
      where: { marketId: market.id, priced: true, observationVersion: { gte: 2 } },
      select: {
        itemId: true,
        timestamp: true,
        marketType: true,
        quantity: true,
        soldProxyLow: true,
        observationVersion: true,
        priced: true
      },
      orderBy: { timestamp: "asc" }
    });
    const breadth = new Set(rows.map((row) => row.itemId)).size;
    const observations = calibrationObservations(
      rows.map((row) => ({ ...row, supply: row.quantity, soldLow: row.soldProxyLow })),
      { scanMinutes: SCAN_INTERVAL_MINUTES, breadth, marketOpenedAt: market.openedAt }
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

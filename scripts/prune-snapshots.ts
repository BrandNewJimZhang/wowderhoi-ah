// Deletes snapshot rows that no read path reaches. Run it after an import
// batch or on a schedule (see docs/launch-runbook.md):  npm run db:prune
import { DEFAULT_SNAPSHOT_KEEP, pruneSnapshots } from "@/lib/retention";
import { prisma } from "@/lib/prisma";

process.loadEnvFile();

const keep = Number(process.env.AQT_RETAIN_SNAPSHOTS ?? DEFAULT_SNAPSHOT_KEEP);
const started = Date.now();

pruneSnapshots(keep)
  .then(async (deleted) => {
    console.log(`Pruned ${deleted} superseded snapshot rows (keeping ${keep} per item) in ${Date.now() - started} ms.`);
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exitCode = 1;
  });

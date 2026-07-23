// Scale sweep: seeds and measures each cell of the {items, depth} matrix
// so the latency curve shows which axis breaks first. 1x/10x cells run
// as gates; 100x cells run in explore mode (report-only, by design they
// may fail or time out — that output IS the cliff map). The 100x/100x
// corner (2.5B rows) is excluded as physically unreachable.
//   npm run perf:sweep
import { execFileSync } from "node:child_process";

const BASE_ITEMS = 2600;
const BASE_DEPTH = 8;

const CELLS: Array<{ itemsX: number; depthX: number; explore: boolean; requests: number }> = [
  { itemsX: 1, depthX: 1, explore: false, requests: 30 },
  { itemsX: 10, depthX: 1, explore: false, requests: 30 },
  { itemsX: 1, depthX: 10, explore: false, requests: 30 },
  { itemsX: 100, depthX: 1, explore: true, requests: 5 },
  { itemsX: 1, depthX: 100, explore: true, requests: 5 }
];

function run(command: string, args: string[]) {
  execFileSync(command, args, { stdio: "inherit", shell: true });
}

console.log("Building production bundle once for all cells...");
run("npm", ["run", "build"]);

for (const cell of CELLS) {
  const label = `sweep-items${cell.itemsX}x-depth${cell.depthX}x`;
  console.log(`\n=== ${label}: ${BASE_ITEMS * cell.itemsX} items x ${BASE_DEPTH * cell.depthX} snapshots ===`);
  run("npm", [
    "run", "perf:seed", "--",
    "--items", String(BASE_ITEMS * cell.itemsX),
    "--depth", String(BASE_DEPTH * cell.depthX)
  ]);
  run("npm", [
    "run", "perf:run", "--",
    "--skip-build",
    "--label", label,
    "--requests", String(cell.requests),
    "--items-x", String(cell.itemsX),
    "--depth-x", String(cell.depthX),
    ...(cell.explore ? ["--explore"] : [])
  ]);
}
console.log("\nSweep complete. Reports in scripts/perf/reports/.");

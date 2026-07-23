// Single authority for perf budgets and their evaluation. The gate run
// (1x/10x scales) fails hard on any breach; explore runs (100x) only
// report, because their purpose is to locate cliffs, not to pass.

export type PerfReport = {
  label: string;
  scale: { itemsX: number; depthX: number };
  homepage: { p50Ms: number; p95Ms: number; bytes: number; failures: number };
  itemPages: { p50Ms: number; p95Ms: number; failures: number };
  importMs: number | null;
  postImportRebuildMs: number | null;
  contentionMaxStallMs: number | null;
};

export const gateBudgets = {
  homepageP95Ms: 1000,
  homepageBytes: 500_000,
  itemPageP95Ms: 300,
  importMs: 5000,
  // First homepage render after a scan lands rebuilds the signal cache;
  // it pays the full universe read once per scan generation.
  postImportRebuildMs: 5000,
  contentionStallMs: 2000
} as const;

export function percentile(samples: number[], rank: number): number {
  if (samples.length === 0) {
    throw new Error("percentile: empty sample set — a stage that measured nothing must not report a number");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1)];
}

export function evaluateGate(report: PerfReport): { pass: boolean; breaches: string[] } {
  const breaches: string[] = [];
  if (report.homepage.failures > 0) breaches.push(`homepage: ${report.homepage.failures} request(s) failed`);
  if (report.itemPages.failures > 0) breaches.push(`item pages: ${report.itemPages.failures} request(s) failed`);
  if (report.homepage.p95Ms > gateBudgets.homepageP95Ms) {
    breaches.push(`homepage p95 ${report.homepage.p95Ms}ms > ${gateBudgets.homepageP95Ms}ms`);
  }
  if (report.homepage.bytes > gateBudgets.homepageBytes) {
    breaches.push(`homepage payload ${report.homepage.bytes}B > ${gateBudgets.homepageBytes}B`);
  }
  if (report.itemPages.p95Ms > gateBudgets.itemPageP95Ms) {
    breaches.push(`item page p95 ${report.itemPages.p95Ms}ms > ${gateBudgets.itemPageP95Ms}ms`);
  }
  if (report.importMs !== null && report.importMs > gateBudgets.importMs) {
    breaches.push(`import ${report.importMs}ms > ${gateBudgets.importMs}ms`);
  }
  if (report.postImportRebuildMs !== null && report.postImportRebuildMs > gateBudgets.postImportRebuildMs) {
    breaches.push(`post-import rebuild ${report.postImportRebuildMs}ms > ${gateBudgets.postImportRebuildMs}ms`);
  }
  if (report.contentionMaxStallMs !== null && report.contentionMaxStallMs > gateBudgets.contentionStallMs) {
    breaches.push(`contention stall ${report.contentionMaxStallMs}ms > ${gateBudgets.contentionStallMs}ms`);
  }
  return { pass: breaches.length === 0, breaches };
}

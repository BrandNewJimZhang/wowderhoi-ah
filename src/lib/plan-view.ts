// A plan revision begins realm|faction|genEpoch:estateRevision:ledgerRevision.
// The epoch is the scan the plan was minted for; a page must not present a
// plan from an older book as the current next step.
export function planEpoch(revision: string): number | null {
  const epoch = Number((revision.split("|")[2] ?? "").split(":")[0]);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

export function planMatchesScan(
  plan: { revision: string } | null | undefined,
  latestScanAt: Date | null | undefined
): boolean {
  if (!plan || !latestScanAt) return false;
  return planEpoch(plan.revision) === Math.round(latestScanAt.getTime() / 1000);
}

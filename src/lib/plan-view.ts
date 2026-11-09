// A plan revision begins realm|faction|genEpoch:estateRevision:ledgerRevision.
// The epoch is the scan the plan was minted for; a page must not present a
// plan from an older book as the current next step.
export function planEpoch(revision: string): number | null {
  const epoch = Number((revision.split("|")[2] ?? "").split(":")[0]);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

// The plan identity also carries the estate revision it was sized from. A
// plan minted before the bag or purse moved describes a state the player no
// longer has; the page must fall back rather than present it as current.
export function planMatchesScan(
  plan: { revision: string; estateRevision?: number } | null | undefined,
  latestScanAt: Date | null | undefined,
  estateRevision?: number
): boolean {
  if (!plan || !latestScanAt) return false;
  if (planEpoch(plan.revision) !== Math.round(latestScanAt.getTime() / 1000)) return false;
  if (estateRevision === undefined || plan.estateRevision === undefined) return true;
  return plan.estateRevision === estateRevision;
}

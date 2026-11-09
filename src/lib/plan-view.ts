import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

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
  plan: { revision: string; estateRevision?: number; configRevision?: string } | null | undefined,
  latestScanAt: Date | null | undefined,
  estateRevision?: number,
  configRevision: string = String(SCAN_PIPELINE_VERSION)
): boolean {
  if (!plan || !latestScanAt) return false;
  if (planEpoch(plan.revision) !== Math.round(latestScanAt.getTime() / 1000)) return false;
  // A plan was sized under the rules compiled into the addon that minted
  // it. Presenting one from another pipeline as current would apply a new
  // rule set's intent to an old computation. An empty value is a plan
  // stored before the contract carried the stamp, so it cannot be trusted.
  if (plan.configRevision !== undefined && plan.configRevision !== configRevision) return false;
  if (estateRevision === undefined || plan.estateRevision === undefined) return true;
  return plan.estateRevision === estateRevision;
}

import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

// A plan revision begins
// realm|faction|genEpoch:estateRevision:ledgerRevision:phase:character.
// The epoch is the scan the plan was minted for; a page must not present a
// plan from an older book as the current next step.
export function planEpoch(revision: string): number | null {
  const epoch = Number((revision.split("|")[2] ?? "").split(":")[0]);
  return Number.isFinite(epoch) && epoch > 0 ? epoch : null;
}

// The estate revision a plan must be compared against belongs to the
// character that minted it, not to whoever scanned last. A plan written
// before the character stamp falls back to the caller's scope revision.
// A named character with no estate row cannot be verified, so the plan is
// not current (revisions are non-negative; -1 can never match).
export function planEstateRevision(
  plan: { character?: string } | null | undefined,
  estates: ReadonlyArray<{ scope: string; revision: number }>,
  fallback?: number
): number | undefined {
  if (!plan || !plan.character) return fallback;
  const estate = estates.find((row) => row.scope === `character:${plan.character}`);
  return estate ? estate.revision : -1;
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

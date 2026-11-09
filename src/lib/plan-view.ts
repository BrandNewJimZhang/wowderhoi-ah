import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

// A plan revision begins
// realm|faction|genEpoch:estateRevision:ledgerRevision:phase:character.
// The epoch is the scan the plan was minted for; a page must not present a
// plan from an older book as the current next step.
export function planEpoch(revision: string): number | null {
  const epoch = planStateOf(revision)?.epoch ?? null;
  return epoch !== null && epoch > 0 ? epoch : null;
}

// The state a plan was sized from. Two plans minted in one second cannot be
// ordered by their clock, but they can by the scan, estate and ledger they
// name: the one that saw less cannot have superseded the other. Parsing
// tolerates the older forms without phase and character.
function planStateOf(revision: string): { epoch: number; estate: number; ledger: number } | null {
  const parts = (revision.split("|")[2] ?? "").split(":");
  if (parts.length < 3) return null;
  const [epoch, estate, ledger] = parts.slice(0, 3).map(Number);
  if (![epoch, estate, ledger].every((value) => Number.isFinite(value))) return null;
  return { epoch, estate, ledger };
}

// Positive when `left` was sized from later state than `right`, zero when
// the two name the same state or either is unparseable.
export function comparePlanState(left: string, right: string): number {
  const a = planStateOf(left);
  const b = planStateOf(right);
  if (!a || !b) return 0;
  for (const key of ["epoch", "estate", "ledger"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return 0;
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

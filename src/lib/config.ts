// Runtime configuration read from the environment. Market rules
// (market-rules.ts) are pure constants compiled into the addon; anything
// that depends on how the terminal is deployed belongs here, with exactly
// one reader per variable so the cockpit, the shared core and the
// production network cannot resolve different values.
import { DEFAULT_BUDGET_COPPER, marketPhases, type MarketPhase } from "@/lib/market-rules";

// Planning budget for the shared decision core, position sizing and the
// production LP. Separate from the cash reported by the last scan: the
// addon derives its budget from GetMoney() at decision time, while the
// terminal evaluates a hypothetical budget the user configures. The core
// and the cockpit still bound the spend by the scanned cash, so this is an
// upper cap, never a purse.
export function resolveBudgetCopper(): number {
  const value = Number(process.env.AQT_BUDGET_COPPER);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BUDGET_COPPER;
}

// What a plan may actually spend: the configured cap, bounded by the purse
// the last scan reported. The cockpit's "deployable" figure, the production
// LP and the recipes page must quote one number, or they describe different
// plans from the same scan. `null` means the balance was never reported; a
// reported 0 is an empty purse and funds nothing.
export function resolveDeployableCopper(cashCopper: number | null): number {
  const planned = resolveBudgetCopper();
  return cashCopper === null ? planned : Math.min(planned, cashCopper);
}

// Manual phase lock. An unknown value is ignored rather than silently
// evaluating the market under a phase the user did not choose.
export function resolvePhaseOverride(): MarketPhase | null {
  const value = process.env.AQT_PHASE;
  return value && (marketPhases as readonly string[]).includes(value) ? (value as MarketPhase) : null;
}

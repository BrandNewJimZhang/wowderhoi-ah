// Account-level view of the character-scoped holdings read model. A market
// can hold several characters' rows for the same item; keying by item
// without summing silently kept only the last row.
import type { StoredHolding } from "@/lib/repositories";

export type HoldingsSummary = {
  // Known units per item, summed across characters.
  positions: Record<number, { qty: number; cost: number }>;
  unknownUnits: number;
  missingUnits: number;
  byLocation: { carried: number; keyring: number; bank: number; mail: number; listed: number };
};

// One aggregation for every page that values the account's stock.
export function summarizeHoldings(holdings: readonly StoredHolding[]): HoldingsSummary {
  const positions: HoldingsSummary["positions"] = {};
  const byLocation: HoldingsSummary["byLocation"] = {
    carried: 0, keyring: 0, bank: 0, mail: 0, listed: 0
  };
  let unknownUnits = 0;
  let missingUnits = 0;
  for (const holding of holdings) {
    unknownUnits += holding.unknownQty;
    missingUnits += holding.missingQty;
    byLocation.carried += holding.carriedQty;
    byLocation.keyring += holding.keyringQty;
    byLocation.bank += holding.bankQty + holding.accountBankQty;
    byLocation.mail += holding.mailQty;
    byLocation.listed += holding.listedQty;
    if (holding.knownQty <= 0) continue;
    const position = positions[holding.itemId] ?? { qty: 0, cost: 0 };
    position.qty += holding.knownQty;
    position.cost += holding.costBasis;
    positions[holding.itemId] = position;
  }
  return { positions, unknownUnits, missingUnits, byLocation };
}

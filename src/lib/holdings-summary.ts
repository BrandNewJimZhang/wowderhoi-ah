// Account-level view of the character-scoped holdings read model. A market
// can hold several characters' rows for the same item; keying by item
// without summing silently kept only the last row.
import type { StoredHolding } from "@/lib/repositories";

type HoldingPosition = {
  // Every owned unit, including stock the ledger could not price. A table
  // that showed only priced units claimed the character held less than the
  // bag and bank actually contain.
  qty: number;
  // Proved cost of the units that have one. Meaningless as a unit cost when
  // `costKnown` is false, which is why the valuation refuses to derive one.
  cost: number;
  // False when any owned unit's basis is unproved: unbooked stock or lots
  // bought at an estimated price. Those units stay in the market value but
  // out of the profit calculation.
  costKnown: boolean;
  unknownQty: number;
};

type HoldingsSummary = {
  // One entry per owned item, summed across characters.
  positions: Record<number, HoldingPosition>;
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
    // A booked unit whose lots include an estimated or missing cost is just
    // as unknown as an unbooked one.
    const unprovedUnits = holding.unknownQty + (holding.costKnown ? 0 : holding.knownQty);
    unknownUnits += unprovedUnits;
    missingUnits += holding.missingQty;
    byLocation.carried += holding.carriedQty;
    byLocation.keyring += holding.keyringQty;
    byLocation.bank += holding.bankQty + holding.accountBankQty;
    byLocation.mail += holding.mailQty;
    byLocation.listed += holding.listedQty;
    if (holding.qty <= 0) continue;
    const position = positions[holding.itemId] ?? { qty: 0, cost: 0, costKnown: true, unknownQty: 0 };
    position.qty += holding.qty;
    position.cost += holding.costBasis;
    position.costKnown = position.costKnown && holding.costKnown && holding.unknownQty === 0;
    position.unknownQty += unprovedUnits;
    positions[holding.itemId] = position;
  }
  return { positions, unknownUnits, missingUnits, byLocation };
}

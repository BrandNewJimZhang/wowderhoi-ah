import { placeholderItemName } from "@/lib/item-name";

// Portfolio valuation. A position whose item has no current sell front is
// unpriced, not worthless: folding it in at zero would invent a total loss
// the market never printed. Unpriced rows stay visible in the table but are
// excluded from the value and cost totals, which are labelled as covering
// quoted positions only.
//
// Stock whose cost was never proved still has a market value -- the player
// owns it and could sell it -- but a profit needs a basis. Its units count
// towards the market value and the row is marked `costKnown: false`; the
// unit cost and unrealized columns stay empty, and the totals keep its cost
// out of the profit figure.
type PositionInput = { qty: number; cost: number; costKnown?: boolean };

type PositionRow = {
  itemId: number;
  name: string;
  qty: number;
  cost: number;
  unitCost: number | null; // null when any owned unit's basis is unproved
  costKnown: boolean;
  price: number; // sell front, copper; 0 when the item has no current listing
  priced: boolean;
  value: number; // 0 when unpriced; never enters the totals
  unrealized: number | null; // null when unpriced or the basis is unproved
};

type PositionValuation = {
  rows: PositionRow[];
  pricedValue: number;
  pricedCost: number;
  unrealized: number;
  unpricedCount: number;
  // Priced rows whose basis is unproved. Their value is counted but their
  // profit is not, so the page can say why the two totals disagree.
  unknownCostCount: number;
};

export function valuePositions(
  positions: Record<number, PositionInput>,
  priceById: Map<number, number>,
  nameById: Map<number, string>
): PositionValuation {
  const rows = Object.entries(positions)
    .map(([key, position]) => {
      const itemId = Number(key);
      const price = priceById.get(itemId) ?? 0;
      const priced = price > 0;
      const costKnown = position.costKnown !== false;
      const value = priced ? price * position.qty : 0;
      return {
        itemId,
        name: nameById.get(itemId) ?? placeholderItemName(itemId),
        qty: position.qty,
        cost: position.cost,
        unitCost: costKnown && position.qty > 0 ? position.cost / position.qty : null,
        costKnown,
        price,
        priced,
        value,
        unrealized: priced && costKnown ? value - position.cost : null
      };
    })
    // Priced positions by value; unpriced ones last by committed cost, then
    // id so two equal rows never swap places between renders.
    .sort((left, right) =>
      right.value - left.value || right.cost - left.cost || left.itemId - right.itemId);
  const pricedRows = rows.filter((row) => row.priced);
  const pricedValue = pricedRows.reduce((sum, row) => sum + row.value, 0);
  const pricedCost = pricedRows.reduce((sum, row) => sum + row.cost, 0);
  const unrealized = pricedRows.reduce((sum, row) => sum + (row.unrealized ?? 0), 0);
  return {
    rows,
    pricedValue,
    pricedCost,
    unrealized,
    unpricedCount: rows.length - pricedRows.length,
    unknownCostCount: pricedRows.filter((row) => !row.costKnown).length
  };
}

// Portfolio valuation. A position whose item has no current sell front is
// unpriced, not worthless: folding it in at zero would invent a total loss
// the market never printed. Unpriced rows stay visible in the table but are
// excluded from the value, cost and unrealized totals, which are labelled
// as covering quoted positions only.
export type PositionInput = { qty: number; cost: number };

export type PositionRow = {
  itemId: number;
  name: string;
  qty: number;
  cost: number;
  unitCost: number;
  price: number; // sell front, copper; 0 when the item has no current listing
  priced: boolean;
  value: number; // 0 when unpriced; never enters the totals
  unrealized: number | null; // null when unpriced
};

export type PositionValuation = {
  rows: PositionRow[];
  pricedValue: number;
  pricedCost: number;
  unrealized: number;
  unpricedCount: number;
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
      return {
        itemId,
        name: nameById.get(itemId) ?? `#${itemId}`,
        qty: position.qty,
        cost: position.cost,
        unitCost: position.qty > 0 ? position.cost / position.qty : 0,
        price,
        priced,
        value: priced ? price * position.qty : 0,
        unrealized: priced ? price * position.qty - position.cost : null
      };
    })
    // Priced positions by value, unpriced last by committed cost.
    .sort((left, right) => right.value - left.value || right.cost - left.cost);
  const pricedRows = rows.filter((row) => row.priced);
  const pricedValue = pricedRows.reduce((sum, row) => sum + row.value, 0);
  const pricedCost = pricedRows.reduce((sum, row) => sum + row.cost, 0);
  return {
    rows,
    pricedValue,
    pricedCost,
    unrealized: pricedValue - pricedCost,
    unpricedCount: rows.length - pricedRows.length
  };
}

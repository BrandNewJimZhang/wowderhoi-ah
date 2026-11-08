// One revision token for the ledger, computed from the same facts whether
// they came from the database or from a journal replay. A generation stores
// it so a reader can tell whether the ledger moved after the scan.
type RevisionTrade = { realizedAt: Date; pnl: number; fee: number };
type RevisionPosition = { qty: number; cost: number };

export function ledgerRevisionOf(trades: readonly RevisionTrade[], positions: readonly RevisionPosition[]): string {
  const lastRealized = trades.reduce((latest, trade) => Math.max(latest, trade.realizedAt.getTime()), 0);
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const fee = trades.reduce((sum, trade) => sum + trade.fee, 0);
  const qty = positions.reduce((sum, position) => sum + position.qty, 0);
  const cost = positions.reduce((sum, position) => sum + position.cost, 0);
  return [trades.length, lastRealized, pnl, fee, positions.length, qty, cost].join(":");
}

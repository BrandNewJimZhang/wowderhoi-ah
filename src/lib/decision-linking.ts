// A sale is attributed to a recommendation only when the player adopted it
// in game. The adopt event carries the decision id; the next matching sale
// of the same item inside the attribution window inherits it. Everything
// else stays a window match in the calibration, labelled as such.
import { startsWithinWindow, type TradeTimeBounds } from "@/lib/trade-interval";

type AdoptedDecision = {
  decisionId: string;
  itemId: number | null;
  kind: string;
  adoptedAt: Date | null;
};

type LinkableTrade = TradeTimeBounds & {
  itemId: number;
  decisionId?: string | null;
};

// A sale inside the attribution window may belong to a sell recommendation
// the player adopted; a buy recommendation is an acquisition, not a sale.
// The window is wider than the fill horizon because the goods must first
// be bought and listed. Off-policy evaluation attributes P&L over the same
// window.
export const ATTRIBUTION_WINDOW_DAYS = 7;

export function linkTrades<T extends LinkableTrade>(
  trades: T[],
  decisions: readonly AdoptedDecision[]
): T[] {
  const windowMs = ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const adopted = decisions
    .filter((decision): decision is AdoptedDecision & { itemId: number; adoptedAt: Date } =>
      decision.itemId !== null && decision.adoptedAt instanceof Date
    )
    .sort((left, right) => left.adoptedAt.getTime() - right.adoptedAt.getTime());
  return trades.map((trade) => {
    if (trade.decisionId) return trade;
    let match: (AdoptedDecision & { itemId: number; adoptedAt: Date }) | null = null;
    for (const decision of adopted) {
      // A trade is a sale, so only a sell recommendation can own it. A buy
      // recommendation is about acquiring the item; attaching the later
      // sale would claim an outcome the decision did not produce.
      if (decision.kind !== "sell") continue;
      if (decision.itemId !== trade.itemId) continue;
      // The listing must follow the adoption: goods listed before the
      // recommendation were not produced by it, even when the mailbox
      // reports the sale later. The listing is the lower bound of the
      // sale's interval, so the attribution window is measured from it.
      const at = decision.adoptedAt.getTime();
      if (!startsWithinWindow(trade, at, at + windowMs)) continue;
      match = decision;
    }
    return match ? { ...trade, decisionId: match.decisionId } : trade;
  });
}

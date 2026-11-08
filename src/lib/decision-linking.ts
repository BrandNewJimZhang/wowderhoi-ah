// A sale is attributed to a recommendation only when the player adopted it
// in game. The adopt event carries the decision id; the next matching sale
// of the same item inside the attribution window inherits it. Everything
// else stays a window match in the calibration, labelled as such.
export type AdoptedDecision = {
  decisionId: string;
  itemId: number | null;
  kind: string;
  adoptedAt: Date | null;
};

type LinkableTrade = {
  itemId: number;
  realizedAt: Date;
  decisionId?: string | null;
  matchKind?: string | null;
};

// A buy recommendation's goods are sold later; a sell recommendation is
// the sale itself. Both use the same attribution window, which is wider
// than the fill horizon because the goods must first be bought and listed.
const ATTRIBUTION_WINDOW_DAYS = 7;

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
      if (decision.itemId !== trade.itemId) continue;
      const at = decision.adoptedAt.getTime();
      if (at > trade.realizedAt.getTime()) continue;
      if (trade.realizedAt.getTime() - at > windowMs) continue;
      match = decision;
    }
    return match
      ? { ...trade, decisionId: match.decisionId, matchKind: "identity" }
      : trade;
  });
}

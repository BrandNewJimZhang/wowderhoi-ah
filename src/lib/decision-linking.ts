// A sale is attributed to a recommendation only when the player adopted it
// in game. The adopt event carries the decision id; the next matching sale
// of the same item inside the attribution window inherits it. Everything
// else stays a window match in the calibration, labelled as such.
type AdoptedDecision = {
  decisionId: string;
  itemId: number | null;
  kind: string;
  adoptedAt: Date | null;
};

type LinkableTrade = {
  itemId: number;
  realizedAt: Date;
  decisionId?: string | null;
};

// A stored decision row and the journal-derived adoption row have the same
// shape; only the source differs.
type StoredAdoption = {
  decisionId: string | null;
  itemId: number | null;
  kind: string;
  adoptedAt: Date | null;
};

// A buy recommendation's goods are sold later; a sell recommendation is
// the sale itself. Both use the same attribution window, which is wider
// than the fill horizon because the goods must first be bought and listed.
// Off-policy evaluation attributes P&L over the same window.
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
      const at = decision.adoptedAt.getTime();
      if (at > trade.realizedAt.getTime()) continue;
      if (trade.realizedAt.getTime() - at > windowMs) continue;
      match = decision;
    }
    return match ? { ...trade, decisionId: match.decisionId } : trade;
  });
}

// The stored decision log is the durable record: it keeps an adoption even
// when the scan that produced it has aged out of the generation window. The
// journal's adopt events are fresher evidence for the same decisions, so
// they overwrite the stored time. A decision that was never adopted is not
// an attribution and must not link a sale.
export function mergeAdoptedDecisions(
  stored: readonly StoredAdoption[],
  current: readonly StoredAdoption[],
  adoptions: ReadonlyMap<string, Date>
): AdoptedDecision[] {
  const byId = new Map<string, AdoptedDecision>();
  for (const row of stored) {
    if (!row.decisionId || !(row.adoptedAt instanceof Date)) continue;
    byId.set(row.decisionId, {
      decisionId: row.decisionId,
      itemId: row.itemId,
      kind: row.kind,
      adoptedAt: row.adoptedAt
    });
  }
  for (const row of current) {
    const adoptedAt = row.decisionId ? adoptions.get(row.decisionId) : undefined;
    if (!row.decisionId || !adoptedAt) continue;
    byId.set(row.decisionId, {
      decisionId: row.decisionId,
      itemId: row.itemId,
      kind: row.kind,
      adoptedAt
    });
  }
  // A journal event is the freshest evidence for an id already known from
  // either source; it can correct the stored adoption time.
  for (const [decisionId, adoptedAt] of adoptions) {
    const row = byId.get(decisionId);
    if (row) byId.set(decisionId, { ...row, adoptedAt });
  }
  return Array.from(byId.values());
}

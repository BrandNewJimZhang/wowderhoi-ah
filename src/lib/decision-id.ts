// One identity formula for a recommendation, shared by the terminal and
// the addon's /wahadopt. A plan-bearing decision names its plan revision
// (realm|faction|genEpoch:estateRevision:ledgerRevision:phase:character); the older
// scannedAt-only form remains the formula for rows written before plans.
type DecisionIdentity = {
  // A plan revision already begins with realm|faction, so the identity that
  // names one carries only the revision.
  realm?: string;
  faction?: string;
  scannedAt?: Date | number;
  planRevision?: string;
  itemId: number;
  kind: string;
};

export function decisionIdFor(identity: DecisionIdentity): string {
  if (identity.planRevision) {
    // The plan revision already begins with realm|faction; the in-game
    // /wahadopt appends item and kind to exactly this string.
    return `${identity.planRevision}:${identity.itemId}:${identity.kind}`;
  }
  if (identity.scannedAt === undefined) {
    throw new Error("decisionIdFor needs either a planRevision or a scannedAt");
  }
  if (!identity.realm || !identity.faction) {
    throw new Error("decisionIdFor needs the market when it has no planRevision");
  }
  const epoch = typeof identity.scannedAt === "number"
    ? Math.round(identity.scannedAt)
    : Math.round(identity.scannedAt.getTime() / 1000);
  return `${identity.realm}|${identity.faction}|${epoch}:${identity.itemId}:${identity.kind}`;
}

// One identity formula for a recommendation, shared by the terminal and
// the addon's /wahadopt. A plan-bearing decision names its plan revision
// (realm|faction|genEpoch:estateRevision:ledgerRevision); the older
// scannedAt-only form remains the formula for rows written before plans.
type DecisionIdentity = {
  realm: string;
  faction: string;
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
  const epoch = typeof identity.scannedAt === "number"
    ? Math.round(identity.scannedAt)
    : Math.round(identity.scannedAt.getTime() / 1000);
  return `${identity.realm}|${identity.faction}|${epoch}:${identity.itemId}:${identity.kind}`;
}

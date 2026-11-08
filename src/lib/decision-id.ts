// One identity formula for a recommendation, shared by the terminal and
// the addon's /wahadopt. Epoch seconds, not an ISO string, because the
// addon already has the scan timestamp in that form and Lua cannot format
// an ISO date without a second implementation.
export type DecisionIdentity = {
  realm: string;
  faction: string;
  scannedAt: Date | number;
  itemId: number;
  kind: string;
};

export function decisionIdFor(identity: DecisionIdentity): string {
  const epoch = typeof identity.scannedAt === "number"
    ? Math.round(identity.scannedAt)
    : Math.round(identity.scannedAt.getTime() / 1000);
  return `${identity.realm}|${identity.faction}|${epoch}:${identity.itemId}:${identity.kind}`;
}

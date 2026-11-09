import type { MarketScope } from "@/lib/market-scope";

// The opaque token the open pages poll. It is derived from the same scope
// read the page renders from: the committed data version moves only inside
// the transaction that writes the page inputs, and the market id keeps two
// scopes from sharing the empty revision. Deriving it here — rather than
// reading it separately — makes a revision that disagrees with the rendered
// scope unrepresentable.
export function marketRevision(scope: MarketScope | null): string {
  return scope ? `${scope.id}:${scope.dataVersion}` : "none";
}

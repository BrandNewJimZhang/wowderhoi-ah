// One market per terminal view. Generations, series, positions and trades
// are scoped to a Market row (realm + faction); without this, two
// characters or two realms mix their books into one signal. The scope is
// the market of the newest generation unless AQT_MARKET=realm|faction pins it.
//
// Cash, character and free slots are not Market columns: they belong to the
// character-scoped Estate. The scope derives them from the most recently
// observed character estate (falling back to the newest scan's character),
// so a page still reads one object while the private state keeps one
// authority.
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// The delegates a scope read needs. Both the shared client and a transaction
// client satisfy this, so the page reader and the single-transaction view
// resolve the scope with one implementation instead of two copies.
type ScopeReader = Pick<Prisma.TransactionClient, "market" | "marketGeneration" | "estate">;

// A character read needs no market lookup: holdings attribution asks the same
// question without resolving a scope first.
type CharacterReader = Pick<Prisma.TransactionClient, "marketGeneration" | "estate">;

export type MarketScope = {
  id: string;
  realm: string;
  faction: string;
  // Latest cash for the current character; null when that character has no
  // observed estate yet. The core keeps its planning fallback on null.
  cash: number | null;
  // Character whose estate was observed most recently; falls back to the
  // newest scan's character, and is "" when neither names one.
  character: string;
  // Free bag slots from the same estate; null means unobserved.
  bagSlots?: number | null;
  // Estate revision the scope's cash and slots came from. A plan revision
  // that mentions state must move when this does.
  estateRevision?: number;
  // Server opening time captured by the addon. Phase age is measured from
  // it when set, so a fresh terminal install does not look like a new server.
  openedAt?: Date | null;
  // Earliest observation ever imported for this market. Persisted so pruning
  // old generations cannot make the market look younger (and its gates
  // looser). openedAt still takes precedence when configured.
  firstScanAt?: Date | null;
  // Committed token for the page inputs. The import transactions advance it
  // in the same commit that writes the state, ledger and generation.
  dataVersion: number;
};

// The pin parser is shared with `npm run calibrate`: a malformed pin must
// fail in both entry points, not silently widen one of them to every market.
export function parseMarketPin(value: string | undefined): { realm: string; faction: string } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`AQT_MARKET must be "realm|faction", got ${JSON.stringify(value)}`);
  }
  return { realm: parts[0], faction: parts[1] };
}

// The character whose private state is current: the most recently observed
// estate scope, falling back to the newest scan. Both the page header and
// the holdings attribution use this one rule, so the cash on screen and the
// character carrying account-scoped stock cannot name different characters.
export async function currentCharacterState(
  client: CharacterReader,
  marketId: string
): Promise<{
  character: string;
  estate: { cash: number | null; freeSlots: number | null; revision: number } | null;
}> {
  const [generation, latestEstate] = await Promise.all([
    client.marketGeneration.findFirst({
      where: { marketId },
      orderBy: { scannedAt: "desc" },
      select: { character: true }
    }),
    client.estate.findFirst({
      where: { marketId, scope: { startsWith: "character:" } },
      // Two characters observed in the same second would otherwise make the
      // carrier depend on database order.
      orderBy: [{ observedAt: "desc" }, { scope: "asc" }],
      select: { scope: true, cash: true, freeSlots: true, revision: true }
    })
  ]);
  const character = latestEstate
    ? latestEstate.scope.slice("character:".length)
    : (generation?.character ?? "");
  const estate = latestEstate ?? (character
    ? await client.estate.findUnique({
        where: { marketId_scope: { marketId, scope: `character:${character}` } },
        select: { cash: true, freeSlots: true, revision: true }
      })
    : null);
  return { character, estate };
}

async function scopeOfMarket(
  client: ScopeReader,
  market: {
    id: string; realm: string; faction: string; openedAt: Date | null;
    firstScanAt: Date | null; dataVersion: number;
  }
): Promise<MarketScope> {
  // The header names the character whose state the player is looking at.
  // That is the latest estate observation, not the latest scan: switching
  // characters pushes a new estate while the market observation still
  // belongs to the previous scan, and the purse on screen must follow the
  // character, not the book.
  const { character, estate } = await currentCharacterState(client, market.id);
  return {
    id: market.id,
    realm: market.realm,
    faction: market.faction,
    cash: estate?.cash ?? null,
    character,
    bagSlots: estate?.freeSlots ?? null,
    estateRevision: estate?.revision ?? 0,
    openedAt: market.openedAt,
    firstScanAt: market.firstScanAt,
    dataVersion: market.dataVersion
  };
}

// The one scope-resolution rule. `getMarketView` passes its transaction so
// the scope, generation and holdings in one render come from one snapshot.
export async function resolveMarketScope(client: ScopeReader): Promise<MarketScope | null> {
  const pin = parseMarketPin(process.env.AQT_MARKET);
  if (pin) {
    const market = await client.market.findUnique({ where: { realm_faction: pin } });
    if (!market) throw new Error(`AQT_MARKET points at ${pin.realm}|${pin.faction}, but no such market has been imported`);
    return scopeOfMarket(client, market);
  }
  // Every generation belongs to a market, so the newest one names the scope.
  const latest = await client.marketGeneration.findFirst({
    orderBy: { scannedAt: "desc" },
    select: { marketId: true }
  });
  if (latest) {
    const market = await client.market.findUnique({ where: { id: latest.marketId } });
    if (market) return scopeOfMarket(client, market);
  }
  const market = await client.market.findFirst({ orderBy: { createdAt: "asc" } });
  return market ? scopeOfMarket(client, market) : null;
}

export async function getMarketScope(): Promise<MarketScope | null> {
  return resolveMarketScope(prisma);
}

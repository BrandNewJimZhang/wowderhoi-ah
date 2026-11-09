// Applies the pushed private state, append-only journal facts and the
// game's plan. The scan route owns observations; this module owns
// everything that changes between scans.
//
// Idempotency is structural: an estate revision that does not advance is
// ignored, a journal fact is unique by (market, character, seq), and a plan
// is unique by (market, revision). A re-sent document is a no-op.
import { Prisma } from "@prisma/client";
import {
  adoptionTimes,
  parseJournal,
  replayJournal,
  type JournalCheckpoint,
  type JournalEvent,
  type JournalTrade,
  type ReplayState
} from "@/lib/journal";
import { linkTrades } from "@/lib/decision-linking";
import { decisionIdFor } from "@/lib/decision-id";
import { currentCharacterState } from "@/lib/market-scope";

type EstateItemInput = { qty: number };
type EstateScopeInput = {
  revision?: number;
  cash?: number | null;
  freeSlots?: number | null;
  pendingCash?: number | null;
  coverage?: Record<string, unknown>;
  items?: Record<string, Record<string, EstateItemInput>>;
};
type AddonEstate = {
  v?: number;
  revision?: number;
  observedAt?: number;
  scopes?: Record<string, EstateScopeInput>;
};

// The publisher's document format. A version bump changes what a field
// means, so an older terminal must reject it instead of importing it under
// the wrong interpretation.
const ESTATE_VERSION = 1;

const LOCATIONS = new Set(["carried", "bank", "account_bank", "mail", "listed", "keyring"]);
// The coverage map names the locations the publisher actually looked at.
// An unknown key would be silently downgraded to `unobserved` and hide a
// document the terminal does not understand; the version field exists for
// that change.
const COVERAGE_KEYS = new Set(["carried", "keyring", "bank", "mail", "account_bank", "listed", "money"]);

function numeric(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`State payload: ${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return numeric(value, field);
}

function coverageMap(value: unknown, scope: string): Record<string, string> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`State payload: estate scope ${scope} must carry a coverage map`);
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!COVERAGE_KEYS.has(key)) {
      throw new Error(`State payload: estate scope ${scope} has unknown coverage key ${key}`);
    }
    out[key] = entry === "observed" ? "observed" : "unobserved";
  }
  return out;
}

export async function applyEstate(
  tx: Prisma.TransactionClient,
  marketId: string,
  raw: unknown
): Promise<{ changed: boolean; revision: number }> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("State payload: estate must be an object");
  }
  const estate = raw as AddonEstate;
  if (estate.v !== ESTATE_VERSION) {
    throw new Error(`State payload: unsupported estate version ${JSON.stringify(estate.v)}`);
  }
  if (typeof estate.scopes !== "object" || estate.scopes === null) {
    throw new Error("State payload: estate.scopes must be an object");
  }
  const observedAt = typeof estate.observedAt === "number"
    ? new Date(estate.observedAt * 1000)
    : new Date();
  let changed = false;
  let highestRevision = 0;
  for (const [scope, value] of Object.entries(estate.scopes)) {
    if (scope !== "account" && !scope.startsWith("character:")) {
      throw new Error(`State payload: unknown estate scope ${scope}`);
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`State payload: estate scope ${scope} must be an object`);
    }
    const revision = numeric(value.revision ?? estate.revision ?? 0, `${scope}.revision`);
    highestRevision = Math.max(highestRevision, revision);
    const existing = await tx.estate.findUnique({
      where: { marketId_scope: { marketId, scope } },
      select: { id: true, revision: true, coverage: true }
    });
    const coverage = coverageMap(value.coverage, scope);
    if (existing && existing.revision > revision) continue;
    // A scan seeds the row with cash and free slots but no item detail. At
    // the same revision the pushed document still owns the contents; an
    // already-observed row at the same revision is a re-send and a no-op.
    const existingCoverage = (existing?.coverage ?? null) as Record<string, unknown> | null;
    // The scan never creates an account scope, so an existing account row
    // always came from the publisher; only a character row can be a
    // cash/slot-only scan seed.
    const seeded = !existingCoverage
      ? true
      : scope === "account"
        ? false
        : existingCoverage.carried !== "observed";
    if (existing && existing.revision === revision && !seeded) continue;
    const row = existing
      ? await tx.estate.update({
          where: { id: existing.id },
          data: {
            revision,
            observedAt,
            cash: optionalNumber(value.cash, `${scope}.cash`),
            freeSlots: value.freeSlots === undefined ? null : optionalNumber(value.freeSlots, `${scope}.freeSlots`),
            pendingCash: optionalNumber(value.pendingCash, `${scope}.pendingCash`),
            coverage: coverage as unknown as Prisma.InputJsonValue
          }
        })
      : await tx.estate.create({
          data: {
            marketId,
            scope,
            revision,
            observedAt,
            cash: optionalNumber(value.cash, `${scope}.cash`),
            freeSlots: value.freeSlots === undefined ? null : optionalNumber(value.freeSlots, `${scope}.freeSlots`),
            pendingCash: optionalNumber(value.pendingCash, `${scope}.pendingCash`),
            coverage: coverage as unknown as Prisma.InputJsonValue
          }
        });
    await tx.estateItem.deleteMany({ where: { estateId: row.id } });
    const items: Prisma.EstateItemCreateManyInput[] = [];
    for (const [itemKey, locations] of Object.entries(value.items ?? {})) {
      const itemId = Number(itemKey);
      if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new Error(`State payload: item key ${itemKey} is not a positive item id`);
      }
      for (const [location, entry] of Object.entries(locations)) {
        if (!LOCATIONS.has(location)) {
          throw new Error(`State payload: unknown estate location ${location}`);
        }
        const qty = numeric(entry?.qty, `${scope}.items.${itemId}.${location}.qty`);
        if (qty <= 0) continue;
        items.push({
          estateId: row.id,
          itemId,
          location,
          qty: Math.round(qty)
        });
      }
    }
    if (items.length > 0) await tx.estateItem.createMany({ data: items });
    changed = true;
  }
  return { changed, revision: highestRevision };
}

function locationQty(
  items: Map<number, Map<string, number>>,
  itemId: number,
  location: string
): number {
  return items.get(itemId)?.get(location) ?? 0;
}

function coverageObserved(coverage: Record<string, unknown> | null | undefined, key: string): boolean {
  return coverage?.[key] === "observed";
}

async function loadEstateItems(
  tx: Prisma.TransactionClient,
  marketId: string,
  scope: string
): Promise<{ items: Map<number, Map<string, number>>; coverage: Record<string, unknown> }> {
  const estate = await tx.estate.findUnique({
    where: { marketId_scope: { marketId, scope } },
    include: { items: true }
  });
  const items = new Map<number, Map<string, number>>();
  for (const row of estate?.items ?? []) {
    const byLocation = items.get(row.itemId) ?? new Map<string, number>();
    byLocation.set(row.location, (byLocation.get(row.location) ?? 0) + row.qty);
    items.set(row.itemId, byLocation);
  }
  return {
    items,
    coverage: (estate?.coverage ?? {}) as Record<string, unknown>
  };
}

async function recomputeHoldings(
  tx: Prisma.TransactionClient,
  marketId: string,
  character: string,
  replay: ReplayState,
  // Account bank and own postings are account-scoped. Attributing them to
  // every character's holding made the portfolio sum the same auction once
  // per character; only the character whose scan names the current scope
  // carries them.
  includeAccount: boolean
): Promise<void> {
  const characterScope = `character:${character}`;
  const [characterEstate, accountEstate] = await Promise.all([
    loadEstateItems(tx, marketId, characterScope),
    includeAccount
      ? loadEstateItems(tx, marketId, "account")
      : Promise.resolve({ items: new Map<number, Map<string, number>>(), coverage: {} })
  ]);
  // A scan seeds cash and free slots but not the bag, so an estate row can
  // exist while `carried` is still unobserved. The ledger is then the only
  // evidence of bag stock and must not be treated as absent.
  const carriedObserved = coverageObserved(characterEstate.coverage, "carried");
  const bankObserved = coverageObserved(characterEstate.coverage, "bank");
  const mailObserved = coverageObserved(characterEstate.coverage, "mail");
  const accountBankObserved = includeAccount && coverageObserved(accountEstate.coverage, "account_bank");
  const listedObserved = includeAccount && coverageObserved(accountEstate.coverage, "listed");
  const allObserved = carriedObserved && bankObserved && mailObserved
    && (!includeAccount || (accountBankObserved && listedObserved));

  const itemIds = new Set<number>([
    ...Object.keys(replay.positions).map(Number),
    ...characterEstate.items.keys(),
    ...(includeAccount ? accountEstate.items.keys() : [])
  ]);
  const rows: Prisma.HoldingCreateManyInput[] = [];
  for (const itemId of itemIds) {
    const position = replay.positions[itemId];
    const ledgerQty = position?.qty ?? 0;
    const costBasis = position?.cost ?? 0;
    const carriedQty = locationQty(characterEstate.items, itemId, "carried");
    const bankQty = bankObserved ? locationQty(characterEstate.items, itemId, "bank") : 0;
    const accountBankQty = accountBankObserved ? locationQty(accountEstate.items, itemId, "account_bank") : 0;
    const mailQty = mailObserved ? locationQty(characterEstate.items, itemId, "mail") : 0;
    const listedQty = listedObserved ? locationQty(accountEstate.items, itemId, "listed") : 0;
    const keyringQty = locationQty(characterEstate.items, itemId, "keyring");
    // Without full coverage the ledger and the observed locations are two
    // lower bounds on the same stock: an unopened bank may hold the ledger
    // excess. Only a fully observed character can call the difference
    // `missing`; an unobserved bag is not an empty one.
    const observedQty = carriedQty + bankQty + accountBankQty + mailQty + listedQty + keyringQty;
    const qty = allObserved ? observedQty : Math.max(observedQty, ledgerQty);
    const knownQty = Math.min(ledgerQty, qty);
    // The booked cost belongs only to the units that are actually present;
    // spreading it over a larger ledger quantity would inflate unit cost.
    const knownCost = ledgerQty > 0 ? costBasis * (knownQty / ledgerQty) : 0;
    rows.push({
      marketId,
      character,
      itemId,
      qty,
      // Unobserved bag stock is not sellable: a sale would have to guess
      // that the ledger units are in the bag rather than the bank.
      carriedQty: carriedObserved ? carriedQty : 0,
      keyringQty,
      bankQty,
      accountBankQty,
      mailQty,
      listedQty,
      knownQty,
      unknownQty: Math.max(0, qty - ledgerQty),
      missingQty: allObserved ? Math.max(0, ledgerQty - qty) : 0,
      costKnown: position?.costKnown !== false,
      costBasis: knownCost
    });
  }
  await tx.holding.deleteMany({ where: { marketId, character } });
  if (rows.length > 0) await tx.holding.createMany({ data: rows });
}

function tradeFactId(character: string, trade: JournalTrade, index: number): string {
  // The event sequence is the sale's identity. An auctionID is not unique
  // per trade: a commodity listing fills in pieces, so several sale mails
  // share one posting and must stay separate rows.
  if (trade.seq !== undefined) return `${character}|seq|${trade.seq}`;
  // A checkpoint written before trades carried a sequence can still name the
  // posting, which is stable across checkpoint pruning.
  if (trade.channel === "auction" && trade.auctionID !== undefined) {
    return `${character}|auction|${String(trade.auctionID)}`;
  }
  // The array position shifts when a checkpoint prunes a trade; this last
  // form only covers checkpoints that carry neither identity.
  return `${character}|${trade.channel}|${trade.t}|${trade.itemId ?? 0}|${trade.qty}|${index}`;
}

async function applyTrades(
  tx: Prisma.TransactionClient,
  marketId: string,
  character: string,
  trades: JournalTrade[]
): Promise<number> {
  let created = 0;
  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    if (trade.itemId === null) continue;
    const sourceFactId = tradeFactId(character, trade, index);
    const existing = await tx.trade.findUnique({
      where: { marketId_sourceFactId: { marketId, sourceFactId } },
      select: { id: true }
    });
    const realizedAt = new Date(trade.t * 1000);
    const observedAt = new Date((trade.observedAt ?? trade.t) * 1000);
    const data = {
      character,
      itemId: trade.itemId,
      qty: trade.qty,
      price: trade.price,
      fee: trade.fee,
      pnl: trade.pnl,
      basisKnown: trade.basisKnown,
      channel: trade.channel,
      inferred: trade.inferred,
      listedAt: trade.listedAt === undefined ? null : new Date(trade.listedAt * 1000),
      realizedAt,
      observedAt,
      censored: trade.censored
    };
    await tx.trade.upsert({
      where: { marketId_sourceFactId: { marketId, sourceFactId } },
      create: { marketId, sourceFactId, ...data },
      update: data
    });
    if (!existing) created += 1;
  }
  return created;
}

// Adoption events are annotations. They set the decision's adoptedAt and
// then attribute later trades through the same window the review uses.
async function applyAdoptions(
  tx: Prisma.TransactionClient,
  marketId: string,
  character: string,
  events: JournalEvent[]
): Promise<void> {
  const adoptions = adoptionTimes(events);
  for (const [decisionId, at] of adoptions) {
    await tx.decision.updateMany({
      where: { decisionId, adoptedAt: null },
      data: { adoptedAt: at }
    });
  }
  const adopted = await tx.decision.findMany({
    where: { marketId, adoptedAt: { not: null } },
    select: { decisionId: true, itemId: true, kind: true, adoptedAt: true }
  });
  const unlinked = await tx.trade.findMany({
    where: { marketId, character, decisionId: null },
    select: { id: true, itemId: true, realizedAt: true, listedAt: true, observedAt: true }
  });
  const linked = linkTrades(
    unlinked.map((trade) => ({ ...trade, decisionId: null as string | null })),
    adopted.filter((row): row is typeof row & { decisionId: string } => row.decisionId !== null)
  );
  for (const trade of linked) {
    if (trade.decisionId) {
      await tx.trade.update({ where: { id: trade.id }, data: { decisionId: trade.decisionId } });
    }
  }
}

async function replayForCharacter(
  tx: Prisma.TransactionClient,
  marketId: string,
  character: string
): Promise<ReplayState> {
  const checkpointRow = await tx.ledgerCheckpoint.findFirst({
    where: { marketId, character },
    orderBy: { throughSeq: "desc" }
  });
  const raw = (checkpointRow?.state ?? null) as Record<string, unknown> | null;
  const stored = raw
    ? ((raw.state && typeof raw.state === "object" ? raw.state : raw) as unknown as JournalCheckpoint)
    : null;
  // A checkpoint stored before basis provenance existed has no label on
  // its lots or trades; that history was booked by construction.
  const checkpoint = stored
    ? {
        ...stored,
        lots: Object.fromEntries(
          Object.entries(stored.lots).map(([itemId, list]) => [
            itemId,
            list.map((lot) => ({ ...lot, known: lot.known !== false }))
          ])
        ),
        trades: stored.trades.map((trade) => ({ ...trade, basisKnown: trade.basisKnown !== false }))
      }
    : null;
  const facts = await tx.journalFact.findMany({
    where: {
      marketId,
      character,
      ...(checkpoint ? { seq: { gt: checkpoint.throughSeq } } : {})
    },
    orderBy: { seq: "asc" },
    select: { payload: true }
  });
  const events = facts.map((fact) => fact.payload as unknown as JournalEvent);
  return replayJournal(events, checkpoint);
}

async function charactersWithState(
  tx: Prisma.TransactionClient,
  marketId: string
): Promise<string[]> {
  const [facts, holdings, estates] = await Promise.all([
    tx.journalFact.findMany({
      where: { marketId },
      distinct: ["character"],
      select: { character: true }
    }),
    tx.holding.findMany({
      where: { marketId },
      distinct: ["character"],
      select: { character: true }
    }),
    tx.estate.findMany({
      where: { marketId, scope: { startsWith: "character:" } },
      select: { scope: true }
    })
  ]);
  const names = new Set<string>();
  for (const row of facts) if (row.character) names.add(row.character);
  for (const row of holdings) if (row.character) names.add(row.character);
  for (const row of estates) {
    const name = row.scope.slice("character:".length);
    if (name) names.add(name);
  }
  return Array.from(names);
}

// Rebuild every character's holdings from the persisted facts, checkpoints
// and estate. Account bank and own postings are account-scoped: only the
// character whose private state is current carries them. Recomputing just
// the active character left the previous one holding a stale copy, so the
// portfolio summed the same posting twice after a character switch.
//
// A scan passes the character it is importing: the new generation is not
// written yet, so the account-scoped rows must move before the plan reads
// the sellable stock. Every other caller follows the same rule as the page
// header: the most recently observed estate, then the newest scan.
export async function refreshHoldings(
  tx: Prisma.TransactionClient,
  marketId: string,
  importingCharacter?: string
): Promise<void> {
  const activeCharacter = importingCharacter ?? (await currentCharacterState(tx, marketId)).character;
  for (const character of await charactersWithState(tx, marketId)) {
    const replay = await replayForCharacter(tx, marketId, character);
    await recomputeHoldings(tx, marketId, character, replay, character === activeCharacter);
  }
}

type JournalApplyResult = {
  events: number;
  trades: number;
  errors: number;
  characters: string[];
  changed: boolean;
};

export async function applyJournal(
  tx: Prisma.TransactionClient,
  marketId: string,
  raw: unknown
): Promise<JournalApplyResult> {
  const books = parseJournal(raw);
  let events = 0;
  let trades = 0;
  let errors = 0;
  let newFacts = 0;
  let newCheckpoints = 0;
  const characters: string[] = [];
  for (const book of books) {
    const character = book.key.split("|").pop() ?? "";
    if (!character) continue;
    characters.push(character);
    // An empty or older book must not rebuild holdings from less history
    // than the terminal already has. Out-of-order delivery still inserts
    // any facts it carries; it just does not drive the projection.
    const existingFact = await tx.journalFact.aggregate({
      where: { marketId, character },
      _max: { seq: true }
    });
    const existingSeq = existingFact._max.seq ?? 0;
    const incomingSeq = book.events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
    const incomingSeqCeiling = Math.max(incomingSeq, book.nextSeq - 1);
    const stale = existingSeq > 0 && incomingSeqCeiling < existingSeq;
    if (book.events.length > 0) {
      // SQLite has no createMany skipDuplicates; filter the sequence
      // numbers already present. That is the same identity the unique key
      // enforces, just decided before the write.
      const sequences = book.events.map((event) => event.seq as number);
      const known = await tx.journalFact.findMany({
        where: { marketId, character, seq: { in: sequences } },
        select: { seq: true }
      });
      const seen = new Set(known.map((row) => row.seq));
      const data: Prisma.JournalFactCreateManyInput[] = book.events
        .filter((event) => !seen.has(event.seq as number))
        .map((event) => ({
          marketId,
          character,
          seq: event.seq as number,
          kind: event.k,
          eventTime: event.eventTime === undefined ? null : new Date(event.eventTime * 1000),
          observedAt: new Date((event.observedAt ?? event.t) * 1000),
          censored: event.censored === true,
          payload: event as unknown as Prisma.InputJsonValue
        }));
      if (data.length > 0) await tx.journalFact.createMany({ data });
      events += data.length;
      newFacts += data.length;
    }
    if (stale) {
      // Adoptions are annotations, not projection state; a late delivery
      // still carries a player fact the review must see.
      await applyAdoptions(tx, marketId, character, book.events);
      continue;
    }
    if (book.checkpoint) {
      const checkpointExisting = await tx.ledgerCheckpoint.findUnique({
        where: {
          marketId_character_throughSeq: {
            marketId,
            character,
            throughSeq: book.checkpoint.throughSeq
          }
        },
        select: { marketId: true }
      });
      if (!checkpointExisting) newCheckpoints += 1;
      await tx.ledgerCheckpoint.upsert({
        where: {
          marketId_character_throughSeq: {
            marketId,
            character,
            throughSeq: book.checkpoint.throughSeq
          }
        },
        create: {
          marketId,
          character,
          throughSeq: book.checkpoint.throughSeq,
          state: book.checkpoint as unknown as Prisma.InputJsonValue
        },
        update: {}
      });
      // `parseCheckpoint` already returns the flat journal shape; the
      // replay wants exactly that, not the SavedVariables envelope.
      const replay = replayJournal(book.events, book.checkpoint);
      const created = await applyTrades(tx, marketId, character, replay.trades);
      trades += created;
      await applyAdoptions(tx, marketId, character, book.events);
      errors += replay.errors.length;
    } else {
      const replay = replayJournal(book.events);
      const created = await applyTrades(tx, marketId, character, replay.trades);
      trades += created;
      await applyAdoptions(tx, marketId, character, book.events);
      errors += replay.errors.length;
    }
  }
  // One rebuild for every character: the active scope may have moved, and
  // an account-scoped posting belongs to exactly one holding row.
  await refreshHoldings(tx, marketId);
  return {
    events,
    trades,
    errors,
    characters,
    changed: newFacts > 0 || newCheckpoints > 0 || trades > 0
  };
}

type PlanStep = {
  kind?: string;
  itemId?: number;
  name?: string;
  qty?: number;
  price?: number;
  unitPrice?: number;
  allocQty?: number;
  allocUnitPrice?: number;
  expectedNet?: number;
  fillProb?: number;
  fillBasis?: string;
  reason?: string;
};

type AddonPlan = {
  revision?: string;
  character?: string;
  estateRevision?: number;
  configRevision?: string;
  observedAt?: number;
  steps?: PlanStep[];
  resources?: unknown;
  unplanned?: unknown;
};

export async function applyPlan(
  tx: Prisma.TransactionClient,
  marketId: string,
  raw: unknown,
  phase: string
): Promise<{ created: boolean; revision: string | null }> {
  if (typeof raw !== "object" || raw === null) return { created: false, revision: null };
  const plan = raw as AddonPlan;
  if (typeof plan.revision !== "string" || plan.revision === "") {
    return { created: false, revision: null };
  }
  if (plan.character !== undefined && typeof plan.character !== "string") {
    throw new Error(`State payload: plan character must be a string, got ${JSON.stringify(plan.character)}`);
  }
  const existing = await tx.plan.findUnique({
    where: { marketId_revision: { marketId, revision: plan.revision } },
    select: { id: true }
  });
  if (existing) return { created: false, revision: plan.revision };
  const at = typeof plan.observedAt === "number" ? new Date(plan.observedAt * 1000) : new Date();
  // A delayed old plan must not supersede a newer one. Store it for the
  // history and mark it superseded immediately.
  const newer = await tx.plan.findFirst({
    where: { marketId, createdAt: { gt: at } },
    select: { id: true }
  });
  const row = await tx.plan.create({
    data: {
      marketId,
      revision: plan.revision,
      character: typeof plan.character === "string" ? plan.character : "",
      estateRevision: plan.estateRevision ?? 0,
      configRevision: plan.configRevision ?? "",
      steps: (plan.steps ?? []) as unknown as Prisma.InputJsonValue,
      resources: (plan.resources ?? {}) as unknown as Prisma.InputJsonValue,
      unplanned: (plan.unplanned ?? []) as unknown as Prisma.InputJsonValue,
      createdAt: at,
      supersededAt: newer ? at : null
    }
  });
  if (!newer) {
    await tx.plan.updateMany({
      where: { marketId, id: { not: row.id }, supersededAt: null },
      data: { supersededAt: at }
    });
  }
  const decisions: Prisma.DecisionCreateManyInput[] = [];
  for (const step of plan.steps ?? []) {
    // The decision log is only useful when every row names a real action.
    // A malformed step would otherwise enter the review as a "sell" with an
    // id the game can never adopt.
    if (step.kind !== "buy" && step.kind !== "sell") {
      throw new Error(`State payload: plan step kind ${JSON.stringify(step.kind)} is not buy or sell`);
    }
    const itemId = step.itemId;
    if (typeof itemId !== "number" || !Number.isInteger(itemId) || itemId <= 0) {
      throw new Error(`State payload: plan step itemId ${JSON.stringify(itemId)} is not a positive item id`);
    }
    const decisionId = decisionIdFor({
      planRevision: plan.revision,
      itemId,
      kind: step.kind
    });
    decisions.push({
      decisionId,
      planId: row.id,
      planRevision: plan.revision,
      marketId,
      at,
      phase,
      itemId,
      kind: step.kind,
      reason: step.reason ?? null,
      expectedNet: step.expectedNet ?? null,
      // Sell decisions carry the sell plan's fill estimate too; calibration
      // covers both sides, not just buys. The core only labels a sell when
      // it actually estimated a probability, so a missing basis stays null.
      fillProb: step.fillProb ?? null,
      fillBasis: step.fillBasis ?? null,
      allocQty: step.kind === "buy" ? step.allocQty ?? step.qty ?? null : step.qty ?? null,
      allocUnitPrice: step.kind === "buy"
        ? step.allocUnitPrice ?? step.unitPrice ?? null
        : step.price ?? null
    });
  }
  if (decisions.length > 0) {
    const existingIds = await tx.decision.findMany({
      where: { decisionId: { in: decisions.map((row) => row.decisionId as string) } },
      select: { decisionId: true }
    });
    const seen = new Set(existingIds.map((row) => row.decisionId));
    const fresh = decisions.filter((row) => !seen.has(row.decisionId as string));
    if (fresh.length > 0) await tx.decision.createMany({ data: fresh });
  }
  // The adopt event and the plan can arrive in either order. Facts are the
  // durable record; when the plan lands second, its decisions inherit the
  // adoption the player already made.
  const adoptFacts = await tx.journalFact.findMany({
    where: { marketId, kind: "adopt" },
    select: { payload: true }
  });
  for (const fact of adoptFacts) {
    const payload = fact.payload as Record<string, unknown>;
    const decisionId = typeof payload.id === "string" ? payload.id : null;
    if (!decisionId) continue;
    const at = typeof payload.observedAt === "number"
      ? payload.observedAt
      : typeof payload.t === "number" ? payload.t : null;
    if (at === null) continue;
    await tx.decision.updateMany({
      where: { decisionId, adoptedAt: null },
      data: { adoptedAt: new Date(at * 1000) }
    });
  }
  return { created: true, revision: plan.revision };
}

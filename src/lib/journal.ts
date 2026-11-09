// Reads WoWderhoiAH_Journal and replays it with exactly the accounting
// rules of addon/WoWderhoiAH/Ledger.lua. The journal is the only clean
// label the system gets; the ledger is a projection, so the terminal can
// rebuild positions and P&L at import time without trusting a cached sum.

export type JournalEvent = {
  k: string;
  t: number;
  // Stable per-book sequence. A re-sent book is deduplicated by
  // (character, seq), never by comparing whole event tables.
  seq?: number;
  // When the action happened and when the addon learned it. A mailbox sale
  // is necessarily observed later than it happened.
  eventTime?: number;
  observedAt?: number;
  itemId?: number;
  qty?: number;
  cost?: number;
  paid?: number;
  price?: number;
  fee?: number;
  auctionID?: number | string;
  deposit?: number;
  refund?: number;
  lostDeposit?: number;
  outputs?: Array<{ itemId: number; qty: number }>;
  mats?: Array<{ itemId: number; qty: number }>;
  inferred?: boolean;
  // Mail-collected sales: the posting time and the fact that the sale was
  // observed later than it happened (the mailbox is the observation).
  listedAt?: number;
  censored?: boolean;
  // Where a purchase price came from when no client purchase event stated
  // it (mail, estimated, manual). `estimated` marks a price inferred from
  // the current book: the lot can be valued at it, but a later sale's
  // profit is reported as unknown.
  priceSource?: string;
  // /wahadopt carries the terminal's stable decision identity. It is a
  // ledger annotation, not a trade: replay records it for attribution and
  // never lets it change positions or P&L.
  id?: string;
};

export type JournalCheckpoint = {
  throughSeq: number;
  lots: Record<number, JournalLot[]>;
  openPosts: ReplayState["openPosts"];
  trades: JournalTrade[];
  capital: ReplayState["capital"];
  cashAnchor?: number;
};

type JournalBook = {
  key: string;
  events: JournalEvent[];
  dropped: number;
  nextSeq: number;
  checkpoint: JournalCheckpoint | null;
};

type JournalLot = { qty: number; unitCost: number; at: number; known?: boolean };

export type JournalTrade = {
  t: number;
  // The journal sequence of the event that produced this trade. The
  // terminal's fact identity uses it, so a checkpoint that prunes an
  // older trade and shifts array positions cannot turn the same sale into
  // a second row.
  seq?: number;
  itemId: number | null;
  qty: number;
  price: number;
  fee: number;
  basis: number;
  // False when the consumed units had no booked cost (the journal starts
  // mid-history or a craft ran short). The revenue is real, the profit is
  // not: the terminal must report it separately instead of adding a
  // zero-basis windfall to realized P&L and to the policy estimate.
  basisKnown: boolean;
  pnl: number;
  channel: string;
  inferred: boolean;
  // The posting this sale belongs to. A mailbox confirmation upgrades the
  // inferred trade that reconcile booked for the same posting.
  auctionID?: number | string;
  // When the goods were listed, so the fill model can sum exposure hours
  // rather than the span between the first and last sale.
  listedAt?: number;
  observedAt: number;
  censored: boolean;
};

type ReplayError = {
  t: number;
  kind: string;
  itemId?: number;
  missing?: number;
  name?: string;
};

export type ReplayState = {
  // False when some remaining units came from a lot the ledger could not
  // price exactly (short history or an estimated purchase). The quantity is
  // real; the cost attached to it is not a number the system can prove.
  positions: Record<number, { qty: number; cost: number; costKnown: boolean }>;
  // The FIFO lots behind positions. They are not part of the page contract;
  // the checkpoint parity test and a later checkpoint need them.
  lots: Record<number, JournalLot[]>;
  openPosts: Record<string, { itemId?: number; qty: number; price: number; deposit: number; at: number }>;
  trades: JournalTrade[];
  capital: {
    escrow: number;
    realized: number;
    fees: number;
    depositsLost: number;
    // Cash change these events can prove. `cashAnchor` is the purse when
    // the book was created; the reconciler compares their sum with GetMoney.
    cashDelta: number;
  };
  cashAnchor?: number;
  errors: ReplayError[];
};

// Lua's round is floor(x + 0.5), which differs from Math.round for
// negative halves; match it so the two ledgers cannot disagree.
function round(value: number): number {
  return Math.floor((value || 0) + 0.5);
}

function numericEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, entry]) => entry);
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Parses the WoWderhoiAH_Journal global into one book per character.
// Unknown event kinds are kept for the replay to report, not dropped
// silently: a corrupt journal must surface as a counted replay error in
// the import response, which the watcher prints.
export function parseJournal(raw: unknown): JournalBook[] {
  if (typeof raw !== "object" || raw === null) return [];
  const global = raw as Record<string, unknown>;
  const books = global.books;
  if (typeof books !== "object" || books === null) return [];
  return Object.entries(books as Record<string, unknown>).map(([key, bookValue]) => {
    const book = (bookValue ?? {}) as Record<string, unknown>;
    const events = numericEntries(book.e).map((entry, index) => {
      const event = (entry ?? {}) as Record<string, unknown>;
      const parsed: JournalEvent = {
        k: typeof event.k === "string" ? event.k : "",
        t: toNumber(event.t, index)
      };
      for (const field of ["itemId", "qty", "cost", "paid", "price", "fee", "deposit", "refund", "lostDeposit"] as const) {
        if (typeof event[field] === "number") parsed[field] = event[field] as number;
      }
      for (const field of ["seq", "eventTime", "observedAt"] as const) {
        if (typeof event[field] === "number") parsed[field] = event[field] as number;
      }
      // A journal written before the sequence existed is numbered in array
      // order. The sequence is the terminal's only idempotency key, so it
      // must exist even for a migrated book.
      if (parsed.seq === undefined) parsed.seq = index + 1;
      if (typeof event.auctionID === "number" || typeof event.auctionID === "string") parsed.auctionID = event.auctionID;
      if (event.inferred === true) parsed.inferred = true;
      if (typeof event.listedAt === "number") parsed.listedAt = event.listedAt;
      if (typeof event.id === "string" && event.id !== "") parsed.id = event.id;
      if (typeof event.priceSource === "string" && event.priceSource !== "") parsed.priceSource = event.priceSource;
      if (event.censored === true) parsed.censored = true;
      const outputs = numericEntries(event.outputs).map((output) => {
        const row = (output ?? {}) as Record<string, unknown>;
        return { itemId: toNumber(row.itemId), qty: toNumber(row.qty) };
      });
      if (outputs.length > 0) parsed.outputs = outputs;
      const mats = numericEntries(event.mats).map((material) => {
        const row = (material ?? {}) as Record<string, unknown>;
        return { itemId: toNumber(row.itemId), qty: toNumber(row.qty) };
      });
      if (mats.length > 0) parsed.mats = mats;
      return parsed;
    });
    const nextSeq = typeof book.nextSeq === "number"
      ? book.nextSeq
      : events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
    return { key, events, dropped: toNumber(book.dropped), nextSeq, checkpoint: parseCheckpoint(book.checkpoint) };
  });
}

function parseCheckpoint(raw: unknown): JournalCheckpoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const checkpoint = raw as Record<string, unknown>;
  const state = (checkpoint.state ?? {}) as Record<string, unknown>;
  const lots: Record<number, JournalLot[]> = {};
  for (const [key, value] of Object.entries((state.lots ?? {}) as Record<string, unknown>)) {
    const itemId = Number(key);
    if (!Number.isInteger(itemId)) continue;
    lots[itemId] = numericEntries(value).map((entry, index) => {
      const lot = (entry ?? {}) as Record<string, unknown>;
      return {
        qty: toNumber(lot.qty),
        unitCost: toNumber(lot.unitCost),
        at: toNumber(lot.at, index),
        // A checkpoint written before basis provenance existed was booked
        // by definition: the shortfall cases were already recorded.
        known: lot.known !== false
      };
    }).filter((lot) => lot.qty > 0);
  }
  const openPosts: ReplayState["openPosts"] = {};
  for (const [key, value] of Object.entries((state.openPosts ?? {}) as Record<string, unknown>)) {
    const post = (value ?? {}) as Record<string, unknown>;
    openPosts[key] = {
      ...(typeof post.itemId === "number" ? { itemId: post.itemId } : {}),
      qty: toNumber(post.qty),
      price: toNumber(post.price),
      deposit: toNumber(post.deposit),
      at: toNumber(post.at)
    };
  }
  const trades: JournalTrade[] = numericEntries(state.trades).map((entry) => {
    const trade = (entry ?? {}) as Record<string, unknown>;
    return {
      t: toNumber(trade.t),
      ...(typeof trade.seq === "number" ? { seq: trade.seq } : {}),
      itemId: typeof trade.itemId === "number" ? trade.itemId : null,
      qty: toNumber(trade.qty),
      price: toNumber(trade.price),
      fee: toNumber(trade.fee),
      basis: toNumber(trade.basis),
      pnl: toNumber(trade.pnl),
      basisKnown: trade.basisKnown !== false,
      channel: typeof trade.channel === "string" ? trade.channel : "auction",
      inferred: trade.inferred === true,
      ...(typeof trade.auctionID === "number" || typeof trade.auctionID === "string"
        ? { auctionID: trade.auctionID }
        : {}),
      ...(typeof trade.listedAt === "number" ? { listedAt: trade.listedAt } : {}),
      observedAt: toNumber(trade.observedAt, toNumber(trade.t)),
      censored: trade.censored === true
    };
  });
  const capital = (state.capital ?? {}) as Record<string, unknown>;
  return {
    throughSeq: toNumber(checkpoint.throughSeq),
    lots,
    openPosts,
    trades,
    capital: {
      escrow: toNumber(capital.escrow),
      realized: toNumber(capital.realized),
      fees: toNumber(capital.fees),
      depositsLost: toNumber(capital.depositsLost),
      cashDelta: toNumber(capital.cashDelta)
    },
    ...(typeof state.cashAnchor === "number" ? { cashAnchor: state.cashAnchor } : {})
  };
}

function postKey(event: JournalEvent, index: number): string {
  return String(event.auctionID ?? `event:${index}`);
}

// A cheap change token for the watcher. The mailbox flushes a collected
// sale without producing a new scan, so a file newness check keyed on
// scannedAt alone would never import it. Appending an event or dropping the
// oldest one both move the revision; rewriting the file unchanged does not.
export function journalRevision(raw: unknown): string {
  return parseJournal(raw)
    .map((book) =>
      `${book.key}:${book.events.length}:${book.dropped}:${book.nextSeq}:${book.checkpoint?.throughSeq ?? 0}`
    )
    .sort()
    .join("|");
}

export function replayJournal(events: JournalEvent[], checkpoint?: JournalCheckpoint | null): ReplayState {
  const lots = new Map<number, JournalLot[]>();
  const positions: ReplayState["positions"] = {};
  const openPosts: ReplayState["openPosts"] = {};
  const trades: JournalTrade[] = [];
  const errors: ReplayError[] = [];
  const capital = { escrow: 0, realized: 0, fees: 0, depositsLost: 0, cashDelta: 0 };
  let cashAnchor: number | undefined;
  if (checkpoint) {
    for (const [itemId, list] of Object.entries(checkpoint.lots)) {
      lots.set(Number(itemId), list.map((lot) => ({ ...lot })));
    }
    for (const [key, post] of Object.entries(checkpoint.openPosts)) {
      openPosts[key] = { ...post };
    }
    for (const trade of checkpoint.trades) trades.push({ ...trade });
    Object.assign(capital, {
      escrow: checkpoint.capital.escrow,
      realized: checkpoint.capital.realized,
      fees: checkpoint.capital.fees,
      depositsLost: checkpoint.capital.depositsLost,
      cashDelta: checkpoint.capital.cashDelta
    });
    cashAnchor = checkpoint.cashAnchor;
  }

  const addLot = (
    itemId: number | undefined,
    quantity: number,
    unitCost: number,
    at: number,
    known = true
  ) => {
    if (!itemId || quantity <= 0) return;
    const list = lots.get(itemId) ?? [];
    list.push({ qty: quantity, unitCost, at, known });
    lots.set(itemId, list);
  };

  const consume = (
    itemId: number | undefined,
    quantity: number,
    at: number
  ): { basis: number; known: boolean } => {
    if (!itemId) return { basis: 0, known: false };
    const list = lots.get(itemId);
    let remaining = quantity;
    let basis = 0;
    let known = true;
    if (list) {
      while (remaining > 0 && list.length > 0) {
        const lot = list[0];
        const take = Math.min(remaining, lot.qty);
        basis += take * lot.unitCost;
        if (lot.known === false) known = false;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 0) list.shift();
      }
      if (list.length === 0) lots.delete(itemId);
    }
    if (remaining > 0) {
      known = false;
      errors.push({ t: at, kind: "short_position", itemId, missing: remaining });
    }
    return { basis, known };
  };

  events.forEach((event, index) => {
    const at = event.t ?? index;
    switch (event.k) {
      case "buy": {
        const quantity = event.qty ?? 0;
        const cost = event.cost ?? 0;
        // An estimate from the current search results is not a receipt.
        addLot(event.itemId, quantity, quantity > 0 ? cost / quantity : 0, at, event.priceSource !== "estimated");
        capital.cashDelta -= cost;
        break;
      }
      case "craft": {
        // A craft consumes its materials and adds the product at their FIFO
        // cost. The capture never prices the craft; the ledger is the only
        // authority for what the consumed units were booked at.
        let basis = 0;
        let known = true;
        for (const material of event.mats ?? []) {
          const consumed = consume(material.itemId, material.qty, at);
          basis += consumed.basis;
          known = known && consumed.known;
        }
        const quantity = event.qty ?? 0;
        addLot(event.itemId, quantity, quantity > 0 ? basis / quantity : 0, at, known);
        break;
      }
      case "vendor": {
        const { basis, known } = consume(event.itemId, event.qty ?? 0, at);
        const paid = event.paid ?? 0;
        capital.realized += paid - basis;
        capital.cashDelta += paid;
        // Money is whole copper. A unit price can be fractional (a stack
        // bought or sold as a lot), but trade rows must survive an
        // integer-column projection: round the unit price and the realized
        // cash once, here, and identically to Ledger.lua.
        trades.push({
          t: at, seq: event.seq, itemId: event.itemId ?? null, qty: event.qty ?? 0,
          price: (event.qty ?? 0) > 0 ? round(paid / (event.qty ?? 1)) : 0,
          fee: 0, basis, basisKnown: known, pnl: round(paid - basis), channel: "vendor", inferred: false,
          observedAt: at, censored: false
        });
        break;
      }
      case "post": {
        openPosts[postKey(event, index)] = {
          itemId: event.itemId,
          qty: event.qty ?? 0,
          price: event.price ?? 0,
          deposit: event.deposit ?? 0,
          at
        };
        capital.escrow += event.deposit ?? 0;
        capital.cashDelta -= event.deposit ?? 0;
        break;
      }
      case "sold": {
        const key = postKey(event, index);
        const post = openPosts[key];
        const quantity = event.qty ?? post?.qty ?? 0;
        const price = event.price ?? post?.price ?? 0;
        const fee = event.fee ?? 0;
        const itemId = event.itemId ?? post?.itemId;
        const { basis, known } = consume(itemId, quantity, at);
        capital.realized += price * quantity - fee - basis;
        capital.fees += fee;
        capital.cashDelta += price * quantity - fee;
        if (post) {
          // A commodity listing can fill in pieces: keep the remaining units
          // open and refund the deposit only when the posting is exhausted.
          const remaining = post.qty - quantity;
          if (remaining > 0) post.qty = remaining;
          else {
            capital.escrow -= post.deposit;
            capital.cashDelta += post.deposit;
            delete openPosts[key];
          }
        }
        const listedAt = event.listedAt ?? post?.at;
        trades.push({
          t: at, seq: event.seq, itemId: itemId ?? null, qty: quantity, price: round(price), fee: round(fee), basis,
          basisKnown: known,
          pnl: round(price * quantity - fee - basis), channel: "auction",
          ...(event.auctionID !== undefined ? { auctionID: event.auctionID } : {}),
          inferred: event.inferred === true,
          ...(listedAt !== undefined ? { listedAt } : {}),
          observedAt: at,
          censored: event.censored === true
        });
        break;
      }
      case "confirm": {
        // The mailbox confirmed a sale an older addon version had booked
        // as an inference. Upgrade the trade in place; booking it again
        // would count the revenue and the consumed lots twice.
        const trade = trades.find(
          (candidate) =>
            candidate.inferred
            && candidate.channel === "auction"
            && event.auctionID !== undefined
            && candidate.auctionID === event.auctionID
        );
        if (trade) {
          const quantity = event.qty ?? trade.qty;
          const price = event.price ?? trade.price;
          const fee = event.fee ?? trade.fee;
          capital.realized += price * quantity - fee - (trade.price * trade.qty - trade.fee);
          capital.fees += fee - trade.fee;
          capital.cashDelta += (price * quantity - fee) - (trade.price * trade.qty - trade.fee);
          trade.qty = quantity;
          trade.price = round(price);
          trade.fee = round(fee);
          trade.pnl = round(price * quantity - fee - trade.basis);
          trade.inferred = false;
          if (event.listedAt !== undefined) trade.listedAt = event.listedAt;
          trade.observedAt = at;
          trade.censored = event.censored === true;
        } else {
          // Only a truncated journal should get here; report it rather than
          // booking a sale whose lots were never consumed.
          errors.push({ t: at, kind: "confirm_without_sale", itemId: event.itemId });
        }
        break;
      }
      case "cancel": {
        const key = postKey(event, index);
        const post = openPosts[key];
        const lost = event.lostDeposit ?? 0;
        const refund = event.refund ?? ((post?.deposit ?? 0) - lost);
        capital.escrow = Math.max(0, capital.escrow - refund - lost);
        capital.depositsLost += lost;
        capital.cashDelta += refund;
        delete openPosts[key];
        break;
      }
      case "expire": {
        const key = postKey(event, index);
        const post = openPosts[key];
        const lost = event.lostDeposit ?? post?.deposit ?? 0;
        capital.escrow = Math.max(0, capital.escrow - lost);
        capital.depositsLost += lost;
        delete openPosts[key];
        break;
      }
      case "transfer_out": {
        // Goods moved to another character. The sending book keeps the FIFO
        // cost only long enough to consume it; the receiving character's
        // journal records the same basis with transfer_in.
        consume(event.itemId, event.qty ?? 0, at);
        break;
      }
      case "transfer_in": {
        const quantity = event.qty ?? 0;
        addLot(event.itemId, quantity, quantity > 0 ? (event.cost ?? 0) / quantity : 0, at, event.cost !== undefined);
        break;
      }
      case "de":
      case "prospect":
      case "mill": {
        const { basis, known } = consume(event.itemId, event.qty ?? 0, at);
        const outputs = event.outputs ?? [];
        const outputQty = outputs.reduce((sum, output) => sum + (output.qty ?? 0), 0);
        const unitCost = outputQty > 0 ? basis / outputQty : 0;
        for (const output of outputs) addLot(output.itemId, output.qty ?? 0, unitCost, at, known);
        break;
      }
      case "bid": {
        // A bid freezes money but does not consume goods. The win arrives
        // as a mail `buy`, which is the cash fact; counting the freeze too
        // would subtract the same copper twice.
        break;
      }
      case "adopt": {
        // The adoption is read by the import layer from the raw event list;
        // the ledger has no state to update.
        break;
      }
      default:
        errors.push({ t: at, kind: "unknown_event", name: event.k });
    }
  });

  for (const [itemId, list] of lots.entries()) {
    const quantity = list.reduce((sum, lot) => sum + lot.qty, 0);
    const cost = list.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0);
    if (quantity <= 0) {
      lots.delete(itemId);
      continue;
    }
    positions[itemId] = {
      qty: quantity,
      cost: round(cost),
      costKnown: list.every((lot) => lot.known !== false)
    };
  }

  const lotRecord: Record<number, JournalLot[]> = {};
  for (const [itemId, list] of lots.entries()) lotRecord[itemId] = list;
  return {
    positions,
    lots: lotRecord,
    openPosts,
    trades,
    capital: {
      ...capital,
      realized: round(capital.realized),
      fees: round(capital.fees),
      depositsLost: round(capital.depositsLost),
      escrow: round(capital.escrow),
      cashDelta: round(capital.cashDelta)
    },
    ...(cashAnchor === undefined ? {} : { cashAnchor }),
    errors
  };
}

// The adopt events are annotations, not ledger rows; the import layer reads
// their ids to set Decision.adoptedAt.
export function adoptionTimes(events: readonly JournalEvent[]): Map<string, Date> {
  const adopted = new Map<string, Date>();
  for (const event of events) {
    if (event.k === "adopt" && event.id) adopted.set(event.id, new Date((event.t ?? 0) * 1000));
  }
  return adopted;
}


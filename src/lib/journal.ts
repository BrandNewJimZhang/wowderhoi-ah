// Reads WoWderhoiAH_Journal and replays it with exactly the accounting
// rules of addon/WoWderhoiAH/Ledger.lua. The journal is the only clean
// label the system gets; the ledger is a projection, so the terminal can
// rebuild positions and P&L at import time without trusting a cached sum.

export type JournalEvent = {
  k: string;
  t: number;
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
};

export type JournalBook = {
  key: string;
  events: JournalEvent[];
  dropped: number;
};

export type JournalLot = { qty: number; unitCost: number; at: number };

export type JournalTrade = {
  t: number;
  itemId: number | null;
  qty: number;
  price: number;
  fee: number;
  basis: number;
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

export type ReplayError = {
  t: number;
  kind: string;
  itemId?: number;
  missing?: number;
  name?: string;
};

export type ReplayState = {
  positions: Record<number, { qty: number; cost: number }>;
  openPosts: Record<string, { itemId?: number; qty: number; price: number; deposit: number; at: number }>;
  trades: JournalTrade[];
  capital: {
    escrow: number;
    realized: number;
    fees: number;
    depositsLost: number;
  };
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
// silently: a corrupt journal must be visible on the review page.
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
      if (typeof event.auctionID === "number" || typeof event.auctionID === "string") parsed.auctionID = event.auctionID;
      if (event.inferred === true) parsed.inferred = true;
      if (typeof event.listedAt === "number") parsed.listedAt = event.listedAt;
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
    return { key, events, dropped: toNumber(book.dropped) };
  });
}

// The journal is per character, but the terminal's positions and trades are
// market-scoped because they pair with that market's cash. Pick the book of
// the character that produced the scan and never fall back to another one:
// an alt's book would report positions the scanning character does not hold.
export function bookForCharacter(books: JournalBook[], key: string | null): JournalBook | null {
  if (!key) return null;
  return books.find((book) => book.key === key) ?? null;
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
    .map((book) => `${book.key}:${book.events.length}:${book.dropped}`)
    .sort()
    .join("|");
}

export function replayJournal(events: JournalEvent[]): ReplayState {
  const lots = new Map<number, JournalLot[]>();
  const positions: Record<number, { qty: number; cost: number }> = {};
  const openPosts: ReplayState["openPosts"] = {};
  const trades: JournalTrade[] = [];
  const errors: ReplayError[] = [];
  const capital = { escrow: 0, realized: 0, fees: 0, depositsLost: 0 };

  const addLot = (itemId: number | undefined, quantity: number, unitCost: number, at: number) => {
    if (!itemId || quantity <= 0) return;
    const list = lots.get(itemId) ?? [];
    list.push({ qty: quantity, unitCost, at });
    lots.set(itemId, list);
  };

  const consume = (itemId: number | undefined, quantity: number, at: number): number => {
    if (!itemId) return 0;
    const list = lots.get(itemId);
    let remaining = quantity;
    let basis = 0;
    if (list) {
      while (remaining > 0 && list.length > 0) {
        const lot = list[0];
        const take = Math.min(remaining, lot.qty);
        basis += take * lot.unitCost;
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= 0) list.shift();
      }
      if (list.length === 0) lots.delete(itemId);
    }
    if (remaining > 0) {
      errors.push({ t: at, kind: "short_position", itemId, missing: remaining });
    }
    return basis;
  };

  events.forEach((event, index) => {
    const at = event.t ?? index;
    switch (event.k) {
      case "buy": {
        const quantity = event.qty ?? 0;
        const cost = event.cost ?? 0;
        addLot(event.itemId, quantity, quantity > 0 ? cost / quantity : 0, at);
        break;
      }
      case "craft": {
        // A craft consumes its materials and adds the product at their FIFO
        // cost. The capture never prices the craft; the ledger is the only
        // authority for what the consumed units were booked at.
        let basis = 0;
        for (const material of event.mats ?? []) {
          basis += consume(material.itemId, material.qty, at);
        }
        const quantity = event.qty ?? 0;
        addLot(event.itemId, quantity, quantity > 0 ? basis / quantity : 0, at);
        break;
      }
      case "vendor": {
        const basis = consume(event.itemId, event.qty ?? 0, at);
        const paid = event.paid ?? 0;
        capital.realized += paid - basis;
        // Money is whole copper. A unit price can be fractional (a stack
        // bought or sold as a lot), but trade rows must survive an
        // integer-column projection: round the unit price and the realized
        // cash once, here, and identically to Ledger.lua.
        trades.push({
          t: at, itemId: event.itemId ?? null, qty: event.qty ?? 0,
          price: (event.qty ?? 0) > 0 ? round(paid / (event.qty ?? 1)) : 0,
          fee: 0, basis, pnl: round(paid - basis), channel: "vendor", inferred: false,
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
        break;
      }
      case "sold": {
        const key = postKey(event, index);
        const post = openPosts[key];
        const quantity = event.qty ?? post?.qty ?? 0;
        const price = event.price ?? post?.price ?? 0;
        const fee = event.fee ?? 0;
        const itemId = event.itemId ?? post?.itemId;
        const basis = consume(itemId, quantity, at);
        capital.realized += price * quantity - fee - basis;
        capital.fees += fee;
        if (post) {
          // A commodity listing can fill in pieces: keep the remaining units
          // open and refund the deposit only when the posting is exhausted.
          const remaining = post.qty - quantity;
          if (remaining > 0) post.qty = remaining;
          else {
            capital.escrow -= post.deposit;
            delete openPosts[key];
          }
        }
        const listedAt = event.listedAt ?? post?.at;
        trades.push({
          t: at, itemId: itemId ?? null, qty: quantity, price: round(price), fee: round(fee), basis,
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
        // The mailbox confirmed a sale reconcile had booked as an
        // inference. Upgrade the trade in place; booking it again would
        // count the revenue and the consumed lots twice.
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
      case "de":
      case "prospect":
      case "mill": {
        const basis = consume(event.itemId, event.qty ?? 0, at);
        const outputs = event.outputs ?? [];
        const outputQty = outputs.reduce((sum, output) => sum + (output.qty ?? 0), 0);
        const unitCost = outputQty > 0 ? basis / outputQty : 0;
        for (const output of outputs) addLot(output.itemId, output.qty ?? 0, unitCost, at);
        break;
      }
      default:
        errors.push({ t: at, kind: "unknown_event", name: event.k });
    }
  });

  for (const [itemId, list] of lots.entries()) {
    const quantity = list.reduce((sum, lot) => sum + lot.qty, 0);
    const cost = list.reduce((sum, lot) => sum + lot.qty * lot.unitCost, 0);
    if (quantity <= 0) lots.delete(itemId);
    else positions[itemId] = { qty: quantity, cost: round(cost) };
  }

  return {
    positions,
    openPosts,
    trades,
    capital: {
      ...capital,
      realized: round(capital.realized),
      fees: round(capital.fees),
      depositsLost: round(capital.depositsLost),
      escrow: round(capital.escrow)
    },
    errors
  };
}


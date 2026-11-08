// Parses WoW SavedVariables Lua files and validates addon scan payloads.
// Single validation authority for addon-sourced scans: the watcher and the
// import route both rely on normalizeAddonScan, never on ad-hoc checks.
import { SCAN_PIPELINE_VERSION } from "@/lib/market-rules";

// Quality index -> name mapping shared with the perf fixtures generator.
export const QUALITY_NAMES = ["poor", "common", "uncommon", "rare", "epic", "legendary"] as const;

type AddonTier = { p: number; q: number };

type AddonMarketType = "commodity" | "item";

export type AddonScanItem = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  // The scanner's own classification of the book, priced rows only. The
  // terminal's core must consume this rather than re-deriving it: a
  // purchase thins the ladder, and a persisted category can lag the scan.
  marketType: AddonMarketType | null;
  // False for demand-only rows: the item had bid-only listings and no
  // buyout, so all price and supply columns are zero.
  priced: boolean;
  minPrice: number;
  marketPrice: number; // quantity-weighted P10 unit price, copper (a statistic)
  sellPrice: number; // depth-aware sell front, copper (the decision anchor)
  p5Price: number;
  quantity: number;
  numAuctions: number;
  sellerCount: number;
  sellersInvisible: boolean;
  // True when at least one listing named its owner. The fill model reads it:
  // hidden owners mean a disappearance is unobservable, not zero.
  ownerVisible: boolean;
  sellerHHI: number | null; // other sellers' supply concentration, 0..1
  topSellerShare: number | null;
  bidOnlyCount: number;
  highestBid: number; // highest current bid among bid-only listings, copper
  inferredSoldLow: number; // units that left an owner across scans (sales + cancels)
  inferredSoldHigh: number; // units that left a price key (also repricing)
  // False when the scan had no previous capture of this item: the zero
  // disappearance is missing data, not an observed zero. Payloads written
  // before the flag existed default to true, the behaviour they were
  // imported under.
  flowObserved: boolean;
  supplyGrowth: number; // fraction per hour
  // History points inside the phase window at scan time. The scanner owns
  // the series, so it stamps this once instead of every radar refresh
  // walking the points again; null on scans from before the field existed.
  historySamples: number | null;
  vendorPrice: number; // NPC sell price in copper; 0 = unsellable to vendors
  tiers: AddonTier[]; // top of the price ladder, ascending
  // True when the book had more rungs than the persisted top eight. The
  // core must then treat the unseen depth as a queue behind the visible top.
  tierTruncated: boolean;
  expiring: { soon: number; mid: number; late: number };
};

type AddonScan = {
  scannedAt: Date;
  server: string;
  faction: string;
  character: string | null;
  cash: number;
  // Optional server opening epoch (seconds). Phase age is measured from it
  // when present; without it the terminal falls back to the oldest scan.
  openedAt: number | null;
  // Free bag slots the scanner saw. The terminal runs the same decision core
  // but cannot read the player's bags; null means an older addon that did not
  // report the field, so the core keeps its planning fallback.
  bagSlots: number | null;
  // Hygiene generation of the flow columns. 2 excludes the player's own
  // listings and purchases; null on scans from older builds, which the
  // calibration must not mix with clean rows.
  observationVersion: number | null;
  items: AddonScanItem[];
};

type LuaValue = string | number | boolean | null | { [key: string]: LuaValue };

// SavedVariables files are machine-written by the WoW client in a fixed shape:
// `GlobalName = { ["key"] = value, [123] = { ... }, }` — a recursive-descent
// parser over that grammar is sufficient; this is not a general Lua parser.
export function parseSavedVariables(source: string): Record<string, LuaValue> {
  const parser = new SavedVariablesParser(source);
  return parser.parseFile();
}

class SavedVariablesParser {
  private pos = 0;

  constructor(private readonly source: string) {}

  parseFile(): Record<string, LuaValue> {
    const globals: Record<string, LuaValue> = {};
    this.skipWhitespace();
    while (this.pos < this.source.length) {
      const name = this.readIdentifier();
      this.expect("=");
      globals[name] = this.readValue();
      this.skipWhitespace();
    }
    return globals;
  }

  private readValue(): LuaValue {
    this.skipWhitespace();
    const char = this.source[this.pos];
    if (char === "{") return this.readTable();
    if (char === '"') return this.readString();
    if (this.source.startsWith("true", this.pos)) { this.pos += 4; return true; }
    if (this.source.startsWith("false", this.pos)) { this.pos += 5; return false; }
    if (this.source.startsWith("nil", this.pos)) { this.pos += 3; return null; }
    return this.readNumber();
  }

  private readTable(): { [key: string]: LuaValue } {
    this.expect("{");
    const table: { [key: string]: LuaValue } = {};
    let arrayIndex = 1;
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.source.length) {
        throw new Error(`SavedVariables parse error: unterminated table at end of input`);
      }
      if (this.source[this.pos] === "}") { this.pos += 1; break; }
      let key: string;
      if (this.source[this.pos] === "[") {
        this.pos += 1;
        this.skipWhitespace();
        key = this.source[this.pos] === '"' ? this.readString() : String(this.readNumber());
        this.expect("]");
        this.expect("=");
      } else {
        // Positional array entry, e.g. `{ 1, 2, 3 }`.
        key = String(arrayIndex);
        arrayIndex += 1;
      }
      table[key] = this.readValue();
      this.skipWhitespace();
      if (this.source[this.pos] === ",") this.pos += 1;
    }
    return table;
  }

  private readString(): string {
    this.expect('"');
    let value = "";
    while (this.pos < this.source.length && this.source[this.pos] !== '"') {
      if (this.source[this.pos] === "\\") {
        const escaped = this.source[this.pos + 1];
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        this.pos += 2;
      } else {
        value += this.source[this.pos];
        this.pos += 1;
      }
    }
    this.expect('"');
    return value;
  }

  private readNumber(): number {
    const match = /^-?\d+(?:\.\d+)?(?:e-?\d+)?/.exec(this.source.slice(this.pos));
    if (!match) {
      throw new Error(`SavedVariables parse error: expected value at offset ${this.pos}`);
    }
    this.pos += match[0].length;
    return Number(match[0]);
  }

  private readIdentifier(): string {
    this.skipWhitespace();
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.source.slice(this.pos));
    if (!match) {
      throw new Error(`SavedVariables parse error: expected identifier at offset ${this.pos}`);
    }
    this.pos += match[0].length;
    return match[0];
  }

  private expect(token: string) {
    this.skipWhitespace();
    if (!this.source.startsWith(token, this.pos)) {
      throw new Error(`SavedVariables parse error: expected "${token}" at offset ${this.pos}`);
    }
    this.pos += token.length;
  }

  private skipWhitespace() {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos += 1;
  }
}

function requirePositiveInt(value: unknown, field: string, itemId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Addon scan item ${itemId}: ${field} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return Math.round(value);
}

// A tier price is buyout / count, so it is legitimately fractional when a
// stack does not divide evenly. Keep the client's value: rounding it here
// made the terminal's ladder cost a different book than the in-game core's.
function positivePrice(value: unknown, field: string, itemId: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Addon scan item ${itemId}: ${field} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNonNegative(value: unknown, field: string, itemId: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Addon scan item ${itemId}: ${field} must be a non-negative number, got ${JSON.stringify(value)}`);
  }
  return Math.round(value);
}

function optionalFinite(value: unknown, field: string, itemId: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Addon scan item ${itemId}: ${field} must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeTiers(value: unknown, itemId: string, fallback: { p: number; q: number }): AddonTier[] {
  if (value === undefined || value === null) return [fallback];
  if (typeof value !== "object") {
    throw new Error(`Addon scan item ${itemId}: tiers must be a table, got ${JSON.stringify(value)}`);
  }
  const tiers = Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Addon scan item ${itemId}: tier ${key} must be a table`);
    }
    const tier = entry as Record<string, unknown>;
    return {
      p: positivePrice(tier.p, `tiers[${key}].p`, itemId),
      q: requirePositiveInt(tier.q, `tiers[${key}].q`, itemId)
    };
  });
  if (tiers.length === 0) return [fallback];
  return tiers.sort((left, right) => left.p - right.p);
}

function normalizeMarketType(value: unknown, itemId: string): AddonMarketType | null {
  if (value === undefined || value === null) return null;
  if (value === "commodity" || value === "item") return value;
  throw new Error(`Addon scan item ${itemId}: marketType must be "commodity" or "item", got ${JSON.stringify(value)}`);
}

function optionalShare(value: unknown, field: string, itemId: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Addon scan item ${itemId}: ${field} must be a share in [0, 1], got ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeExpiring(value: unknown, itemId: string) {
  if (value === undefined || value === null) return { soon: 0, mid: 0, late: 0 };
  const entry = value as Record<string, unknown>;
  return {
    soon: optionalNonNegative(entry.soon, "expiring.soon", itemId),
    mid: optionalNonNegative(entry.mid, "expiring.mid", itemId),
    late: optionalNonNegative(entry.late, "expiring.late", itemId)
  };
}

export function normalizeAddonScan(raw: unknown): AddonScan {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Addon scan payload must be an object, got ${JSON.stringify(raw)}`);
  }
  const scan = raw as Record<string, unknown>;
  // Pipeline gate: v4 scans carry the sell front, the price ladder, seller
  // identities and the adjacent-scan flow. Older shapes cannot be reinterpreted.
  if (scan.dataVersion !== SCAN_PIPELINE_VERSION) {
    throw new Error(`Addon scan dataVersion must be ${SCAN_PIPELINE_VERSION} (order-book pipeline), got ${JSON.stringify(scan.dataVersion)} — rescan in game with the current addon`);
  }
  if (typeof scan.scannedAt !== "number" || scan.scannedAt <= 0) {
    throw new Error(`Addon scan scannedAt must be a positive epoch, got ${JSON.stringify(scan.scannedAt)}`);
  }
  if (typeof scan.server !== "string" || scan.server === "") {
    throw new Error(`Addon scan server must be a non-empty string, got ${JSON.stringify(scan.server)}`);
  }
  if (typeof scan.faction !== "string" || scan.faction === "") {
    throw new Error(`Addon scan faction must be a non-empty string, got ${JSON.stringify(scan.faction)}`);
  }
  if (typeof scan.items !== "object" || scan.items === null || Object.keys(scan.items).length === 0) {
    throw new Error("Addon scan items must be a non-empty table of itemId entries");
  }

  const items: AddonScanItem[] = [];
  for (const [key, value] of Object.entries(scan.items as Record<string, unknown>)) {
    const itemId = Number(key);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      throw new Error(`Addon scan item key must be a positive itemId, got ${JSON.stringify(key)}`);
    }
    if (typeof value !== "object" || value === null) {
      throw new Error(`Addon scan item ${key} must be a table, got ${JSON.stringify(value)}`);
    }
    const entry = value as Record<string, unknown>;
    const bidOnlyCount = optionalNonNegative(entry.bidOnly, "bidOnly", key);
    const inferredSoldLow = optionalNonNegative(entry.inferredSoldLow, "inferredSoldLow", key);
    const inferredSoldHigh = optionalNonNegative(entry.inferredSoldHigh, "inferredSoldHigh", key);
    if (inferredSoldHigh < inferredSoldLow) {
      throw new Error(`Addon scan item ${key}: inferredSoldHigh (${inferredSoldHigh}) is below inferredSoldLow (${inferredSoldLow})`);
    }
    // The modern client loads item records lazily and reports an empty name
    // for an item it has not cached yet. That is a missing read, not a
    // malformed scan: the book is real and the item table keeps the name it
    // already knows until a later scan resolves it.
    if (typeof entry.name !== "string") {
      throw new Error(`Addon scan item ${key}: name must be a string`);
    }
    const qualityIndex = typeof entry.quality === "number" ? entry.quality : -1;
    // A bid-only item has no buyout on any listing: it is a demand-only
    // observation and its price columns are zero by definition.
    const priced = typeof entry.minPrice === "number" && entry.minPrice > 0;
    if (!priced && bidOnlyCount === 0) {
      throw new Error(`Addon scan item ${key}: minPrice must be positive unless the entry has bid-only demand`);
    }
    const minPrice = priced ? requirePositiveInt(entry.minPrice, "minPrice", key) : 0;
    const quantity = priced ? requirePositiveInt(entry.quantity, "quantity", key) : 0;
    const numAuctions = priced ? requirePositiveInt(entry.numAuctions, "numAuctions", key) : 0;
    const sellPrice = priced ? requirePositiveInt(entry.sellP, "sellP", key) : 0;
    items.push({
      itemId,
      name: entry.name,
      quality: QUALITY_NAMES[qualityIndex] ?? "unknown",
      category: typeof entry.itemClass === "string" && entry.itemClass !== "" ? entry.itemClass : "unknown",
      subCategory: typeof entry.itemSubClass === "string" && entry.itemSubClass !== "" ? entry.itemSubClass : "unknown",
      marketType: priced ? normalizeMarketType(entry.marketType, key) : null,
      priced,
      minPrice,
      marketPrice: priced ? requirePositiveInt(entry.marketPrice, "marketPrice", key) : 0,
      sellPrice,
      p5Price: priced ? optionalNonNegative(entry.p5, "p5", key) : 0,
      quantity,
      numAuctions,
      sellerCount: !priced ? 0 : entry.sellers === undefined ? numAuctions : optionalNonNegative(entry.sellers, "sellers", key),
      sellersInvisible: entry.sellersInvisible === true,
      ownerVisible: entry.ownerVisible === true,
      sellerHHI: optionalShare(entry.sellerHHI, "sellerHHI", key),
      topSellerShare: optionalShare(entry.topSellerShare, "topSellerShare", key),
      bidOnlyCount,
      highestBid: optionalNonNegative(entry.highestBid, "highestBid", key),
      inferredSoldLow,
      inferredSoldHigh,
      flowObserved: priced ? entry.flowObserved !== false : false,
      supplyGrowth: optionalFinite(entry.supplyGrowth, "supplyGrowth", key),
      historySamples: typeof entry.historySamples === "number"
        ? Math.round(optionalNonNegative(entry.historySamples, "historySamples", key))
        : null,
      vendorPrice: optionalNonNegative(entry.vendorP, "vendorP", key),
      tiers: priced ? normalizeTiers(entry.tiers, key, { p: minPrice, q: quantity }) : [],
      tierTruncated: priced ? entry.tierTruncated === true : false,
      expiring: normalizeExpiring(entry.expiring, key)
    });
  }
  if (!items.some((item) => item.priced)) {
    throw new Error("Addon scan contains no priced items (only bid-only entries)");
  }

  return {
    scannedAt: new Date(scan.scannedAt * 1000),
    server: scan.server,
    faction: scan.faction,
    character: typeof scan.character === "string" ? scan.character : null,
    cash: optionalNonNegative(scan.cash, "cash", "scan"),
    // null = the addon did not report the field (an older version), so the
    // import must leave a configured anchor alone. 0 = the player cleared
    // it, so the import must drop the anchor it kept.
    openedAt: typeof scan.openedAt === "number" && Number.isFinite(scan.openedAt) && scan.openedAt >= 0
      ? Math.round(scan.openedAt)
      : null,
    bagSlots: typeof scan.bagSlots === "number"
      ? Math.round(optionalNonNegative(scan.bagSlots, "bagSlots", "scan"))
      : null,
    observationVersion: typeof scan.observationVersion === "number"
      ? Math.round(optionalNonNegative(scan.observationVersion, "observationVersion", "scan"))
      : null,
    items
  };
}

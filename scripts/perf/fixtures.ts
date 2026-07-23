// Deterministic synthetic market data for the perf harness. Prices follow
// seeded random walks with occasional bait listings (min far below market),
// mirroring the non-Gaussian shape real scans have, so median/percentile
// code paths are exercised honestly. Same seed -> identical market.
import { QUALITY_NAMES } from "@/lib/addon-scan";

export type SnapshotPoint = {
  minPrice: number;
  marketPrice: number;
  quantity: number;
  numAuctions: number;
};

export type SyntheticItem = {
  itemId: number;
  name: string;
  qualityIndex: number;
  itemClass: string;
  itemSubClass: string;
  walk: SnapshotPoint[]; // oldest -> newest, one point per scan
};

export type SyntheticMarket = { items: SyntheticItem[] };

// Rough histogram of a real Anniversary AH scan: trade goods dominate.
const ITEM_CLASSES: Array<{ itemClass: string; itemSubClass: string; weight: number }> = [
  { itemClass: "Trade Goods", itemSubClass: "Herb", weight: 3 },
  { itemClass: "Trade Goods", itemSubClass: "Metal & Stone", weight: 3 },
  { itemClass: "Trade Goods", itemSubClass: "Cloth", weight: 2 },
  { itemClass: "Trade Goods", itemSubClass: "Enchanting", weight: 3 },
  { itemClass: "Consumable", itemSubClass: "Potion", weight: 2 },
  { itemClass: "Consumable", itemSubClass: "Elixir", weight: 2 },
  { itemClass: "Consumable", itemSubClass: "Food & Drink", weight: 1 },
  { itemClass: "Armor", itemSubClass: "Cloth", weight: 2 },
  { itemClass: "Armor", itemSubClass: "Plate", weight: 1 },
  { itemClass: "Weapon", itemSubClass: "Sword", weight: 1 },
  { itemClass: "Recipe", itemSubClass: "Alchemy", weight: 1 },
  { itemClass: "Gem", itemSubClass: "Simple", weight: 1 }
];

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends { weight: number }>(rng: () => number, entries: T[]): T {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = rng() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

function generateWalk(rng: () => number, depth: number): SnapshotPoint[] {
  // Log-uniform start between 10c and 500g so the catalog spans cheap
  // reagents and epic-tier prices like a real scan does.
  let market = Math.round(10 * Math.exp(rng() * Math.log(500_00_00 / 10)));
  const baseQuantity = 1 + Math.floor(rng() * 400);
  const walk: SnapshotPoint[] = [];
  for (let step = 0; step < depth; step += 1) {
    market = Math.max(1, Math.round(market * (0.97 + rng() * 0.06)));
    const bait = rng() < 0.08;
    const minPrice = Math.max(1, Math.round(market * (bait ? 0.3 + rng() * 0.4 : 0.9 + rng() * 0.1)));
    const spike = rng() < 0.05 ? 5 : 1;
    const quantity = Math.max(1, Math.round(baseQuantity * spike * (0.5 + rng())));
    const numAuctions = Math.max(1, Math.round(quantity / (1 + rng() * 19)));
    walk.push({ minPrice: Math.min(minPrice, market), marketPrice: market, quantity, numAuctions });
  }
  return walk;
}

export function generateMarket(opts: { itemCount: number; depth: number; seed?: number }): SyntheticMarket {
  const rng = mulberry32(opts.seed ?? 1);
  const items: SyntheticItem[] = [];
  for (let index = 0; index < opts.itemCount; index += 1) {
    const slot = pickWeighted(rng, ITEM_CLASSES);
    const qualityRoll = rng();
    const qualityIndex = qualityRoll < 0.55 ? 1 : qualityRoll < 0.8 ? 2 : qualityRoll < 0.95 ? 3 : 4;
    items.push({
      itemId: 10_000 + index,
      name: `Perf ${slot.itemSubClass} #${index}`,
      qualityIndex,
      itemClass: slot.itemClass,
      itemSubClass: slot.itemSubClass,
      walk: generateWalk(rng, opts.depth)
    });
  }
  return { items };
}

export function qualityName(qualityIndex: number): string {
  return QUALITY_NAMES[qualityIndex] ?? "unknown";
}

// Payload in the exact shape the addon writes and normalizeAddonScan
// validates; pointIndex selects which walk step this scan represents.
export function buildScanPayload(market: SyntheticMarket, pointIndex: number, scannedAtEpochSeconds: number) {
  const items: Record<string, unknown> = {};
  for (const item of market.items) {
    const point = item.walk[pointIndex];
    if (!point) {
      throw new Error(`buildScanPayload: pointIndex ${pointIndex} exceeds walk depth ${item.walk.length}`);
    }
    items[String(item.itemId)] = {
      name: item.name,
      quality: item.qualityIndex,
      itemClass: item.itemClass,
      itemSubClass: item.itemSubClass,
      minPrice: point.minPrice,
      marketPrice: point.marketPrice,
      quantity: point.quantity,
      numAuctions: point.numAuctions
    };
  }
  return {
    dataVersion: 2,
    scannedAt: scannedAtEpochSeconds,
    server: "PerfRealm",
    faction: "Alliance",
    items
  };
}

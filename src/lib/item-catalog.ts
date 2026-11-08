// The client item catalogue is the only authority for an item's static
// facts. Scans observe the market; they do not decide what an item is.
// This module validates the committed dataset and plans the writes, so the
// fetch script, the import script and their tests share one parser.
import { itemTaxonomy } from "@/lib/item-taxonomy";
import { qualityName } from "@/lib/quality";

export const CATALOG_SOURCE = "wuxianwow.com";
// Rows the catalogue does not own stay scan-owned: the scanner may create a
// placeholder and fill it from the client later, but it can never overwrite
// a catalogue fact.
export const SCAN_SOURCE = "scan";

export type CatalogItem = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number; // catalogue is complete: an omitted sell price is 0
  iconId: number;
  itemLevel: number | null;
  requiredLevel: number | null;
  slot: string | null;
  typeLabel: string | null;
};

type CatalogDataset = {
  source: string;
  build: string;
  fetchedAt: string;
  items: CatalogItem[];
};

type RawEntry = Record<string, unknown>;

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Catalogue ${field} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Catalogue ${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalNonNegativeInt(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requireNonNegativeInt(value, field);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`Catalogue ${field} must be a string, got ${JSON.stringify(value)}`);
  }
  return value === "" ? null : value;
}

// Maps one wuxianwow items.json row onto the committed shape. The raw
// export carries far more (stats, descriptions, set ids); a field with no
// consumer in this terminal would be storage, not catalogue.
function normalizeCatalogEntry(raw: RawEntry): CatalogItem {
  const itemId = requirePositiveInt(raw.id, "id");
  if (typeof raw.name !== "string" || raw.name === "") {
    throw new Error(`Catalogue item ${itemId} has no name`);
  }
  if (typeof raw.cls !== "number" || !Number.isInteger(raw.cls)) {
    throw new Error(`Catalogue item ${itemId} has no integer class`);
  }
  if (typeof raw.sub !== "number" || !Number.isInteger(raw.sub)) {
    throw new Error(`Catalogue item ${itemId} has no integer subclass`);
  }
  const quality = requireNonNegativeInt(raw.q, `items[${itemId}].q`);
  const taxonomy = itemTaxonomy({
    cls: raw.cls,
    sub: raw.sub,
    armorType: optionalString(raw.armor_type, `items[${itemId}].armor_type`),
    weaponType: optionalString(raw.weapon_type, `items[${itemId}].weapon_type`)
  });
  const typeLabel = optionalString(raw.armor_type, `items[${itemId}].armor_type`)
    ?? optionalString(raw.weapon_type, `items[${itemId}].weapon_type`);
  return {
    itemId,
    name: raw.name,
    quality: qualityName(quality),
    category: taxonomy.category,
    subCategory: taxonomy.subCategory,
    // The public export omits `sell` when the client has no vendor value;
    // for a catalogue item that is a complete answer (unsellable), not a
    // missing read. Scan-only items are the ones that carry null.
    vendorPrice: raw.sell === undefined || raw.sell === null
      ? 0
      : (() => {
          if (typeof raw.sell !== "number" || !Number.isFinite(raw.sell) || raw.sell < 0) {
            throw new Error(`Catalogue item ${itemId} has an invalid sell price ${JSON.stringify(raw.sell)}`);
          }
          return raw.sell;
        })(),
    iconId: requirePositiveInt(raw.icon, `items[${itemId}].icon`),
    itemLevel: optionalNonNegativeInt(raw.ilvl, `items[${itemId}].ilvl`),
    requiredLevel: optionalNonNegativeInt(raw.req, `items[${itemId}].req`),
    slot: optionalString(raw.slot, `items[${itemId}].slot`),
    typeLabel
  };
}

export function normalizeCatalogDataset(
  raw: unknown,
  meta: { build: string; fetchedAt: string }
): CatalogDataset {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Catalogue payload must be an object");
  }
  const items: CatalogItem[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      throw new Error(`Catalogue entry ${key} must be an object`);
    }
    const entry = value as RawEntry;
    // The public export hides 1,887 records behind "未公开物品 #<id>" and
    // omits their quality, level and vendor fields. Importing a masked
    // record would replace one placeholder with another and claim facts the
    // export does not carry; those ids stay scan-only.
    if (entry.hidden === true) continue;
    const item = normalizeCatalogEntry(entry);
    if (String(item.itemId) !== key) {
      throw new Error(`Catalogue entry ${key} claims item id ${item.itemId}`);
    }
    items.push(item);
  }
  if (items.length === 0) throw new Error("Catalogue payload has no items");
  return {
    source: CATALOG_SOURCE,
    build: meta.build,
    fetchedAt: meta.fetchedAt,
    items: items.sort((left, right) => left.itemId - right.itemId)
  };
}

// Validates the committed dataset. A hand-edited or truncated file must
// fail loudly here instead of writing half a catalogue.
export function parseCatalogDataset(raw: unknown): CatalogDataset {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Catalogue dataset must be an object");
  }
  const dataset = raw as Record<string, unknown>;
  if (dataset.source !== CATALOG_SOURCE) {
    throw new Error(`Catalogue dataset source must be ${CATALOG_SOURCE}, got ${JSON.stringify(dataset.source)}`);
  }
  if (typeof dataset.build !== "string" || dataset.build === "") {
    throw new Error("Catalogue dataset must name its client build");
  }
  if (typeof dataset.fetchedAt !== "string" || Number.isNaN(Date.parse(dataset.fetchedAt))) {
    throw new Error("Catalogue dataset must carry a valid fetchedAt timestamp");
  }
  if (!Array.isArray(dataset.items) || dataset.items.length === 0) {
    throw new Error("Catalogue dataset must contain items");
  }
  const seen = new Set<number>();
  const items = dataset.items.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Catalogue item must be an object");
    }
    const row = entry as Record<string, unknown>;
    const itemId = requirePositiveInt(row.itemId, "itemId");
    if (seen.has(itemId)) throw new Error(`Catalogue dataset repeats item ${itemId}`);
    seen.add(itemId);
    if (typeof row.name !== "string" || row.name === "") throw new Error(`Catalogue item ${itemId} has no name`);
    if (typeof row.quality !== "string" || row.quality === "") throw new Error(`Catalogue item ${itemId} has no quality`);
    if (typeof row.category !== "string" || row.category === "") throw new Error(`Catalogue item ${itemId} has no category`);
    if (typeof row.subCategory !== "string" || row.subCategory === "") throw new Error(`Catalogue item ${itemId} has no subcategory`);
    if (typeof row.vendorPrice !== "number" || !Number.isFinite(row.vendorPrice) || row.vendorPrice < 0) {
      throw new Error(`Catalogue item ${itemId} has an invalid vendor price`);
    }
    return {
      itemId,
      name: row.name,
      quality: row.quality,
      category: row.category,
      subCategory: row.subCategory,
      vendorPrice: row.vendorPrice,
      iconId: requirePositiveInt(row.iconId, `item ${itemId} iconId`),
      itemLevel: optionalNonNegativeInt(row.itemLevel, `item ${itemId} itemLevel`),
      requiredLevel: optionalNonNegativeInt(row.requiredLevel, `item ${itemId} requiredLevel`),
      slot: optionalString(row.slot, `item ${itemId} slot`),
      typeLabel: optionalString(row.typeLabel, `item ${itemId} typeLabel`)
    };
  });
  return {
    source: CATALOG_SOURCE,
    build: dataset.build,
    fetchedAt: dataset.fetchedAt,
    items
  };
}

type ExistingCatalogRow = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
  iconId: number | null;
  itemLevel: number | null;
  requiredLevel: number | null;
  slot: string | null;
  typeLabel: string | null;
  catalogSource: string;
  catalogBuild: string | null;
};

type CatalogDiff = {
  creates: CatalogItem[];
  updates: Array<{ itemId: number; data: CatalogItem & { catalogSource: string; catalogBuild: string; catalogUpdatedAt: Date } }>;
};

// Only rows whose facts actually moved are written. A catalogue refresh
// touches a handful of names and prices, not all eighteen thousand rows.
export function diffCatalog(
  catalog: CatalogItem[],
  existing: ExistingCatalogRow[],
  build: string,
  updatedAt: Date
): CatalogDiff {
  const byId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: CatalogItem[] = [];
  const updates: CatalogDiff["updates"] = [];
  for (const item of catalog) {
    const current = byId.get(item.itemId);
    if (!current) {
      creates.push(item);
      continue;
    }
    const changed = current.name !== item.name
      || current.quality !== item.quality
      || current.category !== item.category
      || current.subCategory !== item.subCategory
      || current.vendorPrice !== item.vendorPrice
      || current.iconId !== item.iconId
      || current.itemLevel !== item.itemLevel
      || current.requiredLevel !== item.requiredLevel
      || current.slot !== item.slot
      || current.typeLabel !== item.typeLabel
      || current.catalogSource !== CATALOG_SOURCE
      || current.catalogBuild !== build;
    if (changed) {
      updates.push({
        itemId: item.itemId,
        data: { ...item, catalogSource: CATALOG_SOURCE, catalogBuild: build, catalogUpdatedAt: updatedAt }
      });
    }
  }
  return { creates, updates };
}

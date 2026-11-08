// A scan observes the market; the client catalogue owns what an item is.
// For a catalogue-owned row a scan writes nothing but the quote. For an id
// the catalogue does not know, the scan may create a placeholder and fill
// it in when the client later loads the record. The distinction is carried
// by `catalogSource`, never by guessing from an empty field.
import type { AddonScanItem } from "@/lib/addon-scan";
import { CATALOG_SOURCE } from "@/lib/item-catalog";
import { placeholderItemName } from "@/lib/item-name";

type ExistingItemRow = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
  catalogSource: string;
};

type ScanItemCreate = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
  catalogSource: string;
};

type ScanItemUpdateData = {
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number | null;
};

export function ensureScanItems(items: AddonScanItem[], existing: ExistingItemRow[]) {
  const existingByItemId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: ScanItemCreate[] = [];
  const updates: Array<{ itemId: number; data: ScanItemUpdateData }> = [];
  for (const item of items) {
    const current = existingByItemId.get(item.itemId);
    // A lazy-loaded record reports an empty name, "unknown" class and a
    // zero vendor price. None of those is a fact about the item.
    const unresolved = item.category === "unknown";
    if (!current) {
      creates.push({
        itemId: item.itemId,
        name: item.name === "" ? placeholderItemName(item.itemId) : item.name,
        quality: item.quality,
        category: item.category,
        subCategory: item.subCategory,
        // Unresolved means "not read yet" (null); a resolved zero means the
        // item is genuinely unsellable to vendors.
        vendorPrice: unresolved ? null : item.vendorPrice,
        catalogSource: "scan"
      });
      continue;
    }
    // The catalogue already answered every static question. A scan must not
    // overwrite a translation, a quality or a vendor price it merely failed
    // to load this time.
    if (current.catalogSource === CATALOG_SOURCE) continue;
    const name = item.name === "" ? current.name : item.name;
    const quality = item.quality === "unknown" ? current.quality : item.quality;
    const category = unresolved ? current.category : item.category;
    const subCategory = unresolved ? current.subCategory : item.subCategory;
    const vendorPrice = unresolved ? current.vendorPrice : item.vendorPrice;
    if (
      current.name !== name
      || current.quality !== quality
      || current.category !== category
      || current.subCategory !== subCategory
      || current.vendorPrice !== vendorPrice
    ) {
      updates.push({
        itemId: item.itemId,
        data: { name, quality, category, subCategory, vendorPrice }
      });
    }
  }
  return { creates, updates };
}

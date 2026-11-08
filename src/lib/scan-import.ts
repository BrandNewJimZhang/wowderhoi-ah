// Splits a validated scan into item-table writes. Existing rows only get
// an update when name or quality actually changed (translations or data
// fixes), so the routine import path issues zero per-item statements.
import type { AddonScanItem } from "@/lib/addon-scan";
import { placeholderItemName } from "@/lib/item-name";

type ExistingItemRow = {
  itemId: number;
  name: string;
  quality: string;
  category: string;
  subCategory: string;
  vendorPrice: number;
};

export function diffScanItems(items: AddonScanItem[], existing: ExistingItemRow[]) {
  const existingByItemId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: Array<{ itemId: number; name: string; quality: string; category: string; subCategory: string; vendorPrice: number }> = [];
  const updates: Array<{ itemId: number; data: { name: string; quality: string; category: string; subCategory: string; vendorPrice: number } }> = [];
  for (const item of items) {
    const current = existingByItemId.get(item.itemId);
    if (!current) {
      creates.push({
        itemId: item.itemId,
        // The client names items lazily; an unnamed observation is still real
        // market data. A stable placeholder keeps the row addressable until
        // a later scan resolves the name.
        name: item.name === "" ? placeholderItemName(item.itemId) : item.name,
        quality: item.quality,
        category: item.category,
        subCategory: item.subCategory,
        vendorPrice: item.vendorPrice
      });
    } else {
      // Item data arrives lazily in the modern client: a scan can report
      // an empty name, "unknown" class, quality and a zero vendor price
      // before the item record loads. Never let an unresolved field
      // overwrite known data, but do let a later loaded record fix an
      // earlier unknown.
      const unresolved = item.category === "unknown";
      const name = item.name === "" ? current.name : item.name;
      const quality = item.quality === "unknown" ? current.quality : item.quality;
      const category = unresolved ? current.category : item.category;
      const subCategory = unresolved ? current.subCategory : item.subCategory;
      const vendorPrice = unresolved && current.vendorPrice > 0 ? current.vendorPrice : item.vendorPrice;
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
  }
  return { creates, updates };
}

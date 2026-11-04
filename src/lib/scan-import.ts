// Splits a validated scan into item-table writes. Existing rows only get
// an update when name or quality actually changed (translations or data
// fixes), so the routine import path issues zero per-item statements.
import type { AddonScanItem } from "@/lib/addon-scan";

export type ExistingItemRow = {
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
        name: item.name,
        quality: item.quality,
        category: item.category,
        subCategory: item.subCategory,
        vendorPrice: item.vendorPrice
      });
    } else {
      // Item data arrives lazily in the modern client: a scan can report
      // "unknown" before the item record loads, and that miss reports a zero
      // vendor price too. Never let an unresolved row overwrite known data,
      // but do let a later loaded record fix an earlier unknown.
      const unresolved = item.category === "unknown";
      const category = unresolved ? current.category : item.category;
      const subCategory = unresolved ? current.subCategory : item.subCategory;
      const vendorPrice = unresolved && current.vendorPrice > 0 ? current.vendorPrice : item.vendorPrice;
      if (
        current.name !== item.name
        || current.quality !== item.quality
        || current.category !== category
        || current.subCategory !== subCategory
        || current.vendorPrice !== vendorPrice
      ) {
        updates.push({
          itemId: item.itemId,
          data: { name: item.name, quality: item.quality, category, subCategory, vendorPrice }
        });
      }
    }
  }
  return { creates, updates };
}

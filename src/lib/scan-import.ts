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
      // Class data arrives lazily in the modern client: a scan can report
      // "unknown" before the item record loads. Never let that overwrite a
      // known class, but do let a later loaded class fix an earlier unknown.
      const category = item.category === "unknown" ? current.category : item.category;
      const subCategory = item.subCategory === "unknown" ? current.subCategory : item.subCategory;
      if (
        current.name !== item.name
        || current.quality !== item.quality
        || current.category !== category
        || current.subCategory !== subCategory
        || current.vendorPrice !== item.vendorPrice
      ) {
        updates.push({
          itemId: item.itemId,
          data: { name: item.name, quality: item.quality, category, subCategory, vendorPrice: item.vendorPrice }
        });
      }
    }
  }
  return { creates, updates };
}

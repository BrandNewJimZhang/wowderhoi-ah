// Splits a validated scan into item-table writes. Existing rows only get
// an update when name or quality actually changed (translations or data
// fixes), so the routine import path issues zero per-item statements.
import type { AddonScanItem } from "@/lib/addon-scan";

export type ExistingItemRow = { itemId: number; name: string; quality: string; vendorPrice: number };

export function diffScanItems(items: AddonScanItem[], existing: ExistingItemRow[]) {
  const existingByItemId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: Array<{ itemId: number; name: string; quality: string; category: string; subCategory: string; vendorPrice: number }> = [];
  const updates: Array<{ itemId: number; data: { name: string; quality: string; vendorPrice: number } }> = [];
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
    } else if (current.name !== item.name || current.quality !== item.quality || current.vendorPrice !== item.vendorPrice) {
      updates.push({ itemId: item.itemId, data: { name: item.name, quality: item.quality, vendorPrice: item.vendorPrice } });
    }
  }
  return { creates, updates };
}

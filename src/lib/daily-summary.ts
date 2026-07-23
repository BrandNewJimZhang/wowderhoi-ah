// Folds one addon scan into the day's OHLCV rows. The import route is the
// single caller and writer; DailySummary feeds every chart, moving average,
// and seasonality view, so scans must land here or the terminal stays empty.

type ScanPriceRow = { itemId: number; marketPrice: number; quantity: number };
type ExistingDayRow = { itemId: number; highPrice: number; lowPrice: number };

export function mergeScanIntoDailySummaries(items: ScanPriceRow[], scannedAt: Date, existing: ExistingDayRow[]) {
  const date = new Date(Date.UTC(scannedAt.getUTCFullYear(), scannedAt.getUTCMonth(), scannedAt.getUTCDate()));
  const existingByItemId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: Array<{ itemId: number; date: Date; openPrice: number; closePrice: number; highPrice: number; lowPrice: number; volume: number }> = [];
  const updates: Array<{ itemId: number; data: { closePrice: number; highPrice: number; lowPrice: number; volume: number } }> = [];
  for (const item of items) {
    const current = existingByItemId.get(item.itemId);
    if (!current) {
      creates.push({
        itemId: item.itemId,
        date,
        openPrice: item.marketPrice,
        closePrice: item.marketPrice,
        highPrice: item.marketPrice,
        lowPrice: item.marketPrice,
        // volume proxies listed supply from the latest scan; true traded
        // volume needs sale tracking the AH API does not expose.
        volume: item.quantity
      });
    } else {
      updates.push({
        itemId: item.itemId,
        data: {
          closePrice: item.marketPrice,
          highPrice: Math.max(current.highPrice, item.marketPrice),
          lowPrice: Math.min(current.lowPrice, item.marketPrice),
          volume: item.quantity
        }
      });
    }
  }
  return { date, creates, updates };
}

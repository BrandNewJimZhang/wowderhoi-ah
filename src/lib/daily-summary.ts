// Folds one addon scan into the day's OHLCV rows. The import route is the
// single caller and writer; DailySummary feeds every chart, moving average,
// and seasonality view, so scans must land here or the terminal stays empty.

// OHLC is built from the sell front, the price a seller can actually
// list at. P10 remains on the snapshot for statistics, not for the daily
// series.
type ScanPriceRow = { itemId: number; sellPrice: number; quantity: number };
type ExistingDayRow = { itemId: number; highPrice: number; lowPrice: number };

export function mergeScanIntoDailySummaries(items: ScanPriceRow[], scannedAt: Date, marketId: string, existing: ExistingDayRow[]) {
  const date = new Date(Date.UTC(scannedAt.getUTCFullYear(), scannedAt.getUTCMonth(), scannedAt.getUTCDate()));
  const existingByItemId = new Map(existing.map((row) => [row.itemId, row]));
  const creates: Array<{ itemId: number; marketId: string; date: Date; openPrice: number; closePrice: number; highPrice: number; lowPrice: number; volume: number }> = [];
  const updates: Array<{ itemId: number; data: { closePrice: number; highPrice: number; lowPrice: number; volume: number } }> = [];
  for (const item of items) {
    const current = existingByItemId.get(item.itemId);
    if (!current) {
      creates.push({
        itemId: item.itemId,
        marketId,
        date,
        openPrice: item.sellPrice,
        closePrice: item.sellPrice,
        highPrice: item.sellPrice,
        lowPrice: item.sellPrice,
        // volume proxies listed supply from the latest scan; true traded
        // volume needs sale tracking the AH API does not expose.
        volume: item.quantity
      });
    } else {
      updates.push({
        itemId: item.itemId,
        data: {
          closePrice: item.sellPrice,
          highPrice: Math.max(current.highPrice, item.sellPrice),
          lowPrice: Math.min(current.lowPrice, item.sellPrice),
          volume: item.quantity
        }
      });
    }
  }
  return { date, creates, updates };
}

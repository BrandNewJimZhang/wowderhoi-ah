import { describe, expect, it } from "vitest";
import { mergeScanIntoDailySummaries } from "@/lib/daily-summary";

const scannedAt = new Date("2026-07-23T14:30:00Z");

describe("mergeScanIntoDailySummaries", () => {
  it("creates OHLCV rows for items without a summary today", () => {
    const { date, creates, updates } = mergeScanIntoDailySummaries(
      [{ itemId: 2770, marketPrice: 210, quantity: 240 }],
      scannedAt,
      []
    );
    expect(date).toEqual(new Date("2026-07-23T00:00:00Z"));
    expect(updates).toHaveLength(0);
    expect(creates).toEqual([
      { itemId: 2770, date, openPrice: 210, closePrice: 210, highPrice: 210, lowPrice: 210, volume: 240 }
    ]);
  });

  it("updates close and stretches high/low for repeat scans in a day", () => {
    const { creates, updates } = mergeScanIntoDailySummaries(
      [
        { itemId: 2770, marketPrice: 180, quantity: 300 }, // dipped below existing low
        { itemId: 13468, marketPrice: 999999, quantity: 2 } // new item mid-day
      ],
      scannedAt,
      [{ itemId: 2770, highPrice: 220, lowPrice: 200 }]
    );
    expect(creates.map((row) => row.itemId)).toEqual([13468]);
    expect(updates).toEqual([
      { itemId: 2770, data: { closePrice: 180, highPrice: 220, lowPrice: 180, volume: 300 } }
    ]);
  });
});

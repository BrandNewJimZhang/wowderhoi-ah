import { describe, expect, it } from "vitest";
import { describeFreshness, nextLabelChangeAt, scanGapHint, staleScanHint } from "@/lib/freshness";
import { SCAN_INTERVAL_MINUTES, SCAN_STALE_MINUTES } from "@/lib/market-rules";

const now = new Date("2026-07-24T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

describe("describeFreshness", () => {
  it("reports missing data as stale", () => {
    expect(describeFreshness(null, now)).toEqual({ label: "无数据", stale: true });
  });

  it("labels sub-minute data as just now", () => {
    expect(describeFreshness(minutesAgo(0), now)).toEqual({ label: "刚刚", stale: false });
  });

  it("flips stale at the compiled threshold shared with the addon", () => {
    expect(describeFreshness(minutesAgo(15), now)).toEqual({ label: "15 分钟前", stale: false });
    expect(describeFreshness(minutesAgo(30), now)).toEqual({ label: "30 分钟前", stale: true });
    expect(describeFreshness(minutesAgo(90), now)).toEqual({ label: "1 小时前", stale: true });
    expect(describeFreshness(minutesAgo(3 * 60), now)).toEqual({ label: "3 小时前", stale: true });
  });

  it("labels days as always stale", () => {
    expect(describeFreshness(minutesAgo(2 * 24 * 60), now)).toEqual({ label: "2 天前", stale: true });
  });
});

describe("staleScanHint", () => {
  it("names the threshold that marks a scan stale, not the scan cadence", () => {
    expect(staleScanHint()).toContain(`${SCAN_STALE_MINUTES} 分钟`);
    expect(staleScanHint()).toContain("/wahscan");
  });
});

describe("scanGapHint", () => {
  it("speaks only once at least two scan intervals are missing", () => {
    expect(scanGapHint(null)).toBeNull();
    expect(scanGapHint(SCAN_INTERVAL_MINUTES)).toBeNull();
    expect(scanGapHint(2 * SCAN_INTERVAL_MINUTES)).toBeNull();
    expect(scanGapHint(2 * SCAN_INTERVAL_MINUTES + 1)).toContain("超过 2 个扫描间隔");
  });
});

describe("nextLabelChangeAt", () => {
  it("has no schedule without a timestamp", () => {
    expect(nextLabelChangeAt(null, now)).toBeNull();
  });

  it("ticks when the just-now label becomes a minute", () => {
    const latest = new Date(now.getTime() - 30_000);
    expect(nextLabelChangeAt(latest, now)).toEqual(new Date(latest.getTime() + 60_000));
  });

  it("ticks every minute within the hour bracket", () => {
    const latest = minutesAgo(5);
    expect(nextLabelChangeAt(latest, now)).toEqual(new Date(latest.getTime() + 6 * 60_000));
  });

  it("ticks on the hour once the label counts hours", () => {
    const latest = minutesAgo(90);
    expect(nextLabelChangeAt(latest, now)).toEqual(new Date(latest.getTime() + 2 * 3_600_000));
  });

  it("ticks on the day once the label counts days", () => {
    const latest = minutesAgo(25 * 60);
    expect(nextLabelChangeAt(latest, now)).toEqual(new Date(latest.getTime() + 2 * 86_400_000));
  });

  it("schedules the following boundary when called exactly on one", () => {
    expect(nextLabelChangeAt(minutesAgo(5), now)).toEqual(new Date(now.getTime() + 60_000));
  });

  it("covers the stale flip inside the minute bracket", () => {
    const latest = new Date(now.getTime() - (SCAN_STALE_MINUTES * 60_000 - 30_000));
    const at = nextLabelChangeAt(latest, now);
    expect(at).not.toBeNull();
    expect(describeFreshness(latest, new Date(at!.getTime() - 1)).stale).toBe(false);
    expect(describeFreshness(latest, at!).stale).toBe(true);
  });
});

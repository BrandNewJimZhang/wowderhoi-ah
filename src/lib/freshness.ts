// Data freshness label for scan timestamps. The terminal must make
// "how old is this data" visible everywhere prices render. The threshold is
// the compiled market rule, shared with the in-game tooltip: the same scan
// must not read expired in game and fresh in the terminal.
import { SCAN_INTERVAL_MINUTES, SCAN_STALE_MINUTES } from "@/lib/market-rules";

type Freshness = { label: string; stale: boolean };

// The banner every stale page shows. It names the threshold `describeFreshness`
// applies, not the scan cadence: restating the cadence in the text told the
// player 15 minutes while the flag only flips at 30.
export function staleScanHint(): string {
  return `最新扫描已超过 ${SCAN_STALE_MINUTES} 分钟；进游戏 /wahscan。`;
}

// Two missing scans in a row is the point where the interval is no longer
// jitter. The pages used to carry the threshold and its sentence separately,
// so the cockpit and the health page described the same gap differently.
export function scanGapHint(gapMinutes: number | null): string | null {
  if (gapMinutes === null || gapMinutes <= 2 * SCAN_INTERVAL_MINUTES) return null;
  return `扫描缺口 ${gapMinutes} 分钟，超过 2 个扫描间隔。`;
}

export function describeFreshness(latest: Date | null, now: Date): Freshness {
  if (!latest) return { label: "无数据", stale: true };
  const minutes = Math.floor((now.getTime() - latest.getTime()) / 60_000);
  const stale = minutes >= SCAN_STALE_MINUTES;
  if (minutes < 1) return { label: "刚刚", stale };
  if (minutes < 60) return { label: `${minutes} 分钟前`, stale };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { label: `${hours} 小时前`, stale };
  return { label: `${Math.floor(hours / 24)} 天前`, stale };
}

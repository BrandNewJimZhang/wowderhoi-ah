// Data freshness label for scan timestamps. The terminal must make
// "how old is this data" visible everywhere prices render. The threshold is
// the compiled market rule, shared with the in-game tooltip: the same scan
// must not read expired in game and fresh in the terminal.
import { SCAN_STALE_MINUTES } from "@/lib/market-rules";

type Freshness = { label: string; stale: boolean };

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

"use client";

import { useEffect, useState } from "react";
import { describeFreshness, nextLabelChangeAt } from "@/lib/freshness";

// A relative label is a function of the data and the clock, not of the
// data. Rendering it once on the server freezes it until the next import;
// refreshing the page every minute to move a label would re-read the whole
// market instead. This component starts from the server's value so the
// first paint matches, then ticks at the boundaries describeFreshness uses.
export function FreshnessLabel({ at, initialLabel, initialStale, prefix, staleClassName, liveClassName }: {
  // Observation time in epoch milliseconds; null means there is no data.
  at: number | null;
  initialLabel: string;
  initialStale: boolean;
  prefix?: string;
  staleClassName?: string;
  liveClassName?: string;
}) {
  const [freshness, setFreshness] = useState({ label: initialLabel, stale: initialStale });

  useEffect(() => {
    if (at === null) return;
    const atMs: number = at;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule() {
      // A hidden tab has nobody reading the label; the visibility handler
      // recomputes and reschedules when it returns.
      if (document.visibilityState === "hidden") return;
      const now = new Date();
      const nextAt = nextLabelChangeAt(new Date(atMs), now);
      if (nextAt === null) return;
      timer = setTimeout(tick, Math.max(1_000, nextAt.getTime() - now.getTime()));
    }

    function tick() {
      const now = new Date();
      setFreshness(describeFreshness(new Date(atMs), now));
      schedule();
    }

    // Correct any drift between the server render and hydration without
    // waiting for the next boundary.
    timer = setTimeout(tick, 0);

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [at]);

  const text = prefix ? `${prefix}${freshness.label}` : freshness.label;
  if (!staleClassName && !liveClassName) return <>{text}</>;
  return <span className={freshness.stale ? staleClassName : liveClassName}>{text}</span>;
}

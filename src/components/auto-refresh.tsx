"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pollRevision } from "@/lib/revision-poll";

// The auction house turns over faster than a reader reloads the page. Every
// open page polls one opaque revision; when an import lands, the server
// components re-render through router.refresh(), which keeps the client
// state (filters, sort, page) of components like the market browser.
const POLL_INTERVAL_MS = 15_000;
// A hung revision request must not stop the timer while the status still
// claims the refresh is live. Timeouts degrade to offline like any failure.
const REQUEST_TIMEOUT_MS = 8_000;
// The server computes the boundary from its clock; by the time it arrives
// the moment may already have passed. Keep the timer from spinning.
const MIN_BOUNDARY_DELAY_MS = 1_000;

export function AutoRefresh({ revision, nextRefreshInMs }: {
  revision: string;
  nextRefreshInMs: number | null;
}) {
  const router = useRouter();
  const renderedRevision = useRef(revision);
  const [offline, setOffline] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const refreshingRef = useRef(false);
  const reportedFailure = useRef(false);

  // A completed refresh renders a new revision prop; the poll baseline
  // follows it so the same import is never refreshed twice.
  useEffect(() => {
    renderedRevision.current = revision;
  }, [revision]);

  // The revision poll and the time boundary are two reasons to do the same
  // work. One in-flight guard keeps the same moment from starting both.
  useEffect(() => {
    if (!refreshing) refreshingRef.current = false;
  }, [refreshing]);

  const requestRefresh = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    startRefresh(() => { router.refresh(); });
  }, [router, startRefresh]);

  useEffect(() => {
    let stopped = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let boundaryDue: number | null = nextRefreshInMs === null
      ? null
      : Date.now() + Math.max(MIN_BOUNDARY_DELAY_MS, nextRefreshInMs);

    const schedulePoll = () => {
      if (stopped) return;
      pollTimer = setTimeout(() => { void check(); }, POLL_INTERVAL_MS);
    };

    async function check() {
      if (stopped || polling) return;
      // A hidden tab has nobody reading it; check again when it returns.
      if (document.visibilityState === "hidden") {
        schedulePoll();
        return;
      }
      polling = true;
      const result = await pollRevision(renderedRevision.current, () =>
        fetch("/api/market/revision", {
          cache: "no-store",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
      );
      polling = false;
      if (stopped) return;
      if (result.outcome === "stale") {
        reportedFailure.current = false;
        setOffline(false);
        // The baseline advances only when the refreshed render carries the
        // new revision. Advancing it here would silence the retry if that
        // render fails, leaving the page on old data until the next import.
        requestRefresh();
      } else if (result.outcome === "fresh") {
        reportedFailure.current = false;
        setOffline(false);
      } else {
        if (!reportedFailure.current) console.error("Auto-refresh check failed:", result.error);
        reportedFailure.current = true;
        setOffline(true);
      }
      schedulePoll();
    }

    // The stale flag and the display phase are rendered on the server, so
    // crossing their boundary needs a server render even though no import
    // landed. The next render carries a new boundary and reschedules.
    const onBoundary = () => {
      if (stopped || boundaryDue === null) return;
      // A hidden tab refreshes when it becomes visible again; spending the
      // render for a reader who is not there serves nobody.
      if (document.visibilityState === "hidden") return;
      boundaryDue = null;
      requestRefresh();
    };
    if (boundaryDue !== null) {
      boundaryTimer = setTimeout(onBoundary, Math.max(0, boundaryDue - Date.now()));
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (boundaryDue !== null && Date.now() >= boundaryDue) onBoundary();
      if (pollTimer) clearTimeout(pollTimer);
      void check();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void check();
    return () => {
      stopped = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (boundaryTimer) clearTimeout(boundaryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [nextRefreshInMs, requestRefresh]);

  const status = offline ? "offline" : refreshing ? "refreshing" : "live";
  const dot = status === "live"
    ? "bg-terminal-green"
    : status === "refreshing" ? "bg-terminal-amber animate-pulse" : "bg-terminal-red";
  const label = status === "live"
    ? `自动刷新 · ${POLL_INTERVAL_MS / 1000}s`
    : status === "refreshing" ? "刷新中" : "自动刷新中断 · 重试中";

  return (
    <div
      className="mt-2 flex items-center gap-1.5 border-t border-terminal-border px-3 pt-2 font-mono text-[10px] text-terminal-muted lg:mt-auto"
      role="status"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span>{label}</span>
    </div>
  );
}

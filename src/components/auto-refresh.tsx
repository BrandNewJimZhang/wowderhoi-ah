"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { pollRevision } from "@/lib/revision-poll";

// The auction house turns over faster than a reader reloads the page. Every
// open page polls one opaque revision; when an import lands, the server
// components re-render through router.refresh(), which keeps the client
// state (filters, sort, page) of components like the market browser.
const POLL_INTERVAL_MS = 15_000;

export function AutoRefresh({ revision }: { revision: string }) {
  const router = useRouter();
  const renderedRevision = useRef(revision);
  const [offline, setOffline] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const reportedFailure = useRef(false);

  // A completed refresh renders a new revision prop; the poll baseline
  // follows it so the same import is never refreshed twice.
  useEffect(() => {
    renderedRevision.current = revision;
  }, [revision]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => { void check(); }, POLL_INTERVAL_MS);
    };

    async function check() {
      if (stopped) return;
      // A hidden tab has nobody reading it; check again when it returns.
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      const result = await pollRevision(renderedRevision.current, () =>
        fetch("/api/market/revision", { cache: "no-store" })
      );
      if (stopped) return;
      if (result.outcome === "stale") {
        reportedFailure.current = false;
        setOffline(false);
        renderedRevision.current = result.revision;
        startRefresh(() => { router.refresh(); });
      } else if (result.outcome === "fresh") {
        reportedFailure.current = false;
        setOffline(false);
      } else {
        if (!reportedFailure.current) console.error("Auto-refresh check failed:", result.error);
        reportedFailure.current = true;
        setOffline(true);
      }
      schedule();
    }

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void check();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router, startRefresh]);

  const status = offline ? "offline" : refreshing ? "refreshing" : "live";
  const dot = status === "live"
    ? "bg-terminal-green"
    : status === "refreshing" ? "bg-terminal-amber animate-pulse" : "bg-terminal-red";
  const label = status === "live"
    ? `自动刷新 · ${POLL_INTERVAL_MS / 1000}s`
    : status === "refreshing" ? "发现新数据 · 刷新中" : "自动刷新中断 · 重试中";

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

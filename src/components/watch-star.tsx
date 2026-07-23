"use client";

import { useTransition } from "react";
import { toggleWatchlist } from "@/app/actions";

export function WatchStar({ itemId, watched }: { itemId: number; watched: boolean }) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      onClick={() => startTransition(() => toggleWatchlist(itemId))}
      disabled={pending}
      title={watched ? "移出关注" : "加入关注"}
      className={watched ? "text-terminal-amber" : "text-terminal-muted hover:text-slate-300"}
    >
      {watched ? "★" : "☆"}
    </button>
  );
}

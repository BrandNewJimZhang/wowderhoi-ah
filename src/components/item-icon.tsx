"use client";

import { useState } from "react";

// Wowhead-style item icon served from public/icons/<itemId>.jpg —
// populated once by `npm run icons:fetch` (self-hosted, no runtime
// external requests). Hides itself when the icon is not cached yet.
export function ItemIcon({ itemId, size = 20 }: { itemId: number; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny local static file
    <img
      src={`/icons/${itemId}.jpg`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailed(true)}
      className="inline-block rounded-sm border border-terminal-border align-middle"
    />
  );
}

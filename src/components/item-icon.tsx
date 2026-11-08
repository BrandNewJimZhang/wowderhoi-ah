"use client";

import { useState } from "react";

// Icons are keyed by the client's shared icon id, not by item id: many
// items use one icon, and the catalogue exposes the id directly. Files are
// served from public/icons/<iconId>.webp by `npm run icons:fetch`; a
// missing file renders a same-size placeholder instead of shifting the row.
export function ItemIcon({ iconId, size = 20 }: { iconId?: number | null; size?: number }) {
  // Track which icon failed, not a boolean: a client-side navigation reuses
  // this component, and a cached failure would hide the next item's icon.
  const [failedIconId, setFailedIconId] = useState<number | null>(null);
  const placeholder = (
    <span
      className="inline-block rounded-sm border border-terminal-border bg-terminal-panel2 align-middle"
      style={{ width: size, height: size }}
    />
  );
  if (!iconId || failedIconId === iconId) return placeholder;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny local static file
    <img
      src={`/icons/${iconId}.webp`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailedIconId(iconId)}
      className="inline-block rounded-sm border border-terminal-border align-middle"
    />
  );
}

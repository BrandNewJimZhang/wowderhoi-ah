// WoW money arithmetic: copper -> gold/silver/copper. Rendering lives
// in components/coins.tsx (icons) and chart axes (formatWowMoney text).

export function splitCopper(totalCopper: number) {
  const absolute = Math.abs(Math.round(totalCopper));
  return {
    gold: Math.floor(absolute / 10000),
    silver: Math.floor((absolute % 10000) / 100),
    copper: absolute % 100
  };
}

export function formatWowMoney(totalCopper: number, options?: { compact?: boolean }) {
  const { gold, silver, copper } = splitCopper(totalCopper);
  const sign = totalCopper < 0 ? "-" : "";
  const parts: string[] = [];
  if (gold > 0) parts.push(`${gold}g`);
  // Compact mode (chart axes): drop sub-silver noise, and sub-gold
  // detail entirely once amounts reach triple-digit gold.
  if (options?.compact) {
    if (gold >= 100) return `${sign}${gold}g`;
    if (silver > 0) parts.push(`${silver}s`);
    if (parts.length === 0) parts.push(`${copper}c`);
    return sign + parts.join(" ");
  }
  if (silver > 0) parts.push(`${silver}s`);
  if (copper > 0 || parts.length === 0) parts.push(`${copper}c`);
  return sign + parts.join(" ");
}

// Canonical WoW item-quality colors as Tailwind classes (declared in
// tailwind.config.ts under colors.wow).

const classByQuality: Record<string, string> = {
  poor: "text-wow-poor",
  common: "text-wow-common",
  uncommon: "text-wow-uncommon",
  rare: "text-wow-rare",
  epic: "text-wow-epic",
  legendary: "text-wow-legendary"
};

export function qualityColorClass(quality: string): string {
  return classByQuality[quality] ?? "text-wow-common";
}

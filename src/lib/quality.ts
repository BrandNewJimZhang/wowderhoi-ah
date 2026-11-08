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

const labelByQuality: Record<string, string> = {
  poor: "粗糙",
  common: "普通",
  uncommon: "优秀",
  rare: "精良",
  epic: "史诗",
  legendary: "传说",
  artifact: "神器"
};

export function qualityLabel(quality: string): string {
  return labelByQuality[quality] ?? quality;
}

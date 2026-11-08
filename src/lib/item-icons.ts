// Icons are a catalogue property: the client shares one icon id across many
// items. Storing a copy per item id multiplied the same sprite twenty times
// and tied the files to item ids the catalogue already maps.
import type { CatalogItem } from "@/lib/item-catalog";

export const ICON_PATH = "public/icons";
export const MIN_ICON_BYTES = 500;

export function iconFileName(iconId: number): string {
  return `${iconId}.webp`;
}

export function iconUrl(iconId: number): string {
  return `https://wuxianwow.com/data/icons/${iconFileName(iconId)}`;
}

export function uniqueIconIds(items: CatalogItem[]): number[] {
  return Array.from(new Set(items.map((item) => item.iconId))).sort((left, right) => left - right);
}

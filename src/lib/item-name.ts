// The client names items lazily, so a scan can observe an item before its
// record is loaded. The stable `#<id>` marker keeps that row addressable and
// lets a later name fill replace it without guessing at an empty string.
export function placeholderItemName(itemId: number): string {
  return `#${itemId}`;
}

export function isPlaceholderItemName(name: string, itemId: number): boolean {
  return name === placeholderItemName(itemId);
}

// One search semantics for both runtimes. The addon implements the same
// rules in Core.lua (parseSearchQuery / searchScore / rankSearch); a shared
// fixture (data/search-parity.json) pins the two to the same order. The
// rules themselves cannot be shared across languages, so the fixture is the
// contract instead of a second prose copy that drifts.

export type ParsedSearchQuery = {
  text: string;
  // A numeric query or an item hyperlink id addresses one item directly.
  id: number | null;
  // Whitespace-separated tokens: every token must appear somewhere in the
  // name, in any order.
  tokens: string[];
};

export type SearchCandidate = {
  itemId: number;
  name: string;
  // A book the player can buy from outranks a bid-only observation at the
  // same name score.
  booked?: boolean;
  quantity?: number;
};

export function parseSearchQuery(raw: string): ParsedSearchQuery | null {
  const text = raw.trim().toLowerCase();
  if (text === "") return null;
  const linkId = /^item:(\d+)$/.exec(text);
  const id = /^\d+$/.test(text) ? Number(text) : linkId ? Number(linkId[1]) : null;
  return { text, id, tokens: text.split(/\s+/) };
}

// 4 exact, 3 prefix, 2 every token present, 1 substring. A miss is 0.
// Internal: rankSearch is the contract, and scoring alone has no consumer.
function searchScore(name: string, query: ParsedSearchQuery): number {
  if (!name || !query.text) return 0;
  const lower = name.toLowerCase();
  if (lower === query.text) return 4;
  if (lower.startsWith(query.text)) return 3;
  for (const token of query.tokens) {
    if (!lower.includes(token)) return 0;
  }
  return query.tokens.length > 1 ? 2 : 1;
}

// UTF-8 byte length, matching Lua's `#name` so the two runtimes break a
// name-length tie the same way even for non-ASCII names.
const encoder = new TextEncoder();
function nameBytes(name: string): number {
  return encoder.encode(name).length;
}

export function rankSearch<T extends SearchCandidate>(candidates: T[], raw: string): T[] {
  const query = parseSearchQuery(raw);
  if (!query) return [];
  const scored: Array<{ candidate: T; score: number }> = [];
  for (const candidate of candidates) {
    const score = query.id !== null && candidate.itemId === query.id
      ? 5
      : searchScore(candidate.name, query);
    if (score > 0) scored.push({ candidate, score });
  }
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    const leftCandidate = left.candidate;
    const rightCandidate = right.candidate;
    const booked = Number(Boolean(rightCandidate.booked)) - Number(Boolean(leftCandidate.booked));
    if (booked !== 0) return booked;
    const quantity = (rightCandidate.quantity ?? 0) - (leftCandidate.quantity ?? 0);
    if (quantity !== 0) return quantity;
    const length = nameBytes(leftCandidate.name) - nameBytes(rightCandidate.name);
    if (length !== 0) return length;
    return leftCandidate.itemId - rightCandidate.itemId;
  });
  return scored.map((entry) => entry.candidate);
}

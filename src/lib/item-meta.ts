export type ItemMeta = {
  name: string;
  icon: string;
};

// Wowhead answers with JSON on a normal request and with a region-block
// HTML page from blocked hosts, so every field is validated here once:
// callers treat null as "no usable record" and count it as a failure.
export function parseWowheadTooltip(payload: string): ItemMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { name, icon } = parsed as { name?: unknown; icon?: unknown };
  if (typeof name !== "string" || name === "") return null;
  if (typeof icon !== "string" || icon === "") return null;
  return { name, icon };
}

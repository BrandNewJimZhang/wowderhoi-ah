// One auto-refresh check, split from the browser so the decision is
// testable: a poll either confirms the rendered revision, names a newer one,
// or reports the check as offline. A failed check never counts as fresh —
// the page keeps polling and the status line says the refresh is broken.
export type RevisionPoll =
  | { outcome: "fresh" }
  | { outcome: "stale"; revision: string }
  | { outcome: "offline"; error: unknown };

export async function pollRevision(current: string, get: () => Promise<Response>): Promise<RevisionPoll> {
  let response: Response;
  try {
    response = await get();
  } catch (error) {
    return { outcome: "offline", error };
  }
  if (!response.ok) {
    return { outcome: "offline", error: new Error(`revision check failed (${response.status})`) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { outcome: "offline", error };
  }
  const revision = (body as { revision?: unknown } | null)?.revision;
  if (typeof revision !== "string") {
    return { outcome: "offline", error: new Error("revision response carries no revision") };
  }
  return revision === current ? { outcome: "fresh" } : { outcome: "stale", revision };
}

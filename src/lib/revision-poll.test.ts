// The browser poll is split from the fetch so the decision "is this a new
// revision or a broken check?" is testable without a DOM. A broken check
// degrades the status to offline and the next tick retries; it must never
// look like fresh data.
import { describe, expect, it } from "vitest";
import { pollRevision } from "@/lib/revision-poll";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("pollRevision", () => {
  it("reports fresh when the polled revision matches the rendered one", async () => {
    expect(await pollRevision("m1:run-1", async () => respond({ revision: "m1:run-1" })))
      .toEqual({ outcome: "fresh" });
  });

  it("reports a newer revision", async () => {
    expect(await pollRevision("m1:run-1", async () => respond({ revision: "m1:run-2" })))
      .toEqual({ outcome: "stale" });
  });

  it("reports offline on a failed response", async () => {
    const result = await pollRevision("m1:run-1", async () => respond({ error: "boom" }, 500));
    expect(result.outcome).toBe("offline");
  });

  it("reports offline when the response carries no revision", async () => {
    const result = await pollRevision("m1:run-1", async () => respond({}));
    expect(result.outcome).toBe("offline");
  });

  it("reports offline when the request itself rejects", async () => {
    const result = await pollRevision("m1:run-1", async () => {
      throw new Error("network down");
    });
    expect(result.outcome).toBe("offline");
  });

  it("reports offline when the request times out", async () => {
    // The browser fetch carries AbortSignal.timeout; an aborted request
    // rejects with a DOMException and must degrade like any other failure.
    const result = await pollRevision("m1:run-1", async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    expect(result.outcome).toBe("offline");
  });

  it("reports offline when the response body is not JSON", async () => {
    const result = await pollRevision("m1:run-1", async () => new Response("not json", { status: 200 }));
    expect(result.outcome).toBe("offline");
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSavedvarsImporter, startSavedvarsWatcher, type ImportResponse } from "@/lib/watcher/savedvars-watcher";

function savedVariables(options: { scannedAt?: number; events?: number; dropped?: number } = {}): string {
  const events = Array.from({ length: options.events ?? 0 }, (_, index) =>
    `[${index + 1}] = { ["k"] = "buy", ["t"] = ${index + 1}, ["itemId"] = 1, ["qty"] = 1, ["cost"] = 100 }`
  ).join(", ");
  return `
WoWderhoiAH_ScanData = {
  ["dataVersion"] = 4,
  ["scannedAt"] = ${options.scannedAt ?? 1721700000},
  ["server"] = "A",
  ["faction"] = "Alliance",
  ["items"] = { [1] = { ["name"] = "X", ["minPrice"] = 100 } },
}
WoWderhoiAH_Journal = {
  ["books"] = {
    ["A|Alliance|Tester"] = { ["e"] = { ${events} }, ["dropped"] = ${options.dropped ?? 0} },
  },
}
`;
}

function importer(
  content: () => string,
  post: () => Promise<{ status: number; body: ImportResponse }>,
  postState: () => Promise<{ status: number; body: ImportResponse }> = async () => ({ status: 200, body: { changed: true } })
) {
  const bodies: unknown[] = [];
  const stateBodies: unknown[] = [];
  const logs: string[] = [];
  const instance = createSavedvarsImporter({
    readFile: content,
    post: async (body) => {
      bodies.push(body);
      return await post();
    },
    postState: async (body) => {
      stateBodies.push(body);
      return await postState();
    },
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message)
  });
  return { instance, bodies, stateBodies, logs };
}

describe("createSavedvarsImporter", () => {
  it("posts a new scan and its state once, then idles until something moves", async () => {
    const { instance, bodies, stateBodies } = importer(
      () => savedVariables({ events: 1 }),
      async () => ({ status: 200, body: { imported: 1, positions: 0, trades: 0 } })
    );
    expect(await instance.tick()).toBe("imported");
    expect(bodies).toHaveLength(1);
    expect(stateBodies).toHaveLength(1);
    // The state domain names its market and carries only state; the scan
    // document is already delivered by the observation POST.
    expect(stateBodies[0]).toMatchObject({ server: "A", faction: "Alliance" });
    expect((stateBodies[0] as { scan?: unknown }).scan).toBeUndefined();
    expect(await instance.tick()).toBe("idle");
    expect(bodies).toHaveLength(1);
    expect(stateBodies).toHaveLength(1);
  });

  it("posts only state when the journal moves between scans", async () => {
    let events = 1;
    const { instance, bodies, stateBodies } = importer(
      () => savedVariables({ events }),
      async () => ({ status: 200, body: { imported: 1 } })
    );
    expect(await instance.tick()).toBe("imported");
    events = 2;
    expect(await instance.tick()).toBe("state");
    expect(bodies).toHaveLength(1);
    expect(stateBodies).toHaveLength(2);
    expect(await instance.tick()).toBe("idle");
  });

  it("posts state when the estate revision moves without a scan", async () => {
    let revision = 1;
    const { instance, stateBodies } = importer(
      () => `${savedVariables({ events: 1 })}
WoWderhoiAH_Estate = { ["revision"] = ${revision}, ["observedAt"] = 10, ["scopes"] = {} }
WoWderhoiAH_Plan = { ["revision"] = "A|Alliance|1:1:1" }
`,
      async () => ({ status: 200, body: { imported: 1 } })
    );
    expect(await instance.tick()).toBe("imported");
    revision = 2;
    expect(await instance.tick()).toBe("state");
    expect(stateBodies).toHaveLength(2);
  });

  it("does not advance the watermark when the POST fails", async () => {
    let status = 500;
    let calls = 0;
    const { instance } = importer(
      () => savedVariables({ events: 1 }),
      async () => {
        calls += 1;
        return { status, body: { error: "boom" } };
      }
    );
    await expect(instance.tick()).rejects.toThrow(/Import failed/);
    status = 200;
    expect(await instance.tick()).toBe("imported");
    expect(calls).toBe(2);
  });

  it("treats a 409 as already imported and stops retrying", async () => {
    let calls = 0;
    const { instance } = importer(
      () => savedVariables({ events: 1 }),
      async () => {
        calls += 1;
        return { status: 409, body: { error: "already imported" } };
      }
    );
    expect(await instance.tick()).toBe("duplicate");
    expect(await instance.tick()).toBe("idle");
    expect(calls).toBe(1);
  });

  it("retries a failed POST without waiting for the file to change", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wah-watcher-"));
    const path = join(dir, "WoWderhoiAH.lua");
    writeFileSync(path, savedVariables({ events: 1 }));
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? { status: 500, json: async () => ({ error: "boom" }) }
        : { status: 200, json: async () => ({ imported: 1, positions: 0, trades: 0 }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handle = startSavedvarsWatcher({ path, importUrl: "http://test/import", intervalMs: 20 });
    try {
      const deadline = Date.now() + 2000;
      while (fetchMock.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The file never changed, so the second POST can only come from the
      // retry after the failed import.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      handle.stop();
      vi.unstubAllGlobals();
      log.mockRestore();
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a file without a scan or from another pipeline", async () => {
    const missing = importer(() => "WoWderhoiAH_Journal = {}\n", async () => ({ status: 200, body: {} }));
    expect(await missing.instance.tick()).toBe("idle");
    expect(missing.bodies).toHaveLength(0);

    const stale = importer(
      () => savedVariables({ events: 1 }).replace('["dataVersion"] = 4', '["dataVersion"] = 3'),
      async () => ({ status: 200, body: {} })
    );
    // The scan is ignored; the journal in the same file is not part of the
    // scan document and still reaches the state route.
    expect(await stale.instance.tick()).toBe("state");
    expect(stale.bodies).toHaveLength(0);
  });

  it("still delivers state when the scan on disk is from another pipeline", async () => {
    // Upgrading the addon leaves the previous pipeline's ScanData on disk
    // until the next /wahscan. The estate and journal are written by the
    // running (new) addon, so a buy or a bag change in that window must
    // reach the terminal instead of waiting for a rescan.
    const stale = importer(
      () => savedVariables({ events: 1 }).replace('["dataVersion"] = 4', '["dataVersion"] = 3'),
      async () => ({ status: 200, body: {} })
    );
    expect(await stale.instance.tick()).toBe("state");
    expect(stale.bodies).toHaveLength(0);
    expect(stale.stateBodies).toHaveLength(1);
  });
});

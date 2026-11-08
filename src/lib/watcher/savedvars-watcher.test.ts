import { describe, expect, it } from "vitest";
import { createSavedvarsImporter, type ImportResponse } from "@/lib/watcher/savedvars-watcher";

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

function importer(content: () => string, post: () => Promise<{ status: number; body: ImportResponse }>) {
  const bodies: unknown[] = [];
  const logs: string[] = [];
  const instance = createSavedvarsImporter({
    readFile: content,
    post: async (body) => {
      bodies.push(body);
      return await post();
    },
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message)
  });
  return { instance, bodies, logs };
}

describe("createSavedvarsImporter", () => {
  it("posts a new scan once and then idles until something moves", async () => {
    const { instance, bodies } = importer(
      () => savedVariables({ events: 1 }),
      async () => ({ status: 200, body: { imported: 1, positions: 0, trades: 0 } })
    );
    expect(await instance.tick()).toBe("imported");
    expect(bodies).toHaveLength(1);
    expect(await instance.tick()).toBe("idle");
    expect(bodies).toHaveLength(1);
  });

  it("imports again when only the journal moved", async () => {
    let events = 1;
    let calls = 0;
    const { instance, bodies } = importer(
      () => savedVariables({ events }),
      async () => {
        calls += 1;
        return calls === 1
          ? { status: 200, body: { imported: 1 } }
          : { status: 200, body: { journalUpdated: true, positions: 0, trades: 0 } };
      }
    );
    expect(await instance.tick()).toBe("imported");
    events = 2;
    expect(await instance.tick()).toBe("journal");
    expect(bodies).toHaveLength(2);
    expect(await instance.tick()).toBe("idle");
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

  it("ignores a file without a scan or from another pipeline", async () => {
    const missing = importer(() => "WoWderhoiAH_Journal = {}\n", async () => ({ status: 200, body: {} }));
    expect(await missing.instance.tick()).toBe("idle");
    expect(missing.bodies).toHaveLength(0);

    const stale = importer(
      () => savedVariables({ events: 1 }).replace('["dataVersion"] = 4', '["dataVersion"] = 3'),
      async () => ({ status: 200, body: {} })
    );
    expect(await stale.instance.tick()).toBe("idle");
    expect(stale.bodies).toHaveLength(0);
  });
});

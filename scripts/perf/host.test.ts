import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { isPortInUse, nodeProcessCount, killTree } from "./host";

// The perf driver used to shell out to Windows-only commands (tasklist,
// `netstat -ano -p TCP`, taskkill). These tests pin the cross-platform
// replacements so the harness runs on macOS/arm64 and not just Windows.

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

describe("isPortInUse", () => {
  it("reports a held port as in use", async () => {
    const server = await listenOn(31_901);
    try {
      expect(await isPortInUse(31_901)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a free port as not in use", async () => {
    expect(await isPortInUse(31_902)).toBe(false);
  });
});

describe("nodeProcessCount", () => {
  it("returns an integer count without shelling out to a Windows command", async () => {
    // No platform branching: the same code path runs on macOS and Windows.
    // The count is >= 1 because this very test process is a node process.
    const count = await nodeProcessCount();
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe("killTree", () => {
  it("delivers a signal to a live child process", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], {
      stdio: "ignore",
      detached: true
    });
    const exited = new Promise<number>((resolve) => child.once("exit", resolve));
    try {
      const delivered = killTree(child.pid ?? -1);
      expect(delivered).toBe(true);
      // The signal (SIGTERM by default) should terminate the child within
      // a few seconds; if it's still alive, the signal was not delivered.
      const code = await Promise.race([
        exited.then(() => "exited" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000))
      ]);
      expect(code).toBe("exited");
    } finally {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  it("returns false for an invalid pid", () => {
    expect(killTree(-1)).toBe(false);
  });
});

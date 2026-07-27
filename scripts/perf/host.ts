import { createServer, type Server } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import process from "node:process";

// Cross-platform host helpers for the perf driver. The previous run.ts
// shelled out to Windows-only commands (tasklist / `netstat -ano -p TCP`
// / taskkill); these replacements use only node built-ins so the harness
// runs on macOS/arm64 too.

// Holding a port briefly to probe it is racy if something grabs it between
// close() and the caller's bind; acceptable for a perf driver that owns the
// port for the whole run.
export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => {
      // We bound it, so it was free a moment ago.
      server.close(() => resolve(false));
    });
  });
}

// Counts running node processes via the OS process list. Uses `ps` on
// POSIX and `tasklist` on Windows — both filtered to the node image so the
// count is comparable across platforms. Returns -1 only if the listing
// itself failed (the caller treats that as "unknown", not zero).
export function nodeProcessCount(): number {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq node.exe", "/NH", "/FO", "CSV"], {
        encoding: "utf8"
      });
      return out.split("\n").filter((line) => line.toLowerCase().includes("node.exe")).length;
    }
    const out = execFileSync("ps", ["-e", "-o", "comm="], { encoding: "utf8" });
    return out.split("\n").filter((line) => line.trim().endsWith("node")).length;
  } catch {
    return -1;
  }
}

// Terminates the process subtree so next's spawned server dies with it.
// Returns false for an invalid/already-dead pid rather than throwing.
export function killTree(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      // Windows has no process groups, so a negative pid signals nothing.
      // /T covers the subtree, matching the POSIX group semantics below.
      // /F is a hard kill: the graceful path (WM_CLOSE) is not delivered to
      // console processes, so there is no SIGTERM equivalent to try first.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    }
    // Negative pid = the whole process group rooted at `pid`.
    // `spawn(..., { detached: true })` put the child in its own group.
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    // Subtree already gone, or we lack permission — nothing left to signal.
    return false;
  }
}

// Reference the imports above so they're not tree-shaken in type-checks
// against future callers that pass a Server through.
export type { Server };

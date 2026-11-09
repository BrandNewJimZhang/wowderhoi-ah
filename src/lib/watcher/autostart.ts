// Starts the SavedVariables watcher when a server page first renders.
// Keeping the fs-importing watcher out of `instrumentation.ts` avoids
// bundling `node:fs` into the Edge/client graphs; every page goes through
// AppShell, which is a server component, so the first request boots it.
import { startSavedvarsWatcher } from "@/lib/watcher/savedvars-watcher";

export function ensureSavedvarsWatcher(): void {
  if (typeof window !== "undefined") return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const path = process.env.AQT_SAVEDVARS_PATH;
  if (!path) return;
  const globalForWatcher = globalThis as unknown as { wahSavedvarsWatcher?: unknown };
  if (globalForWatcher.wahSavedvarsWatcher) return;
  const port = process.env.PORT ?? "3000";
  globalForWatcher.wahSavedvarsWatcher = startSavedvarsWatcher({
    path,
    importUrl: process.env.AQT_IMPORT_URL ?? `http://localhost:${port}/api/import/addon-scan`,
    ...(process.env.AQT_STATE_URL ? { stateUrl: process.env.AQT_STATE_URL } : {})
  });
}

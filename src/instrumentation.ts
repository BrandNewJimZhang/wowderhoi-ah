// Next's server entrypoint. Starting the SavedVariables watcher here means
// `npm run dev` (or `next start`) is all the operator runs: a scan in game
// reaches the terminal without a second process. The standalone
// `npm run addon:watch` remains for deployments that run the terminal
// without the app.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // The build, the test runner and an Edge runtime must never open the
  // game's SavedVariables file.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  const path = process.env.AQT_SAVEDVARS_PATH;
  if (!path) return;

  const globalForWatcher = globalThis as unknown as { wahSavedvarsWatcher?: unknown };
  // Dev HMR can re-run register; the watcher owns a file watch and must be
  // a singleton.
  if (globalForWatcher.wahSavedvarsWatcher) return;

  const { startSavedvarsWatcher } = await import("@/lib/watcher/savedvars-watcher");
  const port = process.env.PORT ?? "3000";
  globalForWatcher.wahSavedvarsWatcher = startSavedvarsWatcher({
    path,
    importUrl: process.env.AQT_IMPORT_URL ?? `http://localhost:${port}/api/import/addon-scan`
  });
}

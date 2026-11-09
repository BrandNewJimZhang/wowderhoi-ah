// Standalone SavedVariables watcher for a terminal run without Next.
// `npm run addon:watch`. The Next app starts the same watcher from the
// first server render through src/lib/watcher/autostart.ts, so the two
// entries share one state machine.
import { startSavedvarsWatcher } from "@/lib/watcher/savedvars-watcher";

process.loadEnvFile();

const savedVarsPath = process.env.AQT_SAVEDVARS_PATH;
if (!savedVarsPath) {
  throw new Error(
    "AQT_SAVEDVARS_PATH is not set. Point it at the WoW SavedVariables file, e.g. " +
      "<game data dir>\\WTF\\Account\\<ACCOUNT>\\SavedVariables\\WoWDerhoiAH.lua"
  );
}

startSavedvarsWatcher({
  path: savedVarsPath,
  importUrl: process.env.AQT_IMPORT_URL ?? "http://localhost:3000/api/import/addon-scan",
  ...(process.env.AQT_STATE_URL ? { stateUrl: process.env.AQT_STATE_URL } : {})
});

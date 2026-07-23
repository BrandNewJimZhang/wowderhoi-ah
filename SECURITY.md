# Security

WoWderhoi AHelper runs entirely locally: the addon writes SavedVariables
on your disk, and the terminal is a localhost Next.js app with a SQLite
file database. There is no hosted service, no account system, and no
telemetry.

Things worth knowing:

- The import endpoint (`/api/import/addon-scan`) binds to localhost and
  validates payloads, but the dev server is not hardened for exposure —
  do not port-forward it to the public internet.
- The addon never executes remote code; it only reads the auction house
  API surface the game client provides.
- `.env` may contain machine-specific paths — it is gitignored; keep it
  that way.

Found a vulnerability? Open a GitHub issue. If it is sensitive enough
that public disclosure feels wrong, use GitHub's private vulnerability
reporting on this repository instead.

# Local Development — Agent Setup

This document covers how to set up and run the development environment locally. Refer to `README.md` for more detailed information on installation, deployment, and configuration.

## Best practices:

- Never swallow a real error silently — `console.error` it server-side before returning a friendly/generic message to the client.

## Prerequisites

- Node.js 24.x and npm
- Docker and Docker Buildx (for release builds only, not needed for dev)

## Running the Backend Locally

The backend API and reconciler are Node.js services that connect to SQLite. To start the development server:

```sh
npm run build
REC_LIVE_DATA_DIR="$PWD/.local/state" \
REC_LIVE_RECORDINGS_DIR="$PWD/.local/recordings" \
REC_LIVE_PRIVATE_SOCKET="$PWD/.local/run/api.sock" \
npm start
```

This starts the API listener on the default `0.0.0.0:8787`. The public listener is accessible at `http://localhost:8787`. All `RecLiveData`, recordings, and private socket paths are created under `.local/` in the project directory.

See `.env.example` for all configurable settings.

## Running the Vite Development Server

The client is built with Vue 3 and Vite. To start the dev server for UI work:

```sh
npm run dev:client
```

This starts Vite on `http://localhost:5173` by default, with a reverse proxy configured to forward API requests (`/recordings`, `/cookies`, `/health`) to `http://localhost:8787`. Ensure the backend server (above) is running before starting the dev server.

## Building and Testing

Build everything (backend + client):

```sh
npm run build
```

This produces:
- TypeScript compiled to JavaScript in `dist/` (backend)
- Client built into `dist/public/` via Vite (frontend)

Run the test suite (builds first, then runs tap):

```sh
npm test
```

All tests should pass (currently 55/55).

## Quick API Sanity Checks

The backend serves a health check and JSON routes. Examples from `README.md`:

```sh
curl http://127.0.0.1:8787/health

curl -F 'name=primary' -F 'file=@cookies.txt' http://127.0.0.1:8787/cookies
curl http://127.0.0.1:8787/cookies

curl -X POST http://127.0.0.1:8787/recordings \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=example","title":"Live show","start_at":"2026-07-21T20:00:00Z","stop_at":"2026-07-21T22:00:00Z","quality":"720p"}'

curl 'http://127.0.0.1:8787/recordings?status=scheduled'
curl http://127.0.0.1:8787/recordings/rec-REPLACE_ME
```

Full API reference and response shapes are documented in `README.md` under "Phase 0 curl API".

## Logs on the live host (`irae-sheeta`)

Two distinct log sources exist on the deployed host, with different access:

- **Per-recording streamlink capture logs — viewable, no root needed.** `<recordingsDir>/<id>.log` (e.g. `/srv/rec-live-tronic/recordings/<id>.log`) holds the recorder subprocess's `stderr`, appended directly to a file next to the `.ts` (commit `1385458`, "stderr to shared log"). This directory is `rec-media`-group readable/writable, so `irae` (a `rec-media` member) can read these directly over SSH — no `su`/`sudo` needed. Also fetchable via `GET /recordings/:id/log`.
- **API/reconciler service's own `stdout`/`stderr` — NOT viewable by `irae` as deployed.** Neither systemd unit (`rec-live-tronic-api.service`, `rec-live-tronic-reconciler.service`) overrides `StandardOutput`/`StandardError`, so both default to the systemd journal only — not a file under the `rec-media`-readable tree. Reading them requires either `adm`/`systemd-journal` group membership (`irae` doesn't have this by default — verified directly: `journalctl -u rec-live-tronic-api.service` as `irae` returns `-- No entries --` with an explicit "users in groups adm, systemd-journal can see all messages" notice) or root (`sudo journalctl -u <unit>`). This matters for any application-level `console.error`/`console.log` in `src/` — e.g. `RecorderService.deleteRecording`'s unlink-failure logging — none of that reaches an `irae`-readable file as currently configured.

If future debugging needs the API/reconciler's own logs readable without root, the fix is adding `irae` to `adm` or `systemd-journal` on the host (`usermod -aG systemd-journal irae`, requires root), or adding an explicit `StandardOutput=append:...`/`StandardError=append:...` to those units pointing at a `rec-media`-readable path (mirroring the streamlink pattern above) — neither has been done as of this writing.

## Client Artifacts

The web client is served by the Express API at `/` after the `npm run build` step completes. Vite produces:
- `dist/public/index.html` — SPA entry point
- `dist/public/assets/` — hashed CSS and JavaScript bundles

During development, `npm run dev:client` serves unminified assets with hot reload and proxies API calls to the local backend.

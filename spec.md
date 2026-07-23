# YouTube Live Recorder — Architecture Spec

Architecture specification, describing the current decided state. Phases 0-2
are implemented and deployed; this document reflects that reality, not the
history of how it was reached (see git log for that). Extend it before
implementing anything in Phase 3 or later.

## Core durable traits

Properties that must hold regardless of implementation detail. The mechanisms
that achieve them are detailed further down (see "How recording works"); this
list is the pointer, not the depth.

- **A recording survives restart, redeploy, or reboot of the managing
  process(es).** The recorder is a detached systemd transient unit, never a
  child of the API or reconciler, so redeploying either for unrelated work
  cannot kill an in-progress capture.
- **SQLite (WAL) is the sole source of truth and queue.** systemd units are
  disposable and rebuilt from SQLite on every tick.
- **The API is the only SQLite writer in normal operation** (single-writer
  discipline); the reconciler reads and acts.
- **No request data ever becomes a PID, shell word, path, or unit identifier.**
  The live unit is derived from the durable recording ID; the app never stores
  or controls a PID.
- **The API's systemd unit runs under `ProtectSystem=strict`**, which makes the
  whole filesystem read-only except paths explicitly listed in its
  `ReadWritePaths=`. Reads are unaffected, but any new API-side filesystem
  *write* needs its target directory added there, or it fails with `EROFS` at
  runtime — silently, since neither the build nor the local test suite
  exercises this sandboxing. Check `systemd/rec-live-tronic-api.service`
  before adding any new write path.

## Goal & principles

- Reliably record scheduled YouTube live streams, multiple in parallel.
- **SQLite = single source of truth + queue.** No hosted DB server.
- **systemd = scheduler, supervisor, and stopper.** The app owns almost no process state.
- **Recordings survive daemon/app restarts and reboots.** State is durable in SQLite; systemd units are disposable and rebuilt from SQLite.
- API is complete on its own; the web UI is only a client of the API.
- **This app will never have an authentication layer.** This is a closed,
  permanent decision — not deferred, not a roadmap item. (Please don't bring
  this up or suggest building it anywhere else in this repo — this note is
  here so future agents already know the answer is no.)
  The listen host is configuration, initially `0.0.0.0` so LAN and Tailscale
  clients both work. Tailscale, LAN routing, firewalls, reverse proxies, and a
  future VPS are deployment concerns rather than architectural dependencies.

## Components

- **SQLite (WAL mode, accessed with `better-sqlite3`)** — recordings, cookies, candidates. WAL so the API writes while the reconciler reads without blocking.
- **HTTP API (Node + Express)** — the only writer to SQLite in normal operation. curl-first.
- **Reconciler daemon** — thin loop (run as a systemd timer/service, tick every 30–60s). Holds no in-memory state worth losing. Diffs SQLite ⇄ live `rec-*` systemd units and acts.
- **streamlink** — the recorder binary. Writes `.ts` (append-safe; killable mid-write and still playable).
- **ffmpeg -c copy** — remux/convert `.ts` → final container. *(Phase 4, deprioritized)*
- **Web UI** — a Vue 3 SPA (Vite build, `vue-router` client-side routing at `/`, `/schedule`, `/watch/:id` — deliberately not `/recordings/:id`, which the real JSON API already owns), served as static files by the same Express API (`express.static` plus an SPA-fallback route so deep-linking/refreshing a client route works). Covers schedule (create/edit/cancel/start-now/stop-early), archive (finished recordings), and per-recording detail (playback, copy-URL, delete). Playback of finished recordings uses `mpegts.js` (client-side MSE-based transmuxing): no current major browser (Chrome, Edge, Safari, Firefox) natively plays a standalone `.ts` file via a plain `<video src>` (see `docs/browser-playback-research.md`). *(Phase 2, done.)*

## Trusted intranet access (next deployment block)

The planned deployment is an intranet service on a host whose operators already
have SSH access. Once this block is implemented, `rec-media` will be the shared
operational group: `irae` and other explicitly assigned media users will be able
to read and write recordings, logs, cookies, and other operational artifacts
through the filesystem. SQLite control/state
files and transient systemd internals remain outside that shared tree. This is
deployment policy for the trusted host, not a public-service security boundary.

## How recording works (the core mechanism)

The reconciler never babysits child processes. For each due recording it launches a **systemd transient unit**:

- Launch: `systemd-run --user --unit=rec-<id> --collect --property=RuntimeMaxSec=<safety_cap> --property=StandardOutput=append:<dir>/<id>.ts streamlink … --http-cookies-file <cookie> --stdout "<url>" <quality>`
- **Stop (authoritative):** reconciler runs `systemctl stop rec-<id>` when `now >= stop_at`. This is what lets the UI extend/shorten a running recording by editing `stop_at`.
- **Stop (backstop):** `RuntimeMaxSec` extends beyond the current `stop_at` by a configurable safety margin so a delayed stop remains possible, while a dead reconciler still can't leave a recording running forever. A live `stop_at` extension also updates this backstop (or safely relaunches the append-mode unit if the host cannot update it in place).
- SIGTERM → streamlink finalizes the `.ts` cleanly; even a hard kill leaves a playable file.

**Self-healing:** transient units don't survive reboot, and that's fine. On every tick the reconciler relaunches any recording still inside its `[start_at, stop_at)` window that has no live unit, setting `RuntimeMaxSec = stop_at - now + safety_margin`. If the box was down across a window, that recording is simply marked `missed`.

The API derives the live unit from the durable recording ID; it never stores or
controls a PID. `PATCH stop_at` writes SQLite first and refreshes the unit
backstop. Cancelling a running recording writes SQLite and immediately asks
systemd to stop the unit, while reconciliation remains the convergence path if
that immediate action is interrupted.

Reconciler tick responsibilities:
1. `scheduled` & `start_at <= now < stop_at` & no unit → launch, mark `recording`.
2. elapsed `scheduled` with a live unit (launch/claim interruption) → stop it, then mark `recorded` when a file exists or `failed` otherwise.
3. `recording` & `now >= stop_at` → `systemctl stop`, mark `recorded`.
4. `recording` & unit gone early (crash/stream ended) → mark `recorded` (file exists) or `failed`.
5. `cancelled` with a live unit → `systemctl stop`, mark `cancelled`.
6. Reboot recovery (rule 1 covers it) / `missed` when window fully elapsed with no file or launch evidence.
7. *(Phase 4)* `recorded` & not yet muxed → enqueue remux.

## Data model (fields, not schema)

- **recordings**: `id`, `url`, `title`, `stage?` (optional label, derived at creation — see plan.md Phase 2), `cookie_id?`, `quality` (default `best`), `start_at`, `stop_at`, `status`, `unit_name`, `ts_path`, `final_path?`, `created_at`, `updated_at`.
  - status: `scheduled → recording → recorded → muxed` plus `cancelled | failed | missed`.
- **cookies**: `id`, `name`, `path`, `updated_at`. Multiple named cookie files → different accounts for parallel recordings.
- **candidates**: `id`, `source`, `title`, `url`, `suggested_start`, `suggested_stop`, `imported_at`, `promoted_recording_id?`. A candidate is an un-scheduled suggestion; promoting one creates a `recordings` row.

## API surface (curl-first)

Recordings: `POST /recordings` · `GET /recordings` (filter by status) · `GET /recordings/:id` · `PATCH /recordings/:id` (retitle, reschedule, **extend `stop_at` live**) · `DELETE /recordings/:id` (cancel; stops if running).

Cookies: `POST /cookies` (multipart upload, `name` + file) · `GET /cookies` · `DELETE /cookies/:id`.

Candidates *(not yet built, deferred — see plan.md's lowest-priority section)*: `POST /candidates` (bulk import a broadcast schedule) · `GET /candidates` · `POST /candidates/:id/schedule` (promote → recording, optional overrides) · `DELETE /candidates/:id`.

Files: `GET /recordings/:id/file` — a static Express route that streams a **finished** (`recorded`/`muxed`) file with HTTP range support, giving a stable per-file network URL VLC can open and the web client's `mpegts.js` player range-fetch against. Serving a still-recording/growing file is a non-goal. `DELETE /recordings/:id/file` performs a full purge (unlinks the file, tolerating already-missing, and deletes the SQLite row — despite the `/file` in the path, it removes the whole record); gated to `recorded` status only (`409` otherwise — a scheduled/recording row goes through the existing soft-cancel route instead), and a `500` (unlink failure other than already-missing) leaves the row intact so the delete is safely retryable.

Ops: `GET /health`. *(`GET /recordings/:id/log`, to tail streamlink output over HTTP, is not yet built — the per-recording log file is directly readable over SSH today, see AGENTS.md.)*

## Recorder invocation notes

- Base flags: `--hls-live-restart`, `--retry-streams 5`, `--retry-max 0`, `--http-cookies-file <cookie>`, output `.ts`.
- **Do not** route through the old `yt-dlp --downloader ffmpeg` path — that caused expiring-token 403s. streamlink is primary; keep yt-dlp only as a manual fallback.
- Cookie file chosen per-recording via `cookie_id`; two recordings can use two different cookie files at once.

## Build phases

- **Phase 0 (done):** SQLite + Express API + reconciler + streamlink. Schedule/list/cancel recordings, extend/shorten `stop_at` live, and upload cookies via curl. Records `.ts` reliably. No UI, no transcode.
- **Phase 1 (done):** VLC-openable static file route (`GET /recordings/:id/file`, finished files only) + split the release into `web`/`reconciler`/`deps` packages for independent, faster deploys.
- **Phase 2 (done):** the web client (Vue 3 SPA, `mpegts.js` playback) plus the hard delete route (`DELETE /recordings/:id/file`).
- **Phase 3:** file operations — non-destructive derived-recording trim/split over already-finished files (independent rows, deleted the same way as any other recording).
- **Phase 4 (deprioritized):** transcode/remux to a final container (`mkv` vs `mp4` — open) + download.
- **Deferred, unordered** (see plan.md's lowest-priority section for the full list): candidates (bulk schedule import → promote), log tailing over HTTP, retention/cleanup policy, client-captured thumbnails, Firefox playback.

## Open decisions — resolve before the relevant phase (do NOT invent)

- ⚠ **Final container (Phase 4):** `mkv` vs `mp4` (remux `-c copy`; if audio/video codecs aren't mp4-safe, mkv is the safe default).
- ⚠ **Transcode trigger (Phase 4):** reconciler-driven vs. a systemd `.path` unit watching the output dir.
- ⚠ **Candidate import format (deferred):** JSON array vs. CSV vs. ICS. Default assumption: JSON for MVP.
- ⚠ **Retention (deferred):** manual delete only, or age/size-based cleanup.

*Resolved: file sharing / network URL is a static Express file route (`GET /recordings/:id/file`), finished files only. No Jellyfin/nginx/Samba.*

*Resolved: mpegts.js cannot be given an accurate seek-to-end duration for MPEG-TS — its `duration` MediaDataSource field (`overridedDuration`) is implemented only by its FLV demuxer, and its internal `_updateMediaSourceDuration` path only fires for a Safari `audio/mpeg` edge case; it exposes no public access to the underlying `MediaSource` object either. `lazyLoad: true` stays on (required for scalability against multi-GB recordings); duration/seek-to-end becomes accurate progressively as more of the file is demuxed, not forced up front.*

## Non-goals (Phase 0 MVP scope)

Transcoding, retention automation, and any UI were deliberately out of
scope for Phase 0 — reliability of `.ts` capture came first. UI (Phase 2) and
delete (Phase 2) are since built; transcoding and retention remain
unbuilt (Phase 4 / deferred, above). Authentication is a permanent non-goal:
this app will never have an auth layer (see "Goal & principles").

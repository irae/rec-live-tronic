# YouTube Live Recorder — Architecture Spec

Architecture specification. **Architecture only — do not implement yet.**
Build in phase order. Phase 0 must be usable via `curl` and reliably record today; everything else iterates on top.

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

## Goal & principles

- Reliably record scheduled YouTube live streams, multiple in parallel.
- **SQLite = single source of truth + queue.** No hosted DB server.
- **systemd = scheduler, supervisor, and stopper.** The app owns almost no process state.
- **Recordings survive daemon/app restarts and reboots.** State is durable in SQLite; systemd units are disposable and rebuilt from SQLite.
- API is complete on its own; the web UI is only a client of the API.
- No auth for now, but keep it addable later through a single middleware seam.
  The listen host is configuration, initially `0.0.0.0` so LAN and Tailscale
  clients both work. Tailscale, LAN routing, firewalls, reverse proxies, and a
  future VPS are deployment concerns rather than architectural dependencies.

## Components

- **SQLite (WAL mode, accessed with `better-sqlite3`)** — recordings, cookies, candidates. WAL so the API writes while the reconciler reads without blocking.
- **HTTP API (Node + Express)** — the only writer to SQLite in normal operation. curl-first.
- **Reconciler daemon** — thin loop (run as a systemd timer/service, tick every 30–60s). Holds no in-memory state worth losing. Diffs SQLite ⇄ live `rec-*` systemd units and acts.
- **streamlink** — the recorder binary. Writes `.ts` (append-safe; killable mid-write and still playable).
- **ffmpeg -c copy** — remux `.ts` → final container. *(Phase 3)*
- **Web UI** — schedule/history/candidates/files. *(Phase 4)*

## Trusted intranet access (next deployment block)

The planned deployment is an intranet service on a host whose operators already
have SSH access. Once this block is implemented, `rec-media` will be the shared
operational group: `irae` and other explicitly assigned media users will be able
to read and write recordings, logs, cookies, and other operational artifacts
through the filesystem. SQLite control/state
files and transient systemd internals remain outside that shared tree. This is
deployment policy for the trusted host, not a public-service security boundary;
public exposure still requires the deferred authentication/access-boundary
decision.

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
7. *(Phase 3)* `recorded` & not yet muxed → enqueue remux.

## Data model (fields, not schema)

- **recordings**: `id`, `url`, `title`, `stage?` (optional label, derived at creation — see plan.md Phase 2), `cookie_id?`, `quality` (default `best`), `start_at`, `stop_at`, `status`, `unit_name`, `ts_path`, `final_path?`, `created_at`, `updated_at`.
  - status: `scheduled → recording → recorded → muxed` plus `cancelled | failed | missed`.
- **cookies**: `id`, `name`, `path`, `updated_at`. Multiple named cookie files → different accounts for parallel recordings.
- **candidates**: `id`, `source`, `title`, `url`, `suggested_start`, `suggested_stop`, `imported_at`, `promoted_recording_id?`. A candidate is an un-scheduled suggestion; promoting one creates a `recordings` row.

## API surface (curl-first)

Recordings: `POST /recordings` · `GET /recordings` (filter by status) · `GET /recordings/:id` · `PATCH /recordings/:id` (retitle, reschedule, **extend `stop_at` live**) · `DELETE /recordings/:id` (cancel; stops if running).

Cookies: `POST /cookies` (multipart upload, `name` + file) · `GET /cookies` · `DELETE /cookies/:id`.

Candidates: `POST /candidates` (bulk import a broadcast schedule) · `GET /candidates` · `POST /candidates/:id/schedule` (promote → recording, optional overrides) · `DELETE /candidates/:id`.

Files: `GET /recordings/:id/file` — a static Express route that streams a **finished** (`recorded`/`muxed`) file with HTTP range support, giving a stable per-file network URL VLC can open (Phase 1; see plan.md). Serving a still-recording/growing file is a non-goal. `DELETE /recordings/:id/file` lands with the file lifecycle *(Phase 3)*.

Ops: `GET /health` · `GET /recordings/:id/log` (tail streamlink output).

## Recorder invocation notes

- Base flags: `--hls-live-restart`, `--retry-streams 5`, `--retry-max 0`, `--http-cookies-file <cookie>`, output `.ts`.
- **Do not** route through the old `yt-dlp --downloader ffmpeg` path — that caused expiring-token 403s. streamlink is primary; keep yt-dlp only as a manual fallback.
- Cookie file chosen per-recording via `cookie_id`; two recordings can use two different cookie files at once.

## Build phases

- **Phase 0 (MVP, done):** SQLite + Express API + reconciler + streamlink. Schedule/list/cancel recordings, extend/shorten `stop_at` live, and upload cookies via curl. Records `.ts` reliably. No UI, no transcode.
- **Phase 1:** VLC-openable static file route (`GET /recordings/:id/file`, finished files only) + split the release into `web`/`reconciler`/`deps` packages for independent, faster deploys.
- **Phase 2:** candidates (import schedule → promote) and log tailing.
- **Phase 3:** transcode/remux worker `.ts → final container` (as `mux-<id>` systemd units, concurrency-capped) + file delete.
- **Phase 4:** web UI (schedule form, history, candidate inbox, file list + network URLs).
- **Phase 5 (deferred):** auth middleware, retention/cleanup policy.

## Open decisions — resolve before the relevant phase (do NOT invent)

- ⚠ **Final container (Phase 3):** `mkv` vs `mp4` (remux `-c copy`; if audio/video codecs aren't mp4-safe, mkv is the safe default).
- ⚠ **Transcode trigger (Phase 3):** reconciler-driven vs. a systemd `.path` unit watching the output dir.
- ⚠ **Candidate import format (Phase 2):** JSON array vs. CSV vs. ICS. Default assumption: JSON for MVP.
- ⚠ **Retention (Phase 5):** manual delete only, or age/size-based cleanup.

*Resolved: file sharing / network URL — a static Express file route (`GET /recordings/:id/file`), finished files only, built in Phase 1 (see plan.md). No Jellyfin/nginx/Samba.*

## Non-goals (MVP)

Auth, transcoding, retention automation, and any UI. Reliability of `.ts` capture comes first; everything else layers on without touching the record path.

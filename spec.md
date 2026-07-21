# YouTube Live Recorder — Architecture Spec

Architecture specification. **Architecture only — do not implement yet.**
Build in phase order. Phase 0 must be usable via `curl` and reliably record today; everything else iterates on top.

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
- **ffmpeg -c copy** — remux `.ts` → final container. *(Phase 2)*
- **Web UI** — schedule/history/candidates/files. *(Phase 3)*

## How recording works (the core mechanism)

The reconciler never babysits child processes. For each due recording it launches a **systemd transient unit**:

- Launch: `systemd-run --user --unit=rec-<id> --collect --property=RuntimeMaxSec=<safety_cap> --property=StandardOutput=append:<dir>/<id>.ts streamlink … --http-cookie-file <cookie> --stdout "<url>" <quality>`
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
7. *(Phase 2)* `recorded` & not yet muxed → enqueue remux.

## Data model (fields, not schema)

- **recordings**: `id`, `url`, `title`, `cookie_id?`, `quality` (default `720p`/`best`), `start_at`, `stop_at`, `status`, `unit_name`, `ts_path`, `final_path?`, `created_at`, `updated_at`.
  - status: `scheduled → recording → recorded → muxed` plus `cancelled | failed | missed`.
- **cookies**: `id`, `name`, `path`, `updated_at`. Multiple named cookie files → different accounts for parallel recordings.
- **candidates**: `id`, `source`, `title`, `url`, `suggested_start`, `suggested_stop`, `imported_at`, `promoted_recording_id?`. A candidate is an un-scheduled suggestion; promoting one creates a `recordings` row.

## API surface (curl-first)

Recordings: `POST /recordings` · `GET /recordings` (filter by status) · `GET /recordings/:id` · `PATCH /recordings/:id` (retitle, reschedule, **extend `stop_at` live**) · `DELETE /recordings/:id` (cancel; stops if running).

Cookies: `POST /cookies` (multipart upload, `name` + file) · `GET /cookies` · `DELETE /cookies/:id`.

Candidates: `POST /candidates` (bulk import a broadcast schedule) · `GET /candidates` · `POST /candidates/:id/schedule` (promote → recording, optional overrides) · `DELETE /candidates/:id`.

Files *(sketch — see decisions)*: `GET /recordings/:id/file` (stream/download) · `DELETE /recordings/:id/file` · a stable network URL per file for VLC.

Ops: `GET /health` · `GET /recordings/:id/log` (tail streamlink output).

## Recorder invocation notes

- Base flags: `--hls-live-restart`, `--retry-streams 5`, `--retry-max 0`, `--http-cookie-file <cookie>`, output `.ts`.
- **Do not** route through the old `yt-dlp --downloader ffmpeg` path — that caused expiring-token 403s. streamlink is primary; keep yt-dlp only as a manual fallback.
- Cookie file chosen per-recording via `cookie_id`; two recordings can use two different cookie files at once.

## Build phases

- **Phase 0 (today, MVP):** SQLite + Express API + reconciler + streamlink. Schedule/list/cancel recordings, extend/shorten `stop_at` live, and upload cookies via curl. Records `.ts` reliably. No UI, no transcode.
- **Phase 1:** candidates (import schedule → promote) and log tailing.
- **Phase 2:** transcode worker `.ts → final container` (as `mux-<id>` systemd units, concurrency-capped) + file delete.
- **Phase 3:** web UI (schedule form, history, candidate inbox, file list + network URLs).
- **Phase 4 (deferred):** auth middleware, retention/cleanup policy.

## Open decisions — resolve before the relevant phase (do NOT invent)

- ⚠ **File sharing / network URL (Phase 2–3):** static Express file route vs. a media container (e.g. Jellyfin) vs. plain nginx/Samba. Must yield a VLC-openable URL on the configured network. *Left undecided — sketch only.*
- ⚠ **Final container (Phase 2):** `mkv` vs `mp4` (remux `-c copy`; if audio/video codecs aren't mp4-safe, mkv is the safe default).
- ⚠ **Transcode trigger (Phase 2):** reconciler-driven vs. a systemd `.path` unit watching the output dir.
- ⚠ **Candidate import format (Phase 1):** JSON array vs. CSV vs. ICS. Default assumption: JSON for MVP.
- ⚠ **Retention (Phase 4):** manual delete only, or age/size-based cleanup.

## Non-goals (MVP)

Auth, transcoding, retention automation, and any UI. Reliability of `.ts` capture comes first; everything else layers on without touching the record path.

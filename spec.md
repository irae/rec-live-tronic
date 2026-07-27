# YouTube Live Recorder — Architecture Spec

Architecture specification, describing the current decided state through
Phase 6 / v0.6.0 (the MP4 transition). It reflects decided state, not the
history of how it was reached — see `CHANGELOG.md` and git log for that.
Extend it before implementing anything in Phase 7 or later; phase numbering
follows `plan.md`.

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
- **Reconciler daemon** — thin loop (run as a systemd timer/service, tick every 10s). Holds no in-memory state worth losing. Diffs SQLite ⇄ live `rec-*` systemd units and acts.
- **streamlink** — the recorder binary. Writes `.ts` (append-safe; killable mid-write and still playable). The `.ts` is the capture format only, not the serving format.
- **ffmpeg / ffprobe** — in-process one-shot `execFile` jobs (argv only, never a shell, bounded timeouts): the post-capture `-c copy` remux of each finished `.ts` into faststart MP4, ffprobe verification of that remux, and the Cut workflow's keyframe-snapped segment extraction (also emitted directly as MP4).
- **Web UI** — a Vue 3 SPA (Vite build, `vue-router` client-side routing at `/`, `/schedule`, `/watch/:id`, `/trash` — deliberately not `/recordings/:id`, which the real JSON API already owns), served as static files by the same Express API (`express.static` plus an SPA-fallback route so deep-linking/refreshing a client route works). Covers schedule (create/edit/cancel/start-now/stop-early), archive, trash, and per-recording detail (playback, Cut console, metadata editing, download, copy-URL, VLC links, trash). Playback of finished recordings is a plain `<video src>` against the served MP4 — no client-side transmuxing library (raw `.ts` is not natively playable in any current browser, see `docs/browser-playback-research.md` and `docs/serving-format-research.md`; the MP4 remux is what makes the plain element work).

## Trusted intranet access

The deployment is an intranet service on a host whose operators already have
SSH access. `rec-media` is the shared operational group: `irae` and other
explicitly assigned media users read and write recordings, logs, cookies, and
other operational artifacts directly through the filesystem (group-write via
`UMask=0007`). SQLite control/state files and transient systemd internals
remain outside that shared tree. This is deployment policy for the trusted
host, not a public-service security boundary.

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

The reconciler's job ends at `recorded`. The MP4 remux is API-side: when a
transition lands `recorded`, the API fires an in-process one-shot
`ffmpeg -c copy -movflags +faststart` remux of the `.ts` into `<id>.mp4`,
verifies the output with ffprobe (duration match, both streams present), then
re-points `ts_path` at the `.mp4`. The source `.ts` is kept on disk as a
safety net (its removal is deferred, later work — see Phase 6b). A failed or
unverified remux keeps the `.ts` in place and served (extension-aware file
route), with the real error logged — remux failure never breaks serving.

## Data model (fields, not schema)

- **recordings**: `id`, `url`, `title`, `stage?`/`artist?`/`venue?`/`event?`
  (optional metadata labels; title composed from them server-side at creation
  when no explicit title is given), `cookie_id?`, `quality` (default `best`),
  `start_at`, `stop_at`, `status`, `unit_name`, `ts_path`, `trashed_at?`
  (non-null = in trash, orthogonal to status), `cut_from_id?` (lineage to the
  cut source), `created_at`, `updated_at`.
  - status: `scheduled → recording → recorded` plus `cancelled | failed |
    missed`. `recorded` is the only terminal media-bearing status.
  - `ts_path` holds the served media file — the `.mp4` after the post-capture
    remux; the column name is kept from the capture format for continuity.
- **cookies**: `id`, `name`, `path`, `updated_at`. Multiple named cookie files → different accounts for parallel recordings.
- **cut_drafts**: one `previewing` draft per source at most — mode
  (`trim`/`split`), params, working dir, piece count, status. Tracks the Cut
  workflow's not-yet-promoted previews so orphaned working folders are swept
  by query.
- **candidates** *(not yet built — Phase 9)*: `id`, `source`, `title`, `url`, `suggested_start`, `suggested_stop`, `imported_at`, `promoted_recording_id?`. A candidate is an un-scheduled suggestion; promoting one creates a `recordings` row.

## API surface (curl-first)

Recordings: `POST /recordings` · `GET /recordings` (filters: `?status=`,
`?trashed=true`, `?cut_from=<id>`; the list response also carries the disk
figures and an `is_recording` flag the header polls) · `GET /recordings/:id` ·
`PATCH /recordings/:id` (retitle/reschedule while scheduled, **extend
`stop_at` live**, metadata-only edits once `recorded`) ·
`DELETE /recordings/:id` (cancel; stops if running) · best-effort read-only
helpers `GET /recordings/oembed?url=` (title/channel prefill) and
`GET /recordings/formats?url=` (live-stream quality probe).

Trash: `DELETE /recordings/:id/file` moves a finished recording **to trash**
(sets `trashed_at`; file and row survive) · `POST /recordings/:id/restore` ·
`DELETE /recordings/:id/trash` (permanent purge — unlink file(s) + delete the
row; gated to trashed rows; retryable on unlink failure).

Cut: `POST /recordings/:id/cut` (create/regenerate the source's single active
draft) · `GET /recordings/:id/cut/:draftId/pieces/:index/file` (range-served
preview piece) · `POST /recordings/:id/cut/:draftId/keep` (promote kept
pieces) · `DELETE /recordings/:id/cut/:draftId` (abandon).

Cookies: `POST /cookies` (multipart upload, `name` + file) · `GET /cookies` · `DELETE /cookies/:id`.

Candidates *(not yet built — Phase 9)*: `POST /candidates` (bulk import a broadcast schedule) · `GET /candidates` · `POST /candidates/:id/schedule` (promote → recording, optional overrides) · `DELETE /candidates/:id`.

Files: `GET /recordings/:id/file` (and the friendly-filename variant
`GET /recordings/:id/file/:filename`) — streams a **finished** (`recorded`)
file with HTTP range support via `sendFile()`, a stable per-file URL both the
browser `<video>` element and VLC open directly; `?download=1` adds a
`Content-Disposition: attachment` with a sanitized `<title>` filename.
Content-Type and filename extension are derived from the actual file
(`.mp4` → `video/mp4`; a not-yet/failed-remux `.ts` → `video/mp2t`), so
serving never depends on remux success. Serving a still-recording/growing
file is a non-goal. `POST /recordings/backfill-mp4` — idempotent maintenance
route that remuxes any remaining `.ts`-backed rows (including trashed ones),
tallying `{ "remuxed": <n>, "skipped": <n>, "failed": ["<id>", …] }`; every
source `.ts` is kept on disk (deleting them is deferred, later Phase 6b
work).

Ops: `GET /health`. *(`GET /recordings/:id/log`, to tail streamlink output over HTTP, is deliberately not built — the per-recording log file is directly readable over SSH via the `rec-media` group, see AGENTS.md.)*

## Recorder invocation notes

- Base flags: `--hls-live-restart`, `--retry-streams 5`, `--retry-max 0`, `--http-cookies-file <cookie>`, output `.ts`.
- **Do not** route through the old `yt-dlp --downloader ffmpeg` path — that caused expiring-token 403s. streamlink is primary; keep yt-dlp only as a manual fallback.
- Cookie file chosen per-recording via `cookie_id`; two recordings can use two different cookie files at once.

## Build phases

Numbering matches `plan.md`; completed phases are summarized per-milestone in
`CHANGELOG.md` (Beta N = Phase N = version `0.N.0`).

- **Phase 0 (done):** core recorder — SQLite + Express API + reconciler +
  streamlink, curl-first. Reliable `.ts` capture.
- **Phase 1 (done):** VLC-openable range-serving file route + the
  `web`/`reconciler`/`deps` release package split.
- **Phase 2 (done):** the web client (Vue 3 SPA) plus hard delete.
- **Phase 3 (done):** trash/retention — reversible delete, restore, permanent
  delete, disk-space readout, 30-day auto-purge.
- **Phase 4, 4a, 4b (done):** misc actions (Now mode, oEmbed prefill,
  downloads, quality picker), finished-recording metadata editing, and the
  post-ship UX batch.
- **Phase 5 (done):** the Cut workflow — preview-then-promote Trim/Split with
  lineage.
- **Phase 6 (done, v0.6.0, this spec's state):** the MP4 transition —
  post-capture faststart MP4 remux, extension-aware serving, plain-`<video>`
  playback, `mpegts.js` removed, one-time backfill of pre-existing
  recordings.
- **Phase 7:** duration correctness + stream-gap tracking — scope reserved,
  design pending.
- **Phase 8:** audio-only capture and playback behind a global toggle.
- **Phase 9:** candidates (bulk schedule import → promote) — research first.
- **Deferred, unordered** (see plan.md's lowest-priority section): demux
  (undesigned), client-captured thumbnails, reboot-recovery acceptance test.

## Open decisions — resolve before the relevant phase (do NOT invent)

- ⚠ **Candidate import format (Phase 9):** JSON array vs. CSV vs. ICS. Default assumption: JSON for MVP.

*Resolved: final serving container is **MP4** (H.264+AAC stream copy,
`-movflags +faststart`) — hands-on verified in
`docs/serving-format-research.md`; MKV ruled out (no native `<video>`
support).*

*Resolved: the remux trigger is an **in-process one-shot `execFile` ffmpeg
job** fired by the API when a recording lands `recorded` (plus the idempotent
backfill route) — not reconciler-driven, no systemd `.path` unit.*

*Resolved: retention is manual delete + trash with a 30-day auto-purge (Phase
3); no age/size-based cleanup of live recordings.*

*Resolved: file sharing / network URL is a static Express file route (`GET /recordings/:id/file`), finished files only. No Jellyfin/nginx/Samba.*

## Non-goals

Serving or playing a still-recording/growing file. Any age/size-based cleanup
of non-trashed recordings. Authentication is a permanent non-goal: this app
will never have an auth layer (see "Goal & principles").

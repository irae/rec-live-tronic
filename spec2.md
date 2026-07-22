# YouTube Live Recorder — Architecture Spec v2 (systemd-free candidate)

**Candidate / alternate architecture. Not a replacement for `spec.md` yet.**
This document captures a redesign discussed after the Phase 0 systemd
architecture proved brittle during install/acceptance on `irae-sheeta`
(repeated reconciler/socket/sandbox lifecycle races). It removes systemd as
scheduler, per-recording supervisor, and stopper, and splits the app into
**three long-running Node processes** over **two SQLite files**. Architecture
only — do not implement from this document; `spec.md` remains the built system
until this candidate is chosen and turned into a plan.

Where a decision below was actually made in the design discussion it is stated
plainly; where it is carried over from `spec.md` or inferred rather than
explicitly decided, it is marked ⚠ so it can be confirmed against real intent.

## Why move away from systemd

Phase 0 put four independently-timed pieces in the critical recording path: the
API service, a reconciliation timer/service, a dedicated systemd **user**
manager, and a private Unix socket joining API and reconciler. Each was
individually defensible (durable SQLite state, crash/reboot recovery, recordings
outside the API process, no public transition endpoint), but together they
created lifecycle races that plain JavaScript does not have — "systemd says the
process started" does not mean "the socket is bound and ready." The install
failures (socket-not-created races, sandbox hiding `boot_id`, read-only mount vs
SQLite open, timer enabled before the API bound its socket) were symptoms of
that coordination surface, not isolated bugs.

The conclusion: hardening and theoretical recovery were optimized before the
basic recording path was proven. A `setInterval` reconciliation loop is not
inherently less reliable than a systemd timer; with persisted schedules and a
startup reconciliation pass it is simpler to reason about and would have avoided
every failure hit during acceptance.

## Goal & principles

- Reliably record scheduled YouTube live streams, multiple in parallel — same
  core goal as `spec.md`.
- **SQLite = single source of truth + queue**, still. No hosted DB server.
- **The application owns its own scheduling and supervision.** systemd (or any
  init) does one job only: keep the three long-running Node processes alive and
  start them at boot. It no longer schedules recordings, supervises individual
  recordings, or stops them.
- **Ownership, not exclusivity, is the write discipline.** More than one process
  may write SQLite; no two processes ever write the same lifecycle fields. This
  is the core correction over both "one giant Node service" and the Phase 0
  split where the API and reconciler both participated in core state
  transitions.
- **A bad UI or API deployment must never stop or corrupt a live recording.**
  The recording core is narrowly scoped, rarely changed, and independently
  deployable; user-facing features churn on their own process and their own
  database.
- **Recordings survive process restarts and reboots** through durable SQLite
  intent + a startup reconciliation pass, not through detached init units. ⚠ See
  "Process restart vs. live recordings" — whether an in-progress capture
  survives a restart of the *recorder* process specifically is the one real
  tradeoff this design introduces and is not fully resolved in the source
  discussion.
- No auth for now, same single-middleware-seam posture and configurable listen
  host as `spec.md`. Tailscale/LAN/firewall/VPS remain deployment concerns.

## Components (three Node processes)

- **`rec-live-tronic-api`** — thin public HTTP control plane. Owns **recording
  intent**: create, edit schedule, cancel, source/cookie selection. It writes
  the essential *control* tables and nothing else. It does not spawn or touch
  Streamlink and does not write execution/run state.
- **`rec-live-tronic`** (the core recorder) — the durable, rarely-changed
  service. Owns **execution**: reads desired intent, starts and stops Streamlink
  **as its own direct child processes** (tracked by child/PID state), records
  observed runtime state, retries, and performs reboot recovery. It is the only
  writer of the *run/status/event* tables and the only thing that ever controls
  a Streamlink process. Its in-process reconciliation loop (`setInterval`)
  replaces the systemd reconciler timer.
- **`rec-live-tronic-web`** — optional UI/history/playback/maintenance layer.
  Owns its own *nonessential* tables and its own **worker sub-processes**
  (FFmpeg remux/preview, file serving, thumbnails, disk-space scans, deleting or
  moving old recordings). It talks to the essential system only through
  `rec-live-tronic-api`, and reads history/media through its own tables and
  supported interfaces. It can crash, evolve, or be redeployed without touching
  a recording.
- **streamlink** — the recorder binary, spawned directly by the core recorder as
  a child process. Still writes append-safe `.ts` (killable mid-write, still
  playable). Invocation flags and the "no `yt-dlp --downloader ffmpeg` path"
  rule from `spec.md` carry over unchanged.
- **ffmpeg** — remux/transcode, now owned by `rec-live-tronic-web`'s worker
  processes rather than a systemd `mux-*` unit.

The essential recording capability is exactly two processes —
`rec-live-tronic-api` + `rec-live-tronic` — over one SQLite file. Everything
non-essential lives in the third process over the second SQLite file, and its
absence or breakage cannot stop a recording.

## Two SQLite files

Separate *tables* in one file are a **logical** boundary, not a **concurrency**
boundary: SQLite allows only one writer at a time for the whole database file,
even in WAL mode. Short writes that each touch only their own tables are
workable, but web migrations, thumbnail jobs, and history updates can otherwise
delay the recorder's writes. To keep the recorder bulletproof the design uses
two physical files:

- **`rec-live-tronic.sqlite`** — essential. Holds API **intent/control** tables
  and recorder **execution/run/status** state. Written by `rec-live-tronic-api`
  (intent) and `rec-live-tronic` (execution) only, each to its own tables.
- **`rec-live-tronic-web.sqlite`** — disposable / rebuildable. Holds UI state,
  history indexes, FFmpeg job queues, playback/preview metadata, and disk-scan
  results. Written only by `rec-live-tronic-web` and its workers. Losing it must
  never harm a recording; it can be rebuilt from the essential DB and the
  filesystem.

⚠ Exact file locations are inferred from `spec.md`'s Phase 0 paths (both under
`/var/lib/rec-live-tronic`); not specified in the discussion.

## How recording works (the core mechanism)

Intent and execution are decoupled through the essential SQLite file rather than
through a live socket handshake:

1. `rec-live-tronic-api` validates a request and writes the **desired** state
   (a scheduled recording, an edited `stop_at`, a cancellation) into the control
   tables. It never launches or stops anything itself.
2. `rec-live-tronic` runs a periodic in-process reconciliation loop that reads
   desired state and converges the world to it: for a recording now inside its
   `[start_at, stop_at)` window with no live child, it spawns Streamlink; at
   `now >= stop_at` or on a cancellation it stops the child; it writes back the
   observed run/status. Because the recorder reacts to durable desired state, it
   needs no per-transition socket handshake with the API — removing the exact
   race that made Phase 0 brittle.
3. The API can expose a **joined view** of desired recording + current/last
   execution by reading both table groups, so clients see one coherent status
   without the API owning execution.

**Stopping.** The recorder itself sends `SIGTERM` to the Streamlink child at
`stop_at` (and on cancel). Streamlink finalizes the `.ts`; even a hard kill
leaves a playable file. There is no systemd `RuntimeMaxSec` backstop anymore —
the always-running, init-supervised recorder is the stopper, and the loop
re-checks every tick. ⚠ The precise stop signal/timeout and any
belt-and-suspenders cap are inferred, not stated.

**Reboot / restart recovery.** systemd (or init) restarts the three Node
processes at boot with `Restart=always`. On startup the recorder runs a
reconciliation pass: any recording still inside its window with no live child is
relaunched (append-safe `.ts` continues); a window that fully elapsed while the
box was down is marked `missed`. This mirrors `spec.md`'s self-healing rule but
is driven by the recorder's own startup pass, not by transient units being
absent after reboot. ⚠ The `boot_id` distinction between "lost to reboot" and
"exited on this boot" (a Phase 0 field) is assumed to carry over; not
re-discussed.

### ⚠ Process restart vs. live recordings (the one real tradeoff)

In Phase 0, recordings were **detached** systemd transient units, so restarting
the API or reconciler could not kill an in-progress capture. In this design the
recorder spawns Streamlink as **its own children** and tracks their PIDs, so a
restart of `rec-live-tronic` would, in the naive form, kill active captures
(recovered on the next startup pass, resuming the same append-safe `.ts`). The
design's answer is organizational: the recorder is deliberately the small,
stable, rarely-updated service, so restarts are rare — churn happens in the API
and web processes, which cannot touch the children. Whether this is acceptable,
or whether the recorder should re-adopt a detach-and-track mechanism (e.g.
double-fork / a lightweight per-recording supervisor) to make captures survive
its own restart, was **not settled** in the discussion and must be decided
before this becomes a plan.

## Inter-process communication

- **API → recorder:** via the `rec-live-tronic.sqlite` intent tables only. The
  recorder polls/reacts; no request/response socket in the record path.
- **web → essential system:** only through `rec-live-tronic-api` (HTTP), plus
  reading whatever the API exposes. The web layer must **not** directly delete,
  move, or FFmpeg a file belonging to a scheduled or active recording; such
  requests go through a maintenance-request table or an API command that the
  owning service acts on. This keeps optional features from corrupting the
  recorder's invariant.
- ⚠ Whether the recorder also keeps a *small private control socket* for
  low-latency actions (e.g. immediate cancel without waiting a tick) is
  **open**. It was floated early in the discussion, then de-emphasized in favor
  of pure SQLite-intent polling. Default assumption: no socket — rely on a short
  reconciliation interval — unless immediate cancellation latency proves it
  necessary.

## Ownership / write matrix (the core invariant)

| Table group | Sole writer | File |
|---|---|---|
| Recording **intent** (create/edit/cancel, source, cookie) | `rec-live-tronic-api` | `rec-live-tronic.sqlite` |
| **Execution** run/status/event (Streamlink lifecycle, retries, recovery) | `rec-live-tronic` | `rec-live-tronic.sqlite` |
| UI / history / preview / maintenance / disk scans | `rec-live-tronic-web` (+ its workers) | `rec-live-tronic-web.sqlite` |

Only `rec-live-tronic` may create, stop, or mark a *recording execution*; every
other component asks for it by writing intent. This prevents split-brain SQLite
writes and keeps recovery behavior auditable. ⚠ Concrete field/column lists were
not specified in the discussion; the `recordings`/`cookies`/`candidates` shapes
in `spec.md` are the starting point, re-partitioned into intent vs. execution
columns.

## API surface

- `rec-live-tronic-api` keeps the curl-first public surface from `spec.md`
  (recordings CRUD + live `stop_at` edit + cancel, cookies, candidates), but its
  handlers now write **intent** and read a joined intent+execution view instead
  of driving systemd. The public contract to clients is intended to stay
  compatible with `spec.md`'s routes.
- `rec-live-tronic-web` exposes its **own** separate HTTP surface for
  nonessential features (history, file serving/streaming to VLC, previews,
  disk-space, delete/move of *finished* recordings) backed by
  `rec-live-tronic-web.sqlite`, calling `rec-live-tronic-api` for anything that
  touches essential state.
- ⚠ Exact route split between the API process and the web process, and the
  maintenance-request table shape, are open.

## Build phases (⚠ not sequenced in the discussion)

The discussion did not lay out phases; this ordering is a suggestion consistent
with the "prove the record path first" lesson and must be confirmed:

- **Phase 0′:** `rec-live-tronic` (recorder core) + `rec-live-tronic-api` over
  `rec-live-tronic.sqlite`, Streamlink spawned directly, in-process
  reconciliation loop, startup recovery. Init supervises the two processes only.
  Usable via curl; records `.ts` reliably.
- **Phase 1′:** `rec-live-tronic-web` as a separate process over
  `rec-live-tronic-web.sqlite`: history, file/stream serving, and its worker
  sub-processes (FFmpeg remux, thumbnails, disk scans, retention). Independently
  deployable.
- Later: candidates, auth seam, retention policy — same as `spec.md`, relocated
  onto the web process where nonessential.

## Open decisions (resolve before this becomes a plan; do NOT invent)

- ⚠ **Recorder restart vs. live captures** — accept "recorder restart kills and
  then resumes the capture," or re-introduce a detach/track mechanism so
  captures outlive a recorder restart. The central unresolved tradeoff (see
  above).
- ⚠ **Immediate-action control socket** — keep pure SQLite-intent polling, or
  add a small private recorder control socket for zero-latency cancel/stop.
- ⚠ **Reconciliation interval** — the loop tick for the recorder (Phase 0 used a
  30s systemd timer). Prefer one hardcoded constant unless it must differ
  between dev and host.
- ⚠ **Init supervisor** — the discussion assumes a plain
  `Restart=always` supervision of three long-running services. Whether that is a
  minimal systemd system unit each (no user manager, no transient units, no
  timers, no private socket) or another supervisor is unconfirmed. Simplest
  reading: three ordinary system services.
- ⚠ **Execution vs. intent column partition**, exact table/field names, and the
  web-side maintenance-request table shape.
- ⚠ **SQLite file locations / ports** for each process (inferred from `spec.md`
  paths; not stated).
- Carried over from `spec.md`: final container (mkv vs mp4), candidate import
  format, retention semantics — unchanged and still open.

## Applying the simplicity guideline

Per `plan.md`'s simplicity guidelines, this candidate deliberately **removes**
machinery rather than adding it: no systemd user manager, no per-recording
transient units, no private API↔reconciler socket race, no `RuntimeMaxSec`
backstop coordination. Hardcode intervals and paths; make configurable only what
genuinely differs between dev and host (listen host/port). No integrity/checksum
ceremony for internal artifacts. Tests remain the safety net — the same
functional suites (server workflow + recording lifecycle) must cover
schedule → start → extend/shorten/stop → recorded, cancel, missed, early exit,
and reboot recovery against the new in-process recorder, replacing the
systemd-stub boundary with a direct-child-process boundary. Do not add
generic/extensible abstraction beyond the three processes and two files
described here.

## Non-goals

Same as `spec.md`: auth, transcoding automation, retention automation, and UI
are not part of the essential record path. Additionally, this candidate treats
per-recording init supervision, a user-bus systemd manager, and a live
API↔recorder transition socket as **explicit non-goals** — the failures they
caused are the reason for this redesign.

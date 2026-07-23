# YouTube Live Recorder implementation plan

This plan turns `spec.md` into an implementation sequence. Phase 0 is the first
release and must be independently usable from `curl`. Later phases do not alter
the Phase 0 recording path.

## Simplicity guidelines (all future work)

These govern every new block from here on. They do not retroactively rewrite or
weaken already-shipped Phase 0 behaviour — the systemd hardening flags,
permission modes, sole-SQLite-writer invariant, sandboxed transient units, and
existing configuration all stay exactly as they are. "Simplify" means build the
next thing simply, not rip out working infrastructure.

- **Hardcode over configure.** Only make something configurable when it must
  genuinely differ between dev and the target host (paths, ports, the listen
  host). Anything that could theoretically vary but never will in practice is
  just a hardcoded constant.
- **Minimise code.** Every line is a maintenance liability. Prefer the standard
  library or an existing dependency's built-in behaviour over hand-rolled
  machinery, and never build generic/extensible abstractions for a single
  current use case.
- **No integrity/checksum ceremony for internal deploy artifacts** moving
  between machines the owner controls: tar it, copy it, untar it — that is the
  whole verification story. This is deploy-pipeline ceremony, not a safety
  property; it does not relax the real recording/security architecture
  (SQLite sole-writer, no-shell-injection, sandboxed transient units, etc.),
  which stays intact.
- **Never weaken test coverage to simplify.** Tests are the regression safety
  net; simplification targets implementation and process, not verification. If
  removing a code path removes its reason to exist, delete the now-dead test
  with it — but never leave behaviour untested to save effort.

## Decisions made for Phase 0

- Use Node.js 24 LTS, TypeScript compiled to JavaScript, npm, Express, and
  `better-sqlite3`. Production runs compiled JavaScript with `node`; it does
  not run TypeScript or require Deno/Bun. Keep SQL parameterized and explicit
  behind small repositories rather than adding an ORM.
- Run the API and reconciler as the same dedicated, non-login Unix account,
  `rec-live-tronic`. Neither process nor any recorder runs as the SSH user or
  as root.
- Install the API and reconciler as system services with
  `User=rec-live-tronic`. Enable a lingering systemd user manager for that
  account; the reconciler uses `systemd-run --user` and `systemctl --user` to
  manage unprivileged `rec-<id>.service` transient units. Do not add sudoers or
  polkit rules.
- Express has a configurable listen host and initially binds `0.0.0.0` so the
  same service is reachable over the home LAN and Tailscale. The application
  does not configure or require Tailscale, a reverse proxy, DNS, or a particular
  firewall. Those remain deployment policy, including on a future VPS.
- Keep the API as the sole SQLite writer. The reconciler reads SQLite directly
  and sends status compare-and-set requests to an API listener on a private Unix
  socket. Public routes never accept arbitrary status changes.
- Store private state under `/var/lib/rec-live-tronic` and recordings under
  `/srv/rec-live-tronic/recordings`. Phase 0 gives the optional `rec-media`
  group direct read-only media access without granting access to SQLite or
  cookies. The next shared-intranet block below intentionally expands this
  policy.
- Generate recording IDs in the API and derive unit names and output paths only
  from those IDs. Titles, URLs, quality strings, uploaded filenames, and other
  request data never become command fragments or filesystem paths.
- Capture Streamlink's binary `--stdout` with systemd
  `StandardOutput=append:<recordings-root>/<id>.ts`; keep logs on stderr in the
  journal. Streamlink 8.4's `--output` prompts for an existing file and
  `--force` overwrites it, so the literal `-o` invocation sketched in `spec.md`
  cannot implement its required reboot-safe append behavior. This narrow
  invocation correction retains Streamlink as the direct transient-unit
  process and needs no shell or wrapper.
- The reconciler is the authoritative scheduled stopper: once `now >= stop_at`
  it invokes `systemctl --user stop rec-<id>` and waits for the unit to become
  inactive before changing durable status. `RuntimeMaxSec` is only systemd's
  dead-reconciler backstop. Streamlink is never trusted to enforce `stop_at`.
- Live control is part of Phase 0. The API derives `rec-<id>.service` from the
  durable ID rather than storing a PID. `PATCH stop_at` commits SQLite before
  adjusting the live unit's backstop; cancellation commits first and then
  immediately asks systemd to stop the unit instead of waiting for the next
  30-second reconciliation tick.
- Add an internal `last_started_boot_id` recording field. It distinguishes a
  transient unit lost during reboot (relaunch within the active window) from a
  unit that ended on the current boot (finalize according to file presence).
  This resolves an ambiguity between reboot recovery and early-exit handling in
  `spec.md`.

## Verified target-host baseline

Read-only inspection of `irae-sheeta` on 2026-07-21 found:

- Debian 13 (`trixie`), x86-64, Linux 6.12, systemd 257.
- The system and SSH user's systemd managers are running; lingering is not
  currently enabled for the SSH user. `systemd-run` supports the transient-unit
  options required by the spec.
- `ffmpeg` 7.1 is installed. Streamlink 8.4.0 is installed through pipx at
  `/home/irae/.local/bin/streamlink`; it works interactively but is owned by and
  coupled to the human account, so production will not use that installation.
- Node.js, npm, Corepack, and the SQLite CLI were not found.
- Tailscale 1.98.9 is active and enabled. The initial deployment can be reached
  through the node
  `irae-sheeta.tailc9708.ts.net`, and no Tailscale Serve configuration exists
  or is needed. This is host context, not an application dependency.
  Unprivileged user namespaces are enabled, which supports the proposed
  user-unit hardening.
- The root filesystem has about 139 GB free. `/tmp` is a small tmpfs and must
  not hold recordings.
- The SSH account has no sudo/admin group. No existing recorder systemd units
  were found.

### Root-installed dependencies

The operator installs these before running the repository's installer:

- Node.js 24 LTS, including npm.
- A `better-sqlite3` version supporting Node 24, installed by the locked npm
  dependency set and packaged in the Debian x86-64 release tarball. The target
  server does not install a compiler, Python build tooling, or development
  headers.
- pipx plus a root-managed global Streamlink installation, initially pinned to
  the already-proven 8.4.0 release and exposed as
  `/usr/local/bin/streamlink`. Provision its environment under `/opt/pipx`
  (for example with root's `PIPX_HOME=/opt/pipx` and
  `PIPX_BIN_DIR=/usr/local/bin`) rather than under `/root`, whose directories
  the service account cannot traverse. It is executable by all local users but
  its code and environment are writable only by root. Do not reuse or alter
  the human-owned installation under `/home/irae/.local`.
- SQLite CLI for diagnosis and backup checks. `better-sqlite3` supplies the
  application's SQLite binding.
- `ffmpeg` is not needed until Phase 5 (trim/split editing) and is already present.

The root installer verifies versions and capabilities; it does not silently
install OS packages or alter the existing human-owned streamlink installation.

## Planned repository layout

The repository currently contains no application scaffold. Phase 0 creates:

- `package.json` and `package-lock.json`: pinned runtime/development
  dependencies and `build`, `test`, `dev`, `start`, `reconcile:once`, and
  `db:migrate` scripts.
- `tsconfig.json`: strict Node ESM compilation from `src/` to `dist/`.
- `Dockerfile.build`: reproducible Debian 13 x86-64 build/test/release
  environment with the compiler toolchain needed by native npm modules.
- `scripts/build-release.sh`: invokes Docker for `linux/amd64`, runs clean
  install/build/tests, prunes development dependencies, verifies the native
  SQLite binding, and emits the installable tarball plus checksum.
- `.env.example`: non-secret configuration names, including initial
  `REC_LIVE_HOST=0.0.0.0` and `REC_LIVE_PORT`, plus safe local defaults.
- `src/config.ts`: loads and validates the listen host/port, paths, streamlink
  executable, timer/runtime limits, and the private socket path.
- `src/app.ts`: exports `createApp(deps)`, public Phase 0 routes, consistent
  errors, and request validation.
- `src/server.ts`: opens the database, creates services, and starts the public
  configured TCP listener plus the private Unix-socket listener.
- `src/db/connection.ts`: opens SQLite, enables WAL, foreign keys, busy timeout,
  and safe file modes.
- `src/db/migrate.ts` and `migrations/001-phase-zero.sql`: idempotent schema
  migration entry point and the Phase 0 schema.
- `src/recordings/repository.ts`: `RecordingRepository` reads plus atomic
  create/cancel/status compare-and-set operations.
- `src/recordings/service.ts`: schedule validation, live stop-time changes,
  immediate cancellation, and other public recording use cases.
- `src/cookies/repository.ts` and `src/cookies/service.ts`: metadata and safe,
  atomic cookie-file lifecycle.
- `src/reconciler/reconcile-once.ts`: exports deterministic
  `reconcileOnce(now, bootId, deps)` with no durable in-memory state.
- `src/reconciler/main.ts`: one-tick process entry point.
- `src/reconciler/systemd-client.ts`: `SystemdClient` implementation for
  listing, starting, stopping, and inspecting only derived `rec-*` user units.
- `src/reconciler/streamlink-command.ts`: `buildStreamlinkArgs(recording,
  cookie, config)` and transient-unit property construction.
- `scripts/install-root.sh`: short, auditable root-side installer, reviewed and
  run manually. A full run provisions the host and installs all three packages;
  piece flags (`--deps`, `--web`, `--reconciler`) do a fast partial redeploy of
  only the named packages on an already-provisioned host. Every selected package
  is extracted and replaced unconditionally, with no change detection.
- `scripts/install-sheeta.sh`: personal one-command local wrapper for the owner's
  `irae-sheeta` host that scps the artifacts plus `install-root.sh` and runs it
  over SSH; supports the same full and partial-piece flags. Deliberately absent
  from the README, which documents only the host-agnostic install path.
- `systemd/rec-live-tronic-api.service`,
  `systemd/rec-live-tronic-reconciler.service`, and
  `systemd/rec-live-tronic-reconciler.timer`: root-owned system units for the
  API and 30-second reconciliation tick.
- `test/functional/server.test.ts` and
  `test/functional/recording-lifecycle.test.ts`: the two feature-level suites,
  with shared process/SQLite/filesystem/systemd-stub helpers under
  `test/functional/support/`.
- `README.md`: dependency, build, installation, curl, diagnosis, and upgrade
  instructions.

## Functional test approach

Keep automated testing proportional to this small project. Use `tap` as the
test framework and TypeScript test runner. Do not add unit
tests for repositories, command builders, migrations, configuration parsing,
the release tarball, or the installation script. `npm test` builds the program
and runs two functional suites against its real process entry points:

- The server suite starts the compiled HTTP server with a temporary SQLite
  database and filesystem, then exercises health, cookie upload, scheduling,
  listing, persistence across restart, live edits, validation, and cancellation
  through HTTP.
- The recording-lifecycle suite starts the compiled server, invokes the real
  one-tick reconciler process, and supplies stub `systemd-run`/`systemctl`
  executables at the operating-system boundary. It exercises schedule → start
  → extend/shorten/stop → recorded, cancellation, missed windows, early exit,
  launch/claim interruption, and reboot recovery as complete scenarios.

The stubs record argv and model unit state; tests assert observable API status,
files, and stop/start effects rather than individual functions. Real systemd,
Streamlink, the release tarball, and the root installer get pragmatic smoke
checks during the `irae-sheeta` acceptance run and are debugged there if they
fail.

Test file initialization and feature blocks:

```ts
// test/functional/server.test.ts
import t from "tap";
import { startFunctionalServer, stopFunctionalServer } from "./support/server.js";

t.before(startFunctionalServer);
t.teardown(stopFunctionalServer);

t.test("serves health and the complete cookie and recording workflow");
t.test("persists scheduled data across a server restart");
t.test("validates requests without corrupting existing state");
t.test("edits and cancels a live recording through public HTTP behavior");
```

```ts
// test/functional/recording-lifecycle.test.ts
import t from "tap";
import {
  startLifecycleHarness,
  stopLifecycleHarness,
} from "./support/lifecycle.js";

t.before(startLifecycleHarness);
t.teardown(stopLifecycleHarness);

t.test("records a scheduled window and stops it at the durable deadline");
t.test("extends, shortens, and immediately cancels running recordings");
t.test("converges after early exit and launch/claim interruption");
t.test("recovers an active window after reboot and marks missed windows");
```

## Phase 0 — done

Built, installed, and live-acceptance-tested on `irae-sheeta`. The architecture
later phases build on is captured here and in "Decisions made for Phase 0" above
and "Operational invariants" below.

Built:

- Node 24 / TypeScript Express API + finite reconciler tick + Streamlink,
  over SQLite (WAL, `better-sqlite3`). Root-owned system units: API service,
  reconciler oneshot, and a 30-second reconciler timer. Containerized
  `linux/amd64` release build and an auditable `scripts/install-root.sh`.
- API is the sole SQLite writer; the reconciler reads SQLite and claims status
  transitions over a private Unix socket (never a direct DB write, never a
  public status route).
- Recordings run as detached `rec-<id>` transient `systemd --user` units under
  the dedicated non-login `rec-live-tronic` account (lingering user manager, no
  sudo/polkit). Streamlink's binary `--stdout` is appended to
  `<recordings-root>/<id>.ts` via `StandardOutput=append:`; units survive
  API/reconciler restart. The reconciler is the authoritative scheduled stopper;
  `RuntimeMaxSec` is only the dead-reconciler backstop.
- Server-generated opaque IDs; unit names and output paths derive only from the
  ID. No request data reaches a shell or becomes a unit/path identifier.
- Paths: private state under `/var/lib/rec-live-tronic` (+ `cookies/`),
  recordings under `/srv/rec-live-tronic/recordings`, config under
  `/etc/rec-live-tronic`.
- `quality` defaults to `best` and is PATCH-able while `scheduled`.
- Shared `rec-media` group: `irae` and any assigned media users get read/write
  on recordings, recorder logs, and cookies (group-write via `UMask=0007`).
  Recorder stderr is redirected to the shared group-owned log tree.

Verified live on `irae-sheeta`:

- Concurrent recordings (two overlapping windows, distinct cookies).
- Live extend and shorten of `stop_at` on a running recording; systemd stops it
  at the new durable deadline.
- Cancel mid-recording: API persists `cancelled` and stops the unit immediately
  without waiting for a tick.
- Reconciler convergence after API downtime (failed tick, restart, no duplicate
  unit or corrupted state).
- Window expiry → playable `.ts`, `recorded` status, no live unit, persistent
  across API restart. Elapsed never-started window → `missed`.
- Cookie upload via curl with safe response and disk permissions.
- Group-write shared access as `irae` over SSH with no `su`/`sudo`: tail a live
  recording's log and read a cookie file directly from the shared tree.

Invariants later phases must not violate (see "Operational invariants" for the
full list): API stays the sole SQLite writer; recordings are detached transient
units, not children of the API/reconciler; `rec-media` read/write access is via
group-write (`UMask=0007`), while SQLite control state stays reachable only
through the private socket.

## Phase 1 — done

Built, installed on `irae-sheeta`, and live-verified.

Built:

- **VLC-openable streaming route.** `GET /recordings/:id/file` on the existing
  public Express API serves finished (`recorded`/`muxed`) files through
  `response.sendFile()`, which supplies `Range`/`206`/`Content-Length` handling
  so seeking works with no hand-rolled range logic. `404` when the recording
  does not exist, `409` while `scheduled` or `recording` (serving a growing
  in-progress file stays a non-goal). Same public `0.0.0.0` listener and
  open-access posture as every other route; the stable per-file URL is
  `http://<host>:<port>/recordings/<id>/file`.
- **Split release into `web`, `reconciler`, and `deps` packages.** Three plain
  `.tar.gz` artifacts (no checksums, no manifests) from the single container
  build; `/opt/rec-live-tronic/{deps,web,reconciler}`, with `web` and
  `reconciler` resolving `node_modules` through a symlink to
  `../deps/node_modules`. A code-only deploy ships just the changed
  `web`/`reconciler` tarball and skips the large `deps` transfer unless
  `package-lock.json` differs (`cmp`).

Verified live on `irae-sheeta`:

- VLC streaming with accurate seeking on real YouTube-derived content.
- Full package-split install completed live with two recordings actively
  running and unaffected; independent `web`/`reconciler` redeploy leaves the
  other service and any live `rec-*` units untouched.

## Later phases

These are separate larger blocks. Resolve each listed open decision immediately
before its phase and commit completed blocks, not their sub-steps.

**Removed — HTTP log tailing.** The former `GET /recordings/:id/log` route is
dropped entirely: §0.7's shared `rec-media` group already gives direct
filesystem read of Streamlink's logs at `<recordingsDir>/<id>.log` (confirmed
in live testing, since Streamlink's stderr already appends there), so no HTTP
tailing route is needed.

### Phase 2 — web client — done

Built, installed on `irae-sheeta`, and live-verified. A mobile-first, responsive
Vue 3 SPA served as static files by the existing `web` Express service, plus one
new backend behaviour (a hard delete that removes both the file and its SQLite
row). This replaces the former decision-narrative, design-prototype gate,
implementation-sequence, and acceptance-checklist detail.

Built:

- **Vue 3 + Vite SPA** under `web-client/` (git-tracked). Runtime dep `vue`;
  dev-only `vite` + `@vitejs/plugin-vue`; Single-File Components with
  `<script setup>`. Client-side routing via `vue-router` at `/`, `/schedule`,
  `/watch/:id` with an SPA-fallback route in `src/app.ts` so deep-linking or
  refreshing a client route works. State is component-local (`ref`/`reactive` +
  `fetch`); no Pinia/Vuex. Output is plain static JS/CSS/HTML — no SSR, no second
  service, no change to deployment shape.
- **Layout:** `web-client/index.html`; `web-client/vite.config.ts`
  (`@vitejs/plugin-vue`, `root: "web-client"`, `build.outDir: "../dist/public"`,
  and a dev-server `proxy` forwarding `/recordings`, `/cookies`, `/health` to the
  local API); `web-client/src/main.ts`, `src/App.vue`, `src/api.ts` (a thin
  `fetch` wrapper — the single place that knows route paths); views under
  `web-client/src/views/` (`ArchiveView.vue`, `ScheduleView.vue`,
  `RecordingDetail.vue`); shared `web-client/src/components/RecordingList.vue`.
- **Build/serve:** `build:client` (`vite build`) and `dev:client` (`vite dev`)
  scripts; `build` = `npm run clean && tsc -p tsconfig.json && vite build`, so the
  client lands in `dist/public`. `src/app.ts` serves it via
  `express.static(<dist>/public)` mounted at `/` **after** the API routes so it
  never shadows `/recordings`, `/cookies`, `/health`. The `web` release package
  already ships `dist/`, so `dist/public` rides along — no change to the
  deps/web/reconciler package boundaries.
- **Views (existing Phase 0/1 routes only).** `GET /recordings` filters by a
  single status (`?status=<one>`), so the client fetches it once and partitions
  client-side. `ArchiveView` keeps `recorded` rows (newest first).
  `ScheduleView` keeps `scheduled`+`recording`, and does create
  (`POST /recordings`), edit (`PATCH /recordings/:id`), soft cancel
  (`DELETE /recordings/:id`, keeps the row `cancelled`), stop-early
  (`PATCH stop_at = now` while `recording`), and start-now
  (`PATCH start_at = now` while `scheduled`) — no dedicated start/stop endpoints.
  `RecordingDetail` reads `GET /recordings/:id` and holds the delete control.
- **Playback + share (`RecordingDetail.vue`).** `mpegts.js` player (client-side
  MSE transmuxing — no current major browser natively plays a standalone `.ts`
  via a plain `<video src>`; see `docs/browser-playback-research.md`) against
  `GET /recordings/:id/file`. Always-present "copy stream URL" button putting the
  plain `http://<host>:<port>/recordings/<id>/file` URL on the clipboard for
  pasting into VLC's *Open Network Stream*. Optional, best-effort, iOS-only
  "Open in VLC" link using `vlc-x-callback://x-callback-url/stream?url=<stream-URL>`,
  framed as "may not always work — use copy-URL if it doesn't."
- **`stage` label.** A real **optional** nullable `TEXT` column via
  `migrations/003-recording-stage.sql` that round-trips through the existing
  `GET /recordings` and `GET /recordings/:id` responses. Populated once at
  creation in `RecorderService.createRecording`: the middle segment of a
  `"Artist - Stage - Festival"` three-part `" - "` title, else a best-effort
  YouTube oEmbed lookup (`REC_LIVE_OEMBED_ENDPOINT`, `author_name`) for the
  channel name. That call has a short timeout and never blocks or fails creation
  — `stage` stays null on any error. The endpoint is config so tests point it
  off-network.
- **Hard delete (the one new backend behaviour).** `DELETE /recordings/:id/file`
  performs a full purge — unlinks the file(s) (`ts_path`, future `final_path`)
  **and** deletes the SQLite row, so neither a dangling row nor an orphaned file
  is left. `RecordingRepository.delete(id)` (API stays the sole SQLite writer) +
  `RecorderService.deleteRecording(id)`: `404` if absent, `409` unless status is
  `recorded` (a `scheduled`/`recording` row cancels through
  `DELETE /recordings/:id` instead), `500` on any unlink failure other than
  already-missing (row left intact so the delete is retryable), `204` on success.
  This is the only deletion mechanism in the system — no age/size auto-cleanup.
- **`AGENTS.md`** at the project root documenting local dev/debug commands and
  ports (`npm run dev:client`, `npm run build`, `npm test`, curl checks).

Verified live on `irae-sheeta`: schedule / edit / cancel / stop-early / start-now
from the UI against real recordings; archive lists and plays finished recordings;
delete removes both file and row; copy-URL opens the stream in VLC; the iOS
"Open in VLC" link appears on iOS only and degrades silently to copy-URL;
phone-width and post-breakpoint desktop layouts both verified; Playwright
iPhone-profile and desktop smoke passes green; curl parity holds (no browser-only
path).

### Phase 3 — trash / retention

**Complexity: Medium.** Turns today's single destructive delete into a
reversible soft-delete with a dedicated trash view, restore, permanent delete, a
global disk-space readout, and a deliberately simple 30-day auto-purge. The Phase
0 invariants are untouched: the API stays the sole SQLite writer, the reconciler
is not involved, and the only new on-disk effect is a row update (no new
`ReadWritePaths=` directory, so no `ProtectSystem=strict` change — confirm
against `systemd/rec-live-tronic-api.service` regardless before shipping).

**First step is a design-and-pause gate** (same shape as Phase 2's
design-prototype gate — a real stop-and-ask point, not just a bullet). A separate
MEDIUM-tier frontend-design agent is, in parallel with this plan, building
**only** the trash view's static UI shell with stub/mock data — no backend
wiring. That shell is **gated: the owner reviews and approves it before any
backend wiring proceeds.** Everything below (the `trashed_at` field, endpoints,
restore/permanent-delete actions, disk-space readout, auto-purge) is built only
after that approval lands. Do not begin backend work until the owner signs off on
the shell.

**Data model change (decision).** Deletion becomes reversible. Add a durable
**nullable `trashed_at`** timestamp column to `recordings` via
`migrations/004-recording-trash.sql` (the next sequential migration after
`003-recording-stage.sql`), null for every existing row. A non-null `trashed_at`
means "in trash": the row stays in SQLite and its file(s) stay on disk, but it is
excluded from the normal Archive/Schedule listings. This replaces the Phase 2
behaviour where `DELETE /recordings/:id/file` unlinked the file and deleted the
row in one irreversible step. `trashed_at` round-trips through the existing
`GET /recordings` / `GET /recordings/:id` responses — add it to `selectColumns`,
the `RecordingRow` mapping, and the `Recording` shape in
`src/recordings/repository.ts`, exactly as `stage` was. Trash is **orthogonal to
status**: a trashed row keeps its terminal `recorded`/`muxed` status and merely
gains a `trashed_at`, rather than introducing a new `trashed` status value.

**API surface (curl-first)** — matches spec.md's "API surface (curl-first)"
conventions.

- `DELETE /recordings/:id/file` **now means "move to trash", not purge.** It sets
  `trashed_at = now` on a finished (`recorded`/`muxed`) row and returns `204`;
  file and row both survive. Same gate as the Phase 2 purge: `404` if absent,
  `409` if not finished (a `scheduled`/`recording` row still cancels through
  `DELETE /recordings/:id`). Trashing an already-trashed row is a no-op `204`.
- `POST /recordings/:id/restore` (new) — clears `trashed_at` back to null and
  returns the restored row (`200`); `404` if absent, `409` if the row is not
  currently trashed. The row reappears in the normal Archive listing.
- `DELETE /recordings/:id/trash` (new) — **permanent delete**, distinct from the
  30-day sweep. Performs the old Phase 2 purge routine: unlink the file(s)
  tolerating already-missing, then delete the SQLite row; `204` on success, `500`
  on any unlink failure other than already-missing (row left intact, safely
  retryable). Gated to **trashed rows only** (`409` if `trashed_at` is null — you
  cannot permanently delete something not in trash), `404` if absent. This is the
  *same* purge routine the 30-day sweep calls — factor it into one function so
  both call sites share it.
- `GET /recordings` gains a `trashed` filter for the trash view. Today
  `?status=<one>` filters by a single status; trash cuts across status, so add a
  separate boolean param: `GET /recordings?trashed=true` returns only trashed
  rows (newest-trashed first). The default `GET /recordings` **and every
  `?status=` filter now exclude trashed rows**, so Archive and Schedule never
  surface trashed items without opting in. The trash view issues its own
  `GET /recordings?trashed=true` fetch (a disjoint set from the archive, so it
  does not fold into the client's existing fetch-once-and-partition pattern).

**Disk-space readout (global header — corrects the earlier trash-view-only
framing).** Disk space is shown in a **global header view present across the
whole app**, not inside the trash view. It is fed by the **existing client
polling loop** (`ScheduleView.vue` already polls every 60s — the header reads the
same periodic refresh) so it "always" shows current free space. Two figures:

- **Actual free space** on the recordings filesystem — server-side `fs.statfs`
  (Node) of the recordings directory.
- **Projected free space** — actual free space adjusted for the bytes still being
  consumed by in-progress captures: only rows currently `recording` (whose `.ts`
  is open and growing) count toward the projection. **`scheduled`-but-not-started
  rows are explicitly excluded** ("based on partial files, **not** scheduled")
  because their eventual size is unknown, so they are never projected.

Disk space piggybacks on the existing client polling — the server computes the
two figures and returns them alongside whatever the client already polls (exact
endpoint carrying them is a small implementation choice; see the note at the end
of this phase).

**UI.**

- **Trash view** — a new SPA screen/route (e.g. `/trash`, alongside `/`,
  `/schedule`, `/watch/:id`); its static shell is the gated first step above.
  Lists trashed rows from `GET /recordings?trashed=true`, each with a **Restore**
  action (`POST /recordings/:id/restore`) and a **Permanent delete** action
  (`DELETE /recordings/:id/trash`). Disk space is **not** shown here — it lives in
  the global header now.
- **Global header disk-space readout** — the actual/projected figures above, on
  the app header across all views.
- **Soft-delete confirmation flow.** The Archive/detail "remove" control now
  trashes instead of purging. Because trashing is reversible, its previous
  hard-warning confirmation dialog is **removed/simplified** — the current
  `RecordingDetail.vue` copy ("Deleting removes the recorded file from disk for
  good. There is no undo and no copy kept anywhere else.") no longer applies and
  must change, since delete is now undoable from trash. (Owner's "implemented on
  UI, remove dialog" = remove the *confirmation dialog* on the now-reversible
  delete, **not** remove the delete control itself.) Permanent delete in the trash
  view keeps a confirmation — that action is irreversible.

**30-day auto-purge (deliberately simple — owner-specified, do not
over-engineer).** The owner explicitly rejected a reconciler-, cron-, or
systemd-timer-driven design here and accepts the pitfalls. Implement exactly as
specified: on **app start**, run one purge pass that calls the shared
permanent-delete routine on every row whose `trashed_at` is older than 30 days;
then a plain `setInterval` re-checks **once per day** for the process lifetime.
No reconciler involvement, no systemd timer, no downtime catch-up beyond "it runs
again on next start". Accepted pitfalls, called out as OK: if the process is down
when a row crosses 30 days, it is simply purged on the next start or the next
daily tick — nothing tracks missed windows. It lives in the `web` service start
path (`src/server.ts`). Per the owner's backlog this auto-purge is slotted to
*land* in **Phase 8** (see Phase 8); the full mechanism is specified here because
it shares Phase 3's permanent-delete routine, and manual permanent-delete covers
retention until then.

**Functional tests** (server suite, test names only):

```ts
// test/functional/server.test.ts (additional blocks)
t.test("moves a finished recording to trash instead of purging it");
t.test("excludes trashed recordings from the default and status-filtered listings");
t.test("lists only trashed recordings via ?trashed=true");
t.test("restores a trashed recording back into the archive listing");
t.test("rejects restoring a recording that is not in trash");
t.test("permanently deletes a trashed recording's file and row");
t.test("rejects permanent delete of a recording that is not in trash");
t.test("rejects trashing a recording that is not finished");
t.test("purges only trash older than thirty days on the startup sweep");
```

**Implementation sequence.** (The design-and-pause gate at step 1 is an
owner-review checkpoint *within* the phase, not the finish line.)

1. **Trash-view design-and-pause gate** — the parallel MEDIUM frontend-design
   agent's static shell with stub data. Pause for owner approval before any
   backend wiring.
2. Add `migrations/004-recording-trash.sql` (nullable `trashed_at`); extend
   `selectColumns`, the `RecordingRow` mapping, and the `Recording` type in
   `src/recordings/repository.ts` to carry it; existing rows default to null.
3. Repository methods (API stays the sole writer): `trash(id)` (set
   `trashed_at`), `restore(id)` (clear it), and a shared `purge(id)` (unlink
   file(s) + `DELETE FROM recordings`); extend `list()` so the default and
   `status` queries exclude `trashed_at IS NOT NULL`, and add a `trashed`-only
   query path.
4. `RecorderService` methods in `src/api/service.ts` for trash / restore /
   permanent-delete with the status-and-trash gates and `404`/`409`/`500`
   outcomes above; the auto-purge sweep calls `purge` for rows older than 30
   days.
5. Re-point `DELETE /recordings/:id/file` at the trash action; add
   `POST /recordings/:id/restore`, `DELETE /recordings/:id/trash`, and the
   `?trashed=true` filter in `src/app.ts`; add the disk-space figures to the
   polled response.
6. Web client: the trash view (restore / permanent-delete), the global-header
   disk-space readout, and the simplified soft-delete confirmation copy.
7. Wire the app-start + daily-`setInterval` 30-day sweep in `src/server.ts`.
8. Functional tests above; verify on `irae-sheeta` (trash a real recording,
   restore it, permanently delete it, confirm the archive excludes trashed rows
   and the disk figures read correctly).

**Acceptance criteria — what "Phase 3 done" looks like.**
- [ ] The owner approved the static trash-view shell before backend wiring began.
- [ ] Deleting a finished recording from the UI moves it to trash (file + row
      survive), not a hard purge.
- [ ] The archive and schedule listings exclude trashed rows; the trash view
      lists exactly the trashed rows.
- [ ] Restore returns a trashed recording to the archive; permanent delete
      removes its file and row and is gated to trashed rows only.
- [ ] The global header shows actual and projected free space, the projection
      counting in-progress captures but never scheduled rows, refreshed by the
      existing poll.
- [ ] The reversible delete no longer shows the old irreversible-warning dialog;
      permanent delete still confirms.
- [ ] The 30-day sweep runs on app start and once daily, purging only trash older
      than 30 days.
- [ ] curl parity holds for trash / restore / permanent-delete — no browser-only
      path.

**Open decision (small).** Which polled response carries the two disk-space
figures — extend the existing `GET /health`, or attach them to the periodic
`GET /recordings` the client already fetches. Resolve when wiring step 5; either
keeps the "fed by existing polling" property.

### Phase 4 — misc actions

**Complexity: Medium.** Scheduling and quality-picker quality-of-life plus a
raw-download affordance. Restates the owner's backlog; each item is small on its
own. Written at later-phase summary depth — the specific requirements below are
verbatim intent, resolve their fine details immediately before building.

- **Duration field pre-filled with `1:10` always.** The schedule form's duration
  input defaults to `1:10` on every new schedule (a fixed default, not a
  remembered last value).
- **"Now" tab on the schedule form.** A tab that **suppresses the date fields**
  and keeps only the duration; **only the YouTube URL is mandatory** to start
  recording immediately. (Distinct from Phase 2's `PATCH start_at = now`
  "start now" on an already-scheduled row — this creates-and-starts in one step
  from the form.)
- **Lower the reconciler tick to 10 seconds.** Specifically because "start now"
  currently misses too much when trying to start fast — the 30-second tick is too
  coarse for immediate starts. Drop the reconciler timer to a 10-second interval
  (`systemd/rec-live-tronic-reconciler.timer`).
- **Fetch YouTube metadata to pre-fill the title.** Pre-fill the schedule title
  from the channel name and the stream's own title. **Reuse the existing oEmbed
  lookup** already wired for the `stage` field (Phase 2 —
  `REC_LIVE_OEMBED_ENDPOINT`, reads `author_name`); do not reinvent a metadata
  system — extend that same call to also surface the stream title for the title
  prefill.
- **Quality picker driven by YouTube metadata.** The available-formats list comes
  from the stream's metadata. **`best` is always kept, shown with parens of what
  it resolved to** (e.g. `best (1080p60)`), followed by **2 extra pills ordered
  by quality**, and a **dropdown with all formats**. **Video-only until the
  audio-only phase exists** (Phase 6) — no audio-only entries appear here yet.
- **Download video as raw `.ts`, working even from trash.** A download affordance
  for the raw `.ts` (the Phase 1 `GET /recordings/:id/file` route already serves
  the bytes) that also works for a **trashed** recording, since its file is still
  on disk until permanently deleted.

### Phase 5 — editing actions

**Complexity: Medium.** Non-destructive derived-recording operations over
already-finished files, plus client-captured thumbnails. None of this touches the
recorder core. (Deleting/trashing a finished recording moved to Phase 2 / Phase
3; derived recordings created here are independent rows, trashed and deleted the
same way as any other recording.)

**First step is a research-and-review gate** (same shape as Phase 2's
design-prototype gate — a real stop-and-ask point). **Research question,
owner-reviewed before any building continues:** *can we show a preview of the
trimmed/split video before the user clicks "confirm", or should we split first
and make the result non-permanent so it can be undone until confirmed?*
Investigate both directions (in-player client-side preview vs.
produce-then-hold-uncommitted-until-confirmed) and **pause for the owner's
decision** before implementing the trim/split confirm UX. The job mechanism and
derived-row pattern below hold regardless of which preview model the owner picks;
the gate decides the confirm/undo UX wrapped around them.

Trim and split follow the **derived-recording-row** pattern: each produces one
or more new recording rows with their own server-generated IDs whose output
paths derive only from those new IDs. The source row, its `ts_path`, and its
`final_path` are never modified or deleted, so a bad operation is never
destructive.

**Job mechanism (decision).** Trim and split run as a **lightweight one-shot
tracked `ffmpeg -c copy` job**, not the fully reconciled, crash/reboot-
recoverable `mux-<id>` systemd machinery. These are quick, bounded operations on
finished files (seconds to a couple of minutes), so the heavier reconciled unit
type is unnecessary here — the owner's own framing when proposing trim was "easy
with the web process, no need to touch the recorder core". A short-lived tracked
job with simple durable state (the derived row lands `recorded` on atomic
success, `failed` on error, preserving every file either way) is sufficient.
Phase 8's remux inherits or extends this same mechanism (see Phase 8); this
mechanism is introduced here, so there is no forward reference to unbuilt
machinery. Offsets and cut points are validated numeric/`HH:MM:SS` values passed
as argv, never shell fragments.

1. **Trim** — `POST /recordings/:id/trim` (curl-first JSON: `{ "start": "14:36",
   "end"?: "1:23:45" }`, at least one of `start`/`end` required, ffmpeg-format
   offsets, `duration` accepted as an alias for `end`). Recordings are
   deliberately padded — the owner schedules 10–20 min of buffer before and
   after the real event — so cutting a finished file down to its true content
   boundary (e.g. a B2B set that actually started 14m36s in) is a recurring
   need, not a one-off. `404` if the source does not exist; `409` if it is not
   finished (`recorded`/`muxed`). Creates one new derived recording row and runs
   `ffmpeg -ss <start> [-to <end>] -i <source> -c copy <new-output>` as the
   lightweight job above; publish the derived row finished only on atomic
   success, and on failure preserve every file and leave it `failed`.
2. **Split** — `POST /recordings/:id/split` (curl-first JSON: an ordered list of
   cut points as ffmpeg-format offsets, e.g. `{ "cuts": ["20:00", "1:05:00"] }`).
   Same finished-source gate (`404`/`409`) and same derived-row pattern as trim,
   but takes N cut points and produces N+1 new derived recording rows from the
   one source — each segment an independent `ffmpeg -c copy` cut with its own ID
   and output path, so a long single capture becomes multiple derived
   recordings. All-or-nothing: publish the derived rows finished only when every
   segment cut succeeds; on any failure preserve every file and leave the failed
   derived rows `failed`. **⚠ Owner framing to reconcile:** the owner described
   split as "record becomes two records, video splits keep one of the IDs and
   recording gets split to new Id, end result is the same as if recorded
   separately" — i.e. one result keeps the *original* ID and the source is
   consumed, which diverges from the source-preserving all-new-derived-rows
   decision above. Confirm with the owner which semantics win (keep-one-ID /
   source-consumed vs. source-preserved / all-new-IDs) before building; the rest
   of the mechanism is unaffected either way.
3. **Client-captured thumbnails.** Possible but not yet verified end to end: the
   owner pauses the `mpegts.js` player at a chosen frame and grabs it from the
   `<video>` element via `<canvas>.drawImage()` + `toBlob()`/`toDataURL()` —
   standard client-side frame capture that works on any rendered `<video>`
   element regardless of how it is fed (MSE via `mpegts.js` is no different from a
   plain file source here), and is not blocked by canvas tainting since the video
   is same-origin. The client POSTs the captured image to a new endpoint to store
   as the recording's thumbnail. Needs: the new upload endpoint / storage
   location, and deciding whether/how a thumbnail surfaces in the Archive list.
4. Derived recordings are listed, served, and themselves re-trimmable/re-
   splittable exactly like any other recording through the existing
   `GET /recordings/:id/file` route — no new serving path is introduced. Extend
   the functional server suite (test names only):

```ts
// test/functional/server.test.ts (additional blocks)
t.test("trims a finished recording into a new derived recording");
t.test("splits a finished recording into multiple derived recordings");
t.test("rejects a trim or split of a source that is not finished");
t.test("leaves the source recording's row and file untouched after trim/split");
```

### Phase 6 — audio-only

**Complexity: Medium.** Audio-only capture and playback, rolled out
feature-by-feature behind a global toggle. Later-phase summary depth.

- **Global video/audio toggle — build now as a real but inert control.** This is
  designed and executed in this task, but **no-op until the following features
  are implemented one by one**. All text/UI changes (labels, copy, the toggle
  control itself, everywhere the app says "video") land on this task; the toggle
  flips a global mode but each downstream behaviour is wired feature-by-feature in
  the items below. Explicit staged rollout — build the visible toggle first,
  functionally inert, then light up each capability in turn.
- **VLC stream for audio-only.**
- **Audio-only player.**
- **Download audio only.**
- **Schedule an audio-only recording** — from the quality/format dropdown built
  in Phase 4 (video-only until this phase); audio-only entries become available
  here.

### Phase 7 — candidates (research)

**Complexity: unknown — research first, plan after.** Bulk-import a broadcast
schedule and promote entries to recordings. Framed by the owner as **open
research questions, not a decided implementation** — do not invent the automation
approach here.

Open questions to research before any plan:

- **How to automate schedule import**, with or without agents. Agents-with-API is
  **a viable option** per the owner (there is no generic scraper); this is a
  candidate approach to evaluate, not a decision.
- **Research real schedule pages** such as `tomorrowland.com` — how their
  schedules are structured and **how to present** an imported schedule in this
  app.
- **Import format** stays open (⚠ JSON array vs. CSV vs. ICS; JSON is the default
  assumption) — resolve during the research, not now.

Only **after** that research does this become a buildable plan (candidates
migration, repository, bulk import/list/delete API, and an atomic
promote-to-recording per the `candidates` data model already sketched in
spec.md, with concurrent-promotion protection).

### Phase 8 — conversion, demux, format

**Complexity: Medium.** Deprioritised — the owner said they likely will not care
about container conversion for a while, so this sits last. Here for completeness,
not near-term work.

**Job mechanism.** Remux reuses the **same lightweight one-shot tracked
`ffmpeg -c copy` job** introduced for trim/split in **Phase 5** — built earlier,
so there is no forward reference to unbuilt machinery. A full container remux is
the same shape of operation as a trim (a bounded `-c copy` pass over a finished
file), so it needs nothing more robust than trim/split already established. If,
when this phase is built, concurrent remuxes need capping or a longer job proves
worth reconciling across reboot, extend that mechanism then; do not pre-build a
heavier reconciled `mux-<id>` unit type on speculation.

1. **Remux to a final container.** `ffmpeg -c copy` from the captured `.ts` into
   the final `mp4`/`mkv` container, publishing `final_path` only on atomic
   success and preserving the `.ts` on any failure. Two open decisions carry over
   unchanged and are resolved immediately before this phase, not now:
   - ⚠ **`mkv` vs `mp4`** for the final container (`-c copy`; mkv is the stated
     safe default if the audio/video codecs are not mp4-safe).
   - ⚠ **Trigger mechanism:** reconciler-driven vs. a systemd `.path` unit
     watching the output directory.
   Muxed `final_path` files are served through the existing Phase 1
   `GET /recordings/:id/file` route (already built for `.ts`); no separate
   serving-design decision remains.
2. **Download the converted (`mp4`/`mkv`) file.** The Phase 1 streaming route
   already serves the raw bytes, so download is a **UI affordance only** — a
   download link/button in the web client using the same `GET /recordings/:id/file`
   URL (a same-origin `<a download>`), with **no new backend work**. No
   `Content-Disposition: attachment` route is added unless a concrete need
   appears, keeping the streaming route a single code path.
3. **Demux — ⚠ undesigned; needs its own design pass before building.** The owner
   listed "demux" as a wanted operation, but its product meaning here is not yet
   defined (what it separates, into what outputs, and how those surface as
   recordings/files). Do not invent the behaviour — resolve what "demux" means as
   a feature before planning it.
4. **30-day trash auto-purge lands here.** The full mechanism is specified in
   Phase 3 (trash / retention) — deliberately simple, executes on app start with
   a daily `setInterval`, no reconciler/timer, accepted pitfalls. This phase is
   where the owner slotted its actual rollout; see Phase 3 for the mechanism and
   the shared permanent-delete routine it calls.

### Lowest priority (unordered)

Deferred past every phase above, in no particular order.

**Reboot-recovery acceptance test.** The reconciler's reboot-recovery logic
(rule 1 in the reconciler tick responsibilities) already exists in code; this is
only the live verification step. Schedule a short recording, stop/restart the
dedicated user manager or reboot `irae-sheeta` during its window, and confirm
reconciliation resumes appending to the same `.ts` with a recalculated safety
cap.

**Firefox playback.** Deliberately dropped for now, not investigated. The
`RecordingDetail.vue` player (mpegts.js over MSE) has only been verified on
Chromium-based browsers and Safari; Firefox was reported broken (loaded a
CSP-blocked error page, likely Firefox's own internal interstitial rather
than anything our app sends — we confirmed no CSP header exists anywhere in
this app) and set aside rather than chased live. Fix eventually using the
existing Playwright e2e harness (`test/e2e/`) with a Firefox project added,
rather than manual live debugging.

## Operational invariants

- SQLite is durable truth and queue; systemd units are disposable projections.
- The API is the only SQLite writer in normal operation.
- The reconciler is a finite, restartable tick with no irreplaceable memory.
- Recorder processes run only under the dedicated account's user manager.
- Scheduled stopping is owned by reconciler-issued systemd stop operations;
  `RuntimeMaxSec` is a backstop, not the normal stopping mechanism.
- `stop_at` and cancellation intent live in SQLite; a PID never becomes durable
  application state, and immediate API control is followed by reconciliation.
- No request data is evaluated by a shell or used as a unit/path identifier.
- SQLite control files and cookies are private to the service UID in Phase 0;
  the current `rec-media` media access is read-only and opt-in. The next
  shared-intranet block expands that access deliberately.
- A recording is never reported complete until its unit is stopped/gone and a
  non-empty regular output file exists.
- Root is needed only for reviewed installation/upgrade and host provisioning,
  never for routine API, reconciliation, or recording work.
- Network attachment is configurable deployment policy. The application does
  not require or modify Tailscale, LAN routing, firewall rules, reverse proxies,
  or VPS networking. Before any open-access VPS listener is made publicly
  reachable, the operator must supply an external access boundary (see
  `spec.md`'s non-goals note).
- Open decisions in `spec.md` remain open until their owning phase.

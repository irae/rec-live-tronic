# YouTube Live Recorder implementation plan

This plan turns `spec.md` into an implementation sequence. Phase 0 is the first
release and must be independently usable from `curl`. Later phases do not alter
the Phase 0 recording path.

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
- `ffmpeg` is not needed until Phase 3 and is already present.

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
- `src/app.ts`: exports `createApp(deps)`, including the future authentication
  middleware seam, public Phase 0 routes, consistent errors, and request
  validation.
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
- `scripts/install-root.sh`: short, auditable, idempotent host provisioning and
  release installation script intended to be reviewed and run manually as
  root.
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

Built, installed, and live-acceptance-tested on `irae-sheeta`. This replaces the
former per-block build narrative (§0.1–§0.7 and its acceptance checklist); the
architecture that later phases build on is captured here and in "Decisions made
for Phase 0" above and "Operational invariants" below.

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
## Later phases

These are separate larger blocks. Resolve each listed open decision immediately
before its phase and commit completed blocks, not their sub-steps.

### Phase 1 — network playback and split release packages

Two independent blocks; commit each when complete, not its sub-steps.

#### Part A — VLC-openable streaming route

**Complexity: Medium.** The handler is a conventional Express file route over a
finished, fixed-size file; range requests and the ID→path derivation supply the
integration risk.

This resolves `spec.md`'s "File sharing / network URL" open decision in favour
of the simplest option: a static file route on the existing public Express API.
No Jellyfin, nginx, or Samba — each would add a second service, config surface,
and access boundary for no benefit at this scale. Scope is **finished
(`recorded`/`muxed`) files only**. Streaming a still-`recording` (actively
growing) file is a **non-goal, never to be built**: if a recording is still in
progress, the end user can just watch the source live on YouTube directly, so
there is no reason to also serve the in-progress `.ts`; a growing file has no
fixed `Content-Length` and would need `Transfer-Encoding: chunked` instead of
range support, a genuinely different code path not worth building for this. The
route lives on the same public `0.0.0.0` TCP listener as every other Phase 0
route and inherits the identical no-auth, perimeter-is-the-boundary posture
(LAN/Tailscale); it adds no auth and opens no new boundary. `DELETE
/recordings/:id/file` stays out of Part A — it belongs to Phase 3 (remux and
file lifecycle).

1. Add `GET /recordings/:id/file` to `createApp` in `src/app.ts`, backed by
   `deps.recorder`. Resolve the recording with
   `RecorderService.getRecording(id)`; derive the on-disk path only from the
   stored `ts_path` (later `final_path` once muxed), never from request data,
   and assert the resolved real path stays within `config.recordingsDir`.
   Respond `404` when the recording or its file is absent, and `409` when its
   status is `scheduled` or `recording` (file not ready to stream — not a
   missing-file 404, and not a partial-file stream either).
2. Serve finished (`recorded`/`muxed`) files with full range support: send
   `Accept-Ranges: bytes`, honour `Range`, reply `206` + `Content-Range` for a
   partial request and `200` + `Content-Length` otherwise so VLC can seek. Set
   a video/MP2T (`.ts`) content type. Stream via a `createReadStream` bounded to
   the requested range and destroy it on client disconnect.
3. Treat this route as the stable per-file network URL sketched in `spec.md`'s
   API surface. Document the VLC-openable form
   `http://<host>:<port>/recordings/<id>/file` in `README.md` beside the curl
   examples.
4. Extend the functional server suite (test names only):

```ts
// test/functional/server.test.ts (additional blocks)
t.test("streams a finished recording with range requests for VLC seeking");
t.test("rejects file paths escaping the recordings root and 404s a missing file");
t.test("returns 409 for a recording that is still scheduled or in progress");
```

#### Part B — split the release into web, reconciler, and deps packages

**Complexity: Medium.** A release/deployment change only; it must not alter the
recording contract, the API's sole-writer invariant, or ownership boundaries.

Recordings already run as detached `rec-<id>` transient user units, not as
children of the API or reconciler process, so restarting either service today
already does not kill in-progress recordings. This split therefore buys
independent update/restart cadence and smaller, faster per-service deploys — not
recording safety, which already exists. On the owner's slow connection the real
win is the `deps` package: `node_modules` is the only large transfer and is
skipped whenever its fingerprint is unchanged. This absorbs and replaces the
former "split dependencies from code for fast deployment" next-step block, which
is removed to avoid duplication.

Package boundaries:
- **`deps`** — production `node_modules` only, immutable, keyed by lockfile
  digest + Node major + module ABI + `linux/amd64`. Reused across deploys while
  that fingerprint is unchanged.
- **`web`** — `dist/`, `migrations/`, `systemd/rec-live-tronic-api.service`, the
  `.env.example` config template, and a manifest recording the required `deps`
  fingerprint. Runs `node dist/server.js`.
- **`reconciler`** — `dist/`, `systemd/rec-live-tronic-reconciler.service` and
  `.timer`, and a manifest recording the required `deps` fingerprint. Runs
  `node dist/reconciler/main.js`.

`dist/` is small and shared by both entry points (the reconciler imports
`../api/service.js`, `../config.js`, and other compiled modules), so `web` and
`reconciler` each carry a full `dist/` copy rather than introducing a third
shared-code package; only the large `node_modules` is deduplicated via `deps`.

1. Change `scripts/package-release.sh` to emit three artifacts instead of one
   tarball — `rec-live-tronic-deps-<fingerprint>.tar.gz`,
   `rec-live-tronic-web-<version>.tar.gz`, and
   `rec-live-tronic-reconciler-<version>.tar.gz`, each with its own
   manifest/checksum. The two code manifests record the `deps` fingerprint they
   require. `scripts/build-release.sh` still runs the container build/tests once
   and produces all three.
2. Lay out `/opt/rec-live-tronic` per package: `deps/<fingerprint>/`,
   `web/<version>/`, and `reconciler/<version>/`, each with an atomic `current`
   selector. Each code release's `node_modules` is a symlink to the matching
   `deps/<fingerprint>`; deploy refuses to link an incompatible fingerprint.
3. Point `systemd/rec-live-tronic-api.service` at `web/current` and the
   reconciler service/timer at `reconciler/current` (ExecStart/WorkingDirectory),
   each resolving `node_modules` through its release symlink. Both keep reading
   the same `/etc/rec-live-tronic` config and the same `/var/lib/rec-live-tronic`
   SQLite and `/srv/rec-live-tronic/recordings`; the API stays the sole SQLite
   writer and the reconciler still transitions through the private socket.
4. Update `scripts/install-root.sh` (still the first-install/bootstrap path) to
   install all three packages, link `deps`, and start both services. Add a fast
   code-only deploy script that transfers only the changed `web` and/or
   `reconciler` package with `rsync --checksum` into a staging release, links the
   matching existing `deps` fingerprint, runs the health/socket/reconciler
   verification, and atomically flips only that service's `current` before
   restarting only that service. Transfer `deps` only when its fingerprint
   changes; never rsync into an active release.
5. Verify on `irae-sheeta`: redeploy `web` alone and confirm the reconciler
   service and any live `rec-*` units are untouched; redeploy `reconciler` alone
   and confirm the API stays up; confirm a code-only deploy transfers no
   `node_modules` when the lockfile is unchanged.

> Open question: this split assumes `web` and `reconciler` stay co-located on one
> host sharing the SQLite file, private socket, and recordings tree. Splitting
> them across hosts would require rethinking DB and private-socket access and is
> out of scope.

### Phase 2 — candidates and log access

**Complexity: Easy.**

1. Decide and document the candidate import format; retain JSON as the default
   unless the operator chooses otherwise.
2. Add the candidates migration, repository, bulk import/list/delete API, and
   atomic promote-to-recording operation.
3. Add `GET /recordings/:id/log` using the dedicated user's journal for the
   derived unit name, with bounded tail/follow behavior and disconnect cleanup.
4. Acceptance-test candidate promotion, concurrent promotion protection, and
   log tailing through curl.

### Phase 3 — remux and file lifecycle

**Complexity: Medium.** It adds another reconciled systemd job type and durable
file-state transitions.

1. Decide `mkv` versus `mp4` and reconciler-driven versus `.path` triggering;
   do not encode either choice before it is made. Prefer MKV only as the stated
   safe default if the operator selects it.
2. Add durable mux state and concurrency accounting, then create unprivileged
   `mux-<id>` transient units using `ffmpeg -c copy`. Reconcile them with the
   same crash/reboot principles as recordings.
3. Publish final paths only after atomic successful completion. Preserve `.ts`
   on any remux failure.
4. Add explicit file-delete behavior for finished recordings, and serve muxed
   `final_path` files through the Phase 1 `GET /recordings/:id/file` route
   (already built for `.ts`). No separate serving-design decision remains.

### Phase 4 — web client and stable media URLs

**Complexity: Medium.** The UI is conventional; the chosen media-serving
boundary and VLC-compatible URLs supply the integration risk.

1. Reuse the Phase 1 static Express file route (`GET /recordings/:id/file`, with
   range support decided and built there); no media service or nginx/Samba is
   introduced.
2. Build the UI solely as an API client: schedule form, current/history lists,
   candidate inbox, file list, and live stop-time editing.
3. Verify stable VLC-openable URLs, range requests, concurrent recordings, and
   that no browser-only workflow is required for any operation.

### Phase 5 — deferred controls

**Complexity: Medium.** Authentication and deletion policy are ordinary
features but need careful access and data-loss boundaries.

1. Choose retention semantics before adding cleanup.
2. Implement authentication at the existing middleware seam and preserve curl
   support.
3. Add explicit dry-run, audit, race, and recovery tests for retention before
   enabling deletion automation.

### Lowest priority — reboot recovery acceptance test

Deferred past every other phase above; the reconciler's reboot-recovery logic
(rule 1 in the reconciler tick responsibilities) already exists in code, this
is only the live verification step.

1. Schedule a short recording, stop/restart the dedicated user manager or
   reboot `irae-sheeta` during its window, and confirm reconciliation resumes
   appending to the same `.ts` with a recalculated safety cap.

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
  or VPS networking. Before any unauthenticated VPS listener is made publicly
  reachable, the operator must supply an external access boundary or implement
  the planned authentication seam.
- Open decisions in `spec.md` remain open until their owning phase.

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
- `ffmpeg` is not needed until Phase 2 and is already present.

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

## Phase 0 — reliable curl-first recording

Each numbered section is a larger implementation block and is committed when
complete. Do not commit every sub-step separately.

Complexity labels estimate implementation and integration risk for the whole
block: **Easy** is conventional project work with few external interactions;
**Medium** crosses process, persistence, operating-system, or deployment
boundaries. No planned block currently warrants a **Hard** label.

### 0.1 Bootstrap the Node/TypeScript application

**Complexity: Easy.**

1. Create the package, lockfile, strict TypeScript configuration, build output
   convention, and configuration loader. Require Node 24 at startup. Default
   `REC_LIVE_HOST` to `0.0.0.0` while allowing any valid operator-selected
   listen address without application-level network policy.
2. Add Express, multipart support, and `better-sqlite3` as runtime dependencies,
   plus `tap` as the development-only functional test framework. Keep UUID
   generation and fetch on Node built-ins where practical. Install dependencies
   on Debian x86-64 rather than copying native `node_modules` from a macOS
   development machine.
3. Add the empty app/server composition roots and a `/health` route. Health
   reports process liveness, SQLite reachability, configured recording-path
   writability, and dependency status as separate fields; it does not expose
   secrets or absolute cookie paths.
4. Establish an `AppError`/error-response contract with stable codes, HTTP
   statuses, and JSON bodies. Put a no-op authentication middleware at one
   composition seam without implementing authentication.
5. Document and verify `npm ci`, `npm run build`, the two functional suites via
   `npm test`, and local startup.
6. Add the containerized release build. It must use the same Node 24 major and
   Debian/glibc family as the target, load `better-sqlite3` and run the two
   project functional suites inside the container, and package `dist/`,
   production `node_modules`, migrations, package metadata, systemd files, and
   the installer. Include a
   manifest containing git revision, build time, `linux/amd64`, Node version and
   module ABI, dependency-lock digest, and artifact checksum. Do not package
   source-only development dependencies or secrets. Treat successful container
   build, functional suite, native-binding load, manifest inspection, and
   checksum verification as build smoke checks rather than a separate test
   suite.

### 0.2 Add the durable SQLite model

**Complexity: Easy.**

1. Add a forward-only migration mechanism and the `recordings` and `cookies`
   tables. Include the Phase 0 subset of spec fields plus internal
   `last_started_boot_id` and timestamps. Explicitly exclude `final_path` and
   every mux-only column until the Phase 2 migration. Store times as validated
   UTC instants and return RFC 3339.
2. Constrain statuses to `scheduled`, `recording`, `recorded`, `cancelled`,
   `failed`, and `missed`; Phase 0 does not introduce candidates, mux fields,
   or final-file state.
3. Add indexes for due recordings, status-filtered listing, and cookie
   references. Preserve cookie rows referenced by recordings; deletion returns
   a conflict instead of corrupting history.
4. Enable WAL, foreign keys, a bounded busy timeout, and `0600` database/WAL/SHM
   access under process `UMask=0077`.
5. Implement repository operations in explicit transactions. Status updates
   from reconciliation use compare-and-set predicates so API cancellation or a
   concurrent tick cannot be overwritten.

### 0.3 Implement the Phase 0 HTTP API

**Complexity: Medium.** The HTTP behavior is conventional; live unit control,
atomic cookie storage, and the private transition socket add integration work.

1. Implement `POST /recordings`, `GET /recordings?status=`,
   `GET /recordings/:id`, `PATCH /recordings/:id`, and
   `DELETE /recordings/:id`. Phase 0 PATCH can retitle/reschedule a future
   recording and extend or shorten a running recording's `stop_at`; it cannot
   mutate status. Delete is a durable cancellation request and never deletes
   the row or media file.
2. Validate HTTPS YouTube URLs against an explicit hostname allowlist, require
   `start_at < stop_at`, apply a documented quality allowlist/default, and
   reject unknown cookie IDs. Generate opaque canonical IDs server-side.
3. Implement `POST /cookies` with multipart `name` plus one bounded-size file,
   `GET /cookies`, and `DELETE /cookies/:id`. Return metadata only, never cookie
   contents or disk paths.
4. Ignore the client upload filename. Write to a newly generated temporary
   file with exclusive/no-follow semantics, fsync, set `0600`, atomically
   rename to the generated cookie ID, and only then commit metadata. Roll back
   both sides on failure.
5. After committing cancellation for a live recording, immediately stop the
   derived user unit and report whether stop confirmation succeeded. If this
   action is interrupted or fails, keep the durable cancellation and let the
   next reconciliation tick converge. Never roll cancellation back.
6. After committing a live `stop_at` change, update the unit's systemd
   `RuntimeMaxSec` backstop. Prove the systemd 257 runtime-property update on the
   target; if unsupported, stop and relaunch the same append-mode unit with a
   recalculated cap. A stop time at or before now takes the immediate stop path.
7. Add private Unix-socket routes used only by the reconciler to claim
   transitions with expected status/update version. Do not expose these routes
   on the TCP listener.
8. Add curl examples covering health, cookie upload/list/delete, recording
   create/list/get/live stop-time changes/cancel, validation errors, and status
   filtering.

### 0.4 Implement one reconciliation tick

**Complexity: Medium.** The state rules are explicit, but systemd interaction,
reboot recovery, and interruption-safe convergence require careful integration.

1. Define `SystemdClient` with `listRecordingUnits`, `startRecording`,
   `stopRecording`, and `inspectRecordingUnit`. Use direct argv spawning with no
   shell. Treat systemctl output as untrusted and validate unit names.
2. Build streamlink argv with `--hls-live-restart`, `--retry-streams 5`,
   `--retry-max 0`, the resolved `--http-cookies-file` when selected, the
   validated URL/quality, `--stdout`, and progress disabled. Configure systemd
   to append stdout to `<recordings-root>/<id>.ts` and send stderr to the
   journal. Insert `--` at the systemd-run command boundary.
3. Start `rec-<id>.service` with `--user`, `--collect`, a `RuntimeMaxSec` equal
   to the remaining window plus a configurable extension safety margin,
   `KillMode=control-group`, bounded stop timeout, no restart,
   restrictive umask, filesystem restrictions, no-new-privileges, and only the
   address families streamlink needs. Make application state inaccessible inside
   the recorder's mount namespace; grant the selected recordings output tree
   explicit write access and bind only the selected cookie at a fixed path.
   Set Streamlink's home to the unit's private temporary filesystem so its
   transient config cannot touch application state. Clamp all calculated
   durations and validate these sandbox properties on the target host.
4. On each tick, take a database snapshot and a live-unit snapshot, then apply
   idempotent rules:
   - due `scheduled` with no unit: launch first, then compare-and-set to
     `recording` with the current boot ID; if the unit already exists, adopt it;
   - active-window `recording` with a unit: leave it running after ensuring its
     backstop cannot preempt the current durable `stop_at`;
   - active-window `recording` without a unit whose stored boot ID differs:
     relaunch with the remaining time, appending to the existing `.ts` through
     systemd's output sink;
   - current-boot `recording` whose unit ended early: mark `recorded` when a
     non-empty regular `.ts` exists, otherwise `failed`;
   - elapsed `recording`: always issue `systemctl --user stop` for a live unit,
     wait for it to become inactive within a bound, then mark `recorded` for a
     non-empty regular file or `failed` otherwise;
   - elapsed `scheduled` with a live unit after a launch/claim interruption:
     stop it, await inactivity, then mark `recorded` for a non-empty regular
     file or `failed` otherwise;
   - elapsed `scheduled` without a valid file: mark `missed`;
   - `cancelled` with a live unit: stop it and keep `cancelled`.
5. Send every mutation through the private API. A failed compare-and-set is a
   benign race: refresh on the next timer tick. Fail the tick visibly if the
   API/socket is unavailable; never make a direct SQLite write fallback.
6. Make the process finite: reconcile once, report a structured summary, and
   exit nonzero only for operational failure. The systemd timer owns cadence
   and overlap prevention.

### 0.5 Add the auditable root installation boundary

**Complexity: Medium.** The script is short, but it crosses Unix accounts,
filesystem permissions, system and user service managers, and release layout.

1. Write `scripts/install-root.sh` as an idempotent script with explicit
   configuration variables/flags. It must stop on errors, require UID 0,
   resolve concrete paths before destructive operations, and print each
   material action. It does not use curl-to-shell or install packages.
2. Preflight Node, the release checksum/manifest, matching `linux/amd64` and
   Node module ABI, the packaged `better-sqlite3` native binding, SQLite
   diagnostics, and the root-owned
   `/usr/local/bin/streamlink` path, its `/opt/pipx` target and pinned version,
   systemd version/features, disk space, and the configured human account.
   Verify the artifact records a successful container build/test before
   installation. Do not compile npm dependencies on the target host.
3. Create the non-login `rec-live-tronic` system account and private primary
   group. Create `rec-media`; optionally add the named human account to it only
   when direct media access is requested.
4. Install a versioned, root-owned release under `/opt/rec-live-tronic` without
   making source or dependencies writable by the service account. Keep a
   root-controlled `current` link or equivalent atomic release selector for
   recoverable upgrades.
5. Create and verify:
   - `/etc/rec-live-tronic` as root-owned configuration;
   - `/var/lib/rec-live-tronic` and `cookies/` as service-owned mode `0700`;
   - `/run/rec-live-tronic` through systemd `RuntimeDirectory`, mode `0750`;
   - `/srv/rec-live-tronic/recordings` as
     `rec-live-tronic:rec-media`, mode `2750`, producing media mode `0640` with
     `UMask=0027`.
6. Enable lingering for the numeric service UID, start/order
   `user@<uid>.service`, and prove that the service account can create, inspect,
   and stop a harmless `systemd-run --user` transient unit through its own bus.
7. Install hardened API, reconciler oneshot, and 30-second timer system units.
   Both application units use the dedicated UID, empty capability bounds,
   strict filesystem access, private devices/tmp, and kernel/control-group
   protections. Grant the API explicit write access only to
   `/var/lib/rec-live-tronic` and its systemd-created runtime directory. Grant
   transient recorder units explicit write access to the recordings output
   tree while keeping SQLite control state inaccessible. The
   API and reconciler receive their dedicated account's user-bus environment
   so either can control only that account's units. The reconciler has no
   general write access to application state or media paths.
8. Migrate SQLite as the service account with umask `0077`. Write the configured
   listen host/port without changing Tailscale, firewall, DNS, reverse-proxy, or
   other host networking configuration.
9. Reload systemd, enable/start the API and timer, and verify health, modes,
   ownership, timer execution, private socket access, user transient-unit
   control, and the configured listen address. Make no sudoers or polkit change.
10. Document an upgrade path that installs a new versioned release, runs
    forward migrations, atomically changes the release selector, restarts the
    API/timer, health-checks, and retains the prior release for application
    rollback. Database backup/restore is explicit because migrations are
    forward-only.

Do not build an automated test harness for the installer. Review the short
script, run it on `irae-sheeta`, inspect its results, rerun it once to smoke-check
idempotency, and debug concrete failures in place. The script's own preflight
and post-install checks cover user/group creation, paths and modes, service
startup, networking non-interference, and the harmless user-unit probe.

### 0.6 End-to-end acceptance on `irae-sheeta`

**Complexity: Medium.** This is mostly procedural verification, with real
systemd, Streamlink, networking, and reboot behavior in scope.

1. Start the local Docker daemon, run `scripts/build-release.sh` for
   `linux/amd64`, verify its checksum, copy the versioned tarball and checksum,
   review the root script, install only runtime OS dependencies, and have the
   operator run the script.
2. Upload a non-production test cookie through curl; confirm its response and
   disk permissions do not reveal or overexpose it.
3. Schedule two overlapping short recordings with curl, using distinct cookies
   if available. Confirm two `rec-*` user units and two growing `.ts` files.
4. Extend one live recording beyond its original stop time and verify it keeps
   running. Then shorten it and verify systemd stops it at the new durable
   deadline within the documented tolerance.
5. Cancel the other recording. Confirm the API persists `cancelled` and stops
   the unit immediately without waiting for a timer tick.
6. Schedule a short recording, stop/restart the dedicated user manager or reboot
   during its window, and confirm reconciliation resumes appending to the same
   `.ts` with a recalculated safety cap.
7. Stop the API briefly, let a reconciliation tick fail, restart the API, and
   confirm the next tick converges without corrupting state or duplicating a
   unit.
8. Let a window expire and verify a playable `.ts`, `recorded` status, no live
   unit, and persistence after API restart. Verify an elapsed never-started
   window becomes `missed`.
9. From the current Tailscale connection, exercise
   health/create/list/get/patch/cancel against the API's `0.0.0.0` listener.
   When physically available, repeat the reachability check from the home LAN.
10. Record the exact installed versions, service account UID, paths, configured
    listener, current Tailscale and LAN URLs, backup command, and diagnostic
    commands in the deployment section of `README.md`.

Phase 0 is complete only when these acceptance checks pass and the system can
record reliably without an interactive SSH session, the human user's account,
sudo, or a root-running application process.

### Next step — shared intranet operator access

**Complexity: Easy.** This is an intentional deployment policy for the trusted
intranet host, not a public-service security boundary. This block is pending;
Phase 0 remains read-only for media users until it is implemented.

1. Treat `rec-media` as the shared operational group. `--media-user irae` and
   any additional media users receive read/write access to the shared
   recordings, diagnostics, logs, and cookie files needed to operate the box.
2. Put recordings, service logs, and other operational artifacts in explicit
   group-owned trees with inherited group permissions. Do not require `irae`
   to read the system journal directly or grant broad journal access when a
   shared log tree is sufficient.
3. Keep SQLite control/state files and transient systemd internals out of the
   shared tree unless an explicit diagnostic export is requested. Cookies are
   allowed in the shared operational tree because this deployment is trusted
   by its SSH users and the recorder service already requires them.
4. Acceptance-test access as `irae` and a second `rec-media` member: inspect
   logs, read/write recording artifacts, inspect cookie files, and confirm
   that the API/reconciler continue to operate with the shared permissions.

## Later phases

These are separate larger blocks. Resolve each listed open decision immediately
before its phase and commit completed blocks, not their sub-steps.

### Phase 1 — candidates and log access

**Complexity: Easy.**

1. Decide and document the candidate import format; retain JSON as the default
   unless the operator chooses otherwise.
2. Add the candidates migration, repository, bulk import/list/delete API, and
   atomic promote-to-recording operation.
3. Add `GET /recordings/:id/log` using the dedicated user's journal for the
   derived unit name, with bounded tail/follow behavior and disconnect cleanup.
4. Acceptance-test candidate promotion, concurrent promotion protection, and
   log tailing through curl.

### Phase 2 — remux and file lifecycle

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
4. Add authenticated-by-perimeter file download/stream and explicit file-delete
   behavior only after choosing the Phase 2–3 serving design.

### Phase 3 — web client and stable media URLs

**Complexity: Medium.** The UI is conventional; the chosen media-serving
boundary and VLC-compatible URLs supply the integration risk.

1. Decide Express static delivery, a media service, or nginx/Samba based on VLC
   range-request support, configured-network exposure, operational burden, and
   deletion ownership. Record the choice before implementation.
2. Build the UI solely as an API client: schedule form, current/history lists,
   candidate inbox, file list, and live stop-time editing.
3. Verify stable VLC-openable URLs, range requests, concurrent recordings, and
   that no browser-only workflow is required for any operation.

### Phase 4 — deferred controls

**Complexity: Medium.** Authentication and deletion policy are ordinary
features but need careful access and data-loss boundaries.

1. Choose retention semantics before adding cleanup.
2. Implement authentication at the existing middleware seam and preserve curl
   support.
3. Add explicit dry-run, audit, race, and recovery tests for retention before
   enabling deletion automation.

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

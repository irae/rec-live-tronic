# YouTube Live Recorder implementation plan

This plan turns `spec.md` into an implementation sequence. Phase 0 is the first
release and must be independently usable from `curl`. Later phases do not alter
the Phase 0 recording path.

## Decisions made for Phase 0

- Use Node.js 24 LTS, TypeScript compiled to JavaScript, npm, Express, and the
  built-in `node:sqlite` module. Production runs compiled JavaScript with
  `node`; it does not run TypeScript or require Deno/Bun.
- Run the API and reconciler as the same dedicated, non-login Unix account,
  `rec-live-tronic`. Neither process nor any recorder runs as the SSH user or
  as root.
- Install the API and reconciler as system services with
  `User=rec-live-tronic`. Enable a lingering systemd user manager for that
  account; the reconciler uses `systemd-run --user` and `systemctl --user` to
  manage unprivileged `rec-<id>.service` transient units. Do not add sudoers or
  polkit rules.
- Express listens on loopback. Tailscale Serve proxies the API into the
  tailnet. Do not bind the unauthenticated API to all interfaces.
- Keep the API as the sole SQLite writer. The reconciler reads SQLite directly
  and sends status compare-and-set requests to an API listener on a private Unix
  socket. Public routes never accept arbitrary status changes.
- Store private state under `/var/lib/rec-live-tronic` and recordings under
  `/srv/rec-live-tronic/recordings`. A read-only `rec-media` group provides
  optional direct SSH/SFTP access without granting access to SQLite or cookies.
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
- Tailscale 1.98.9 is active and enabled. The node is
  `irae-sheeta.tailc9708.ts.net`, and no Tailscale Serve configuration exists
  yet. Unprivileged user namespaces are enabled, which supports the proposed
  user-unit hardening.
- The root filesystem has about 139 GB free. `/tmp` is a small tmpfs and must
  not hold recordings.
- The SSH account has no sudo/admin group. No existing recorder systemd units
  were found.

### Root-installed dependencies

The operator installs these before running the repository's installer:

- Node.js 24 LTS, including npm.
- pipx plus a root-managed global Streamlink installation, initially pinned to
  the already-proven 8.4.0 release and exposed as
  `/usr/local/bin/streamlink`. Provision its environment under `/opt/pipx`
  (for example with root's `PIPX_HOME=/opt/pipx` and
  `PIPX_BIN_DIR=/usr/local/bin`) rather than under `/root`, whose directories
  the service account cannot traverse. It is executable by all local users but
  its code and environment are writable only by root. Do not reuse or alter
  the human-owned installation under `/home/irae/.local`.
- SQLite CLI for diagnosis and backup checks. The application itself uses
  Node's built-in SQLite module.
- Tailscale, connected to the intended tailnet, with permission for root to
  configure Tailscale Serve.
- `ffmpeg` is not needed until Phase 2 and is already present.

The root installer verifies versions and capabilities; it does not silently
install OS packages or alter the existing human-owned streamlink installation.

## Planned repository layout

The repository currently contains no application scaffold. Phase 0 creates:

- `package.json` and `package-lock.json`: pinned runtime/development
  dependencies and `build`, `test`, `dev`, `start`, `reconcile:once`, and
  `db:migrate` scripts.
- `tsconfig.json`: strict Node ESM compilation from `src/` to `dist/`.
- `.env.example`: non-secret configuration names and safe local defaults.
- `src/config.ts`: loads and validates ports, paths, streamlink executable,
  timer/runtime limits, and the private socket path.
- `src/app.ts`: exports `createApp(deps)`, including the future authentication
  middleware seam, public Phase 0 routes, consistent errors, and request
  validation.
- `src/server.ts`: opens the database, creates services, and starts the public
  loopback and private Unix-socket listeners.
- `src/db/connection.ts`: opens SQLite, enables WAL, foreign keys, busy timeout,
  and safe file modes.
- `src/db/migrate.ts` and `migrations/001-phase-zero.sql`: idempotent schema
  migration entry point and the Phase 0 schema.
- `src/recordings/repository.ts`: `RecordingRepository` reads plus atomic
  create/cancel/status compare-and-set operations.
- `src/recordings/service.ts`: schedule validation and public recording use
  cases.
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
- `test/`: Node test-runner suites, fixtures, and isolated temporary SQLite and
  filesystem helpers.
- `README.md`: dependency, build, installation, curl, diagnosis, and upgrade
  instructions.

## Phase 0 — reliable curl-first recording

Each numbered section is a larger implementation block and is committed when
complete. Do not commit every sub-step separately.

### 0.1 Bootstrap the Node/TypeScript application

1. Create the package, lockfile, strict TypeScript configuration, build output
   convention, and configuration loader. Require Node 24 at startup.
2. Add Express and multipart support as runtime dependencies; keep SQLite,
   UUID generation, test runner, and fetch on Node built-ins where practical.
3. Add the empty app/server composition roots and a `/health` route. Health
   reports process liveness, SQLite reachability, configured recording-path
   writability, and dependency status as separate fields; it does not expose
   secrets or absolute cookie paths.
4. Establish an `AppError`/error-response contract with stable codes, HTTP
   statuses, and JSON bodies. Put a no-op authentication middleware at one
   composition seam without implementing authentication.
5. Document and verify `npm ci`, `npm run build`, `npm test`, and local startup.

Test file initialization and blocks:

```ts
// test/health.test.ts
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createApp } from "../src/app.js";

describe("GET /health", () => {
  test("reports healthy dependencies without revealing private paths");
  test("reports a degraded dependency with a stable error code");
});
```

### 0.2 Add the durable SQLite model

1. Add a forward-only migration mechanism and the `recordings` and `cookies`
   tables. Include the spec fields plus internal `last_started_boot_id` and
   timestamps. Store times as validated UTC instants and return RFC 3339.
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

Test file initialization and blocks:

```ts
// test/database.test.ts
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { openDatabase } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";

describe("SQLite persistence", () => {
  test("enables WAL, foreign keys, and busy timeout");
  test("persists recordings across reopened connections");
  test("rejects invalid status values and dangling cookie references");
  test("compare-and-set updates cannot overwrite cancellation");
});
```

### 0.3 Implement the Phase 0 HTTP API

1. Implement `POST /recordings`, `GET /recordings?status=`,
   `GET /recordings/:id`, and `DELETE /recordings/:id`. In Phase 0, delete is a
   durable cancellation request; it never deletes the row or media file.
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
5. Add private Unix-socket routes used only by the reconciler to claim
   transitions with expected status/update version. Do not expose these routes
   on the TCP listener.
6. Add curl examples covering health, cookie upload/list/delete, recording
   create/list/get/cancel, validation errors, and status filtering.

Test file initialization and blocks:

```ts
// test/api.test.ts
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createApp } from "../src/app.js";

describe("recordings API", () => {
  test("schedules and returns a recording");
  test("lists recordings filtered by status");
  test("returns one recording or a stable not-found error");
  test("cancels without deleting history");
  test("rejects invalid windows, URLs, qualities, and cookie IDs");
});

describe("cookies API", () => {
  test("uploads a cookie file atomically and returns metadata only");
  test("lists cookie metadata without contents or paths");
  test("deletes an unreferenced cookie and its file");
  test("rejects traversal names, oversize uploads, and referenced deletion");
});

describe("private reconciler API", () => {
  test("accepts compare-and-set transitions over the Unix socket");
  test("is absent from the public TCP listener");
});
```

### 0.4 Implement one reconciliation tick

1. Define `SystemdClient` with `listRecordingUnits`, `startRecording`,
   `stopRecording`, and `inspectRecordingUnit`. Use direct argv spawning with no
   shell. Treat systemctl output as untrusted and validate unit names.
2. Build streamlink argv with `--hls-live-restart`, `--retry-streams 5`,
   `--retry-max 0`, the resolved `--http-cookie-file` when selected, the
   validated URL/quality, `--stdout`, and progress disabled. Configure systemd
   to append stdout to `<recordings-root>/<id>.ts` and send stderr to the
   journal. Insert `--` at the systemd-run command boundary.
3. Start `rec-<id>.service` with `--user`, `--collect`, remaining-window
   `RuntimeMaxSec`, `KillMode=control-group`, bounded stop timeout, no restart,
   restrictive umask, filesystem restrictions, no-new-privileges, and only the
   address families streamlink needs. Make application state and the recordings
   tree inaccessible inside the recorder's mount namespace; bind only the
   selected cookie read-only at a fixed private path. The user manager opens
   the derived TS append sink before executing Streamlink, so Streamlink itself
   needs no directory write access. Clamp all calculated durations and validate
   these sandbox properties on the target host.
4. On each tick, take a database snapshot and a live-unit snapshot, then apply
   idempotent rules:
   - due `scheduled` with no unit: launch first, then compare-and-set to
     `recording` with the current boot ID; if the unit already exists, adopt it;
   - active-window `recording` with a unit: leave it running;
   - active-window `recording` without a unit whose stored boot ID differs:
     relaunch with the remaining time, appending to the existing `.ts` through
     systemd's output sink;
   - current-boot `recording` whose unit ended early: mark `recorded` when a
     non-empty regular `.ts` exists, otherwise `failed`;
   - elapsed `recording`: always issue `systemctl --user stop` for a live unit,
     wait for it to become inactive within a bound, then mark `recorded` for a
     non-empty regular file or `failed` otherwise;
   - elapsed `scheduled` without a valid file: mark `missed`;
   - `cancelled` with a live unit: stop it and keep `cancelled`.
5. Send every mutation through the private API. A failed compare-and-set is a
   benign race: refresh on the next timer tick. Fail the tick visibly if the
   API/socket is unavailable; never make a direct SQLite write fallback.
6. Make the process finite: reconcile once, report a structured summary, and
   exit nonzero only for operational failure. The systemd timer owns cadence
   and overlap prevention.

Test file initialization and blocks:

```ts
// test/reconcile-once.test.ts
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { reconcileOnce } from "../src/reconciler/reconcile-once.js";

describe("reconcileOnce", () => {
  test("launches a due scheduled recording and claims recording state");
  test("adopts an already-live unit after a launch/claim interruption");
  test("leaves an active recording unit unchanged");
  test("relaunches an active-window recording after a reboot");
  test("finalizes a current-boot unit that ended early");
  test("authoritatively stops an elapsed recording before finalizing it");
  test("does not finalize when systemd cannot confirm the unit stopped");
  test("marks an elapsed never-started recording missed");
  test("stops a live cancelled recording without changing cancellation");
  test("does not overwrite a concurrent API cancellation");
  test("fails safely when the private transition API is unavailable");
});
```

```ts
// test/streamlink-command.test.ts
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { buildStreamlinkArgs } from "../src/reconciler/streamlink-command.js";

describe("streamlink transient-unit invocation", () => {
  test("uses the required live, retry, cookie, quality, and stdout arguments");
  test("appends binary stdout to the derived TS path and journals stderr");
  test("derives the unit and output names only from a canonical recording ID");
  test("sets remaining RuntimeMaxSec and hardening properties");
  test("hides application state and exposes only the selected cookie");
  test("rejects unsafe URLs, paths, qualities, IDs, and durations");
});
```

### 0.5 Add the auditable root installation boundary

1. Write `scripts/install-root.sh` as an idempotent script with explicit
   configuration variables/flags. It must stop on errors, require UID 0,
   resolve concrete paths before destructive operations, and print each
   material action. It does not use curl-to-shell or install packages.
2. Preflight Node/npm, SQLite diagnostics, the root-owned
   `/usr/local/bin/streamlink` path, its `/opt/pipx` target and pinned version,
   systemd version/features, Tailscale state, disk space, and the configured
   human account. Verify the app was built and tests passed before installation.
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
   `/var/lib/rec-live-tronic` and its systemd-created runtime directory. The
   reconciler receives only its own user-bus environment and no general write
   access to application state or media paths.
8. Migrate SQLite as the service account with umask `0077`. Configure Tailscale
   Serve to proxy the loopback listener, preserving any unrelated Serve config
   or refusing to proceed if it cannot do so safely.
9. Reload systemd, enable/start the API and timer, and verify health, modes,
   ownership, timer execution, private socket access, user transient-unit
   control, and tailnet-only reachability. Make no sudoers or polkit change.
10. Document an upgrade path that installs a new versioned release, runs
    forward migrations, atomically changes the release selector, restarts the
    API/timer, health-checks, and retains the prior release for application
    rollback. Database backup/restore is explicit because migrations are
    forward-only.

Installation-script tests and checks:

```sh
# test/install-root.bats
setup() { load "test_helper"; }

@test "refuses to run without root"
@test "fails clearly when a required executable is unavailable"
@test "creates the intended user, groups, directories, and modes"
@test "is idempotent on a second run"
@test "does not add sudoers or polkit policy"
@test "does not overwrite unrelated Tailscale Serve configuration"
```

Run the destructive/provisioning cases in a disposable Debian 13 VM or
container with mocked systemd commands; perform the final user-manager and
Tailscale checks on `irae-sheeta` only when the operator runs the reviewed
script as root.

### 0.6 End-to-end acceptance on `irae-sheeta`

1. Build and test locally, copy a versioned artifact, review the root script,
   install required OS dependencies, and have the operator run the script.
2. Upload a non-production test cookie through curl; confirm its response and
   disk permissions do not reveal or overexpose it.
3. Schedule two overlapping short recordings with curl, using distinct cookies
   if available. Confirm two `rec-*` user units and two growing `.ts` files.
4. Cancel one recording. Confirm the unit stops and the durable status remains
   `cancelled`; confirm the other continues.
5. Schedule a short recording, stop/restart the dedicated user manager or reboot
   during its window, and confirm reconciliation resumes appending to the same
   `.ts` with the remaining runtime cap.
6. Stop the API briefly, let a reconciliation tick fail, restart the API, and
   confirm the next tick converges without corrupting state or duplicating a
   unit.
7. Let a window expire and verify a playable `.ts`, `recorded` status, no live
   unit, and persistence after API restart. Verify an elapsed never-started
   window becomes `missed`.
8. From a tailnet client, exercise health/create/list/get/cancel. Confirm the
   listener is unreachable through non-Tailscale interfaces.
9. Record the exact installed versions, service account UID, paths, Tailscale
   URL, backup command, and diagnostic commands in the deployment section of
   `README.md`.

Phase 0 is complete only when these acceptance checks pass and the system can
record reliably without an interactive SSH session, the human user's account,
sudo, or a root-running application process.

## Later phases

These are separate larger blocks. Resolve each listed open decision immediately
before its phase and commit completed blocks, not their sub-steps.

### Phase 1 — candidates and live control

1. Decide and document the candidate import format; retain JSON as the default
   unless the operator chooses otherwise.
2. Add the candidates migration, repository, bulk import/list/delete API, and
   atomic promote-to-recording operation.
3. Add `PATCH /recordings/:id` for title/window changes. Validate changes
   against current status. On extension, the next tick updates the live unit's
   `RuntimeMaxSec` with `systemctl --user set-property --runtime`; first prove
   that systemd 257 accepts that property change in the target-host acceptance
   test. If it does not, the defined fallback is to stop and relaunch the same
   append-mode unit with the new remaining cap. Shortening continues to use the
   authoritative stop check. Explicitly test extension beyond the original
   cap, shortening, the relaunch fallback, and a stop time moved into the past.
4. Add `GET /recordings/:id/log` using the dedicated user's journal for the
   derived unit name, with bounded tail/follow behavior and disconnect cleanup.
5. Acceptance-test candidate promotion, concurrent promotion protection, live
   extend/shorten, and log tailing through curl.

### Phase 2 — remux and file lifecycle

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

1. Decide Express static delivery, a media service, or nginx/Samba based on VLC
   range-request support, tailnet exposure, operational burden, and deletion
   ownership. Record the choice before implementation.
2. Build the UI solely as an API client: schedule form, current/history lists,
   candidate inbox, file list, and live stop-time editing.
3. Verify stable VLC-openable URLs, range requests, concurrent recordings, and
   that no browser-only workflow is required for any operation.

### Phase 4 — deferred controls

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
- No request data is evaluated by a shell or used as a unit/path identifier.
- Cookies and database files are private to the service UID; media group access
  is read-only and opt-in.
- A recording is never reported complete until its unit is stopped/gone and a
  non-empty regular output file exists.
- Root is needed only for reviewed installation/upgrade and host provisioning,
  never for routine API, reconciliation, or recording work.
- Open decisions in `spec.md` remain open until their owning phase.

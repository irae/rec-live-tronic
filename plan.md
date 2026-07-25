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

Core recorder: Express API + finite reconciler tick + Streamlink over SQLite,
detached `rec-<id>` transient systemd units, release build + auditable
installer. See `CHANGELOG.md` — Beta 0. The architecture later phases build on
stays captured in "Decisions made for Phase 0" above and "Operational
invariants" below.

## Phase 1 — done

VLC-openable range-serving file route (`GET /recordings/:id/file`) + the
`web`/`reconciler`/`deps` release package split. See `CHANGELOG.md` — Beta 1.

## Later phases

These are separate larger blocks. Resolve each listed open decision immediately
before its phase and commit completed blocks, not their sub-steps.

**Removed — HTTP log tailing.** The former `GET /recordings/:id/log` route is
dropped entirely: §0.7's shared `rec-media` group already gives direct
filesystem read of Streamlink's logs at `<recordingsDir>/<id>.log` (confirmed
in live testing, since Streamlink's stderr already appends there), so no HTTP
tailing route is needed.

**Renumbering note (2026-07-25).** The MP4 transition below absorbed the old
"Phase 8 — conversion, demux, format" sketch (its container and job-mechanism
open decisions are now resolved by `docs/serving-format-research.md` and the
Phase 5 extraction job) and took the next actionable number, **Phase 6**; the
former Phase 6 (audio-only) is now **Phase 7** and the former Phase 7
(candidates) is now **Phase 8**. Old Phase 8's undesigned "Demux" item moved to
"Lowest priority"; its 30-day trash auto-purge item already shipped with
Phase 3.

**Versioning convention.** Completing Phase N bumps `package.json`'s `version`
to `0.N.0` (release-facing name: Beta N — see `CHANGELOG.md`). Phases 0–5 are
shipped, so the current version is `0.5.0`; completing Phase 6 ends by bumping
to `0.6.0`.

### Phase 2 — web client — done

Vue 3 + Vite SPA (schedule/archive/detail, `mpegts.js` playback, `stage`
label) + the hard-delete route. See `CHANGELOG.md` — Beta 2.

### Phase 3 — trash / retention — done

Reversible trash (`trashed_at`) with restore and gated permanent delete,
global disk-space header, 30-day auto-purge. See `CHANGELOG.md` — Beta 3.

### Phase 4 (+ 4a, 4b) — misc actions, finished-recording editing, UX batch — done

Duration default, Now mode, 10s reconciler tick, oEmbed title prefill, raw
download with friendly filenames, metadata-driven quality picker; title/stage
editing on finished recordings; `artist`/`venue`/`event` columns with
server-side title composition, toasts, no-confirm trash, Archive quick-delete,
global recording indicator. See `CHANGELOG.md` — Beta 4.

### Phase 5 — the Cut workflow (trim & split) — done

Preview-then-promote Trim/Split over finished recordings via keyframe-snapped
`ffmpeg -c copy` extraction, with lineage (`cut_from_id`) and full per-piece
metadata on Keep. See `CHANGELOG.md` — Beta 5.

### Phase 7 — audio-only

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

### Phase 8 — candidates (research)

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

### Lowest priority (unordered)

Deferred past every phase above, in no particular order.

**Demux — ⚠ undesigned; needs its own design pass before building.** (Moved
here from the old Phase 8 sketch.) The owner listed "demux" as a wanted
operation, but its product meaning is not yet defined (what it separates, into
what outputs, and how those surface as recordings/files). Do not invent the
behaviour — resolve what "demux" means as a feature before planning it.

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
this app) and set aside rather than chased live. The Phase 6 MP4 transition
likely fixes this outright (plain `<video src>` MP4 is Firefox-native); confirm
during Phase 6 verification instead of building anything here.

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

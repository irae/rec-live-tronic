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

## Phase 1 — done

Built, installed on `irae-sheeta`, and live-verified. This replaces the former
Part A / Part B build narrative.

Built:

- **VLC-openable streaming route.** `GET /recordings/:id/file` on the existing
  public Express API serves finished (`recorded`/`muxed`) files through
  `response.sendFile()`, which supplies `Range`/`206`/`Content-Length` handling
  so seeking works with no hand-rolled range logic. `404` when the recording
  does not exist, `409` while `scheduled` or `recording` (serving a growing
  in-progress file stays a non-goal). Same public `0.0.0.0` listener and
  no-auth perimeter posture as every other route; the stable per-file URL is
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

**Standing note — authentication is out of scope** until the owner explicitly
requests it, consistent with `spec.md`'s non-goals. The `createApp` middleware
seam stays in place so it can be added later, but no phase below builds it and
no perimeter posture depends on it.

**Removed — HTTP log tailing.** The former `GET /recordings/:id/log` route is
dropped entirely: §0.7's shared `rec-media` group already gives direct
filesystem read of Streamlink's logs at `<recordingsDir>/<id>.log` (confirmed
in live testing, since Streamlink's stderr already appends there), so no HTTP
tailing route is needed.

### Phase 2 — web client

**Complexity: Medium.** The UI is conventional and every view maps onto existing
Phase 0/1 JSON routes; the only real integration risk is media playback across
devices. A mobile-first, responsive single-page client, built once from a design
the owner selects at the prototype gate (step 2), served as static files by the
existing `web` Express service. One new backend behaviour only: a hard delete
that removes both the file and its SQLite row (see below).

**Stage label (decision).** The design prototype invented a "stage" badge with no
backing field. Rather than hardcode the prototype's three fixed values, `stage`
is a real **optional** `TEXT` column (`migrations/003-recording-stage.sql`),
nullable so older rows simply have none, and it round-trips through the existing
`GET /recordings` and `GET /recordings/:id` responses. It is populated once at
creation in `RecorderService.createRecording`: if `title` matches the
`"Artist - Stage - Festival"` three-part `" - "` convention the middle segment is
used; otherwise a best-effort YouTube oEmbed lookup (`REC_LIVE_OEMBED_ENDPOINT`,
`author_name`) approximates it with the channel name. That network call has a
short timeout and never blocks or fails creation — `stage` stays null on any
error. The endpoint is config (like `REC_LIVE_STREAMLINK_BIN`) so functional
tests point it off-network. Chosen over deriving on every read (the value is
stable, so store it once) and over a general metadata system (out of proportion
to this app).

**Dependencies (decision).** Build the client with **Vue 3** (runtime dependency
`vue`) and **Vite** (dev-only build tool `vite` + `@vitejs/plugin-vue`), using
Single-File Components (`.vue` files carrying template/script/style together) and
`<script setup>`. This reopens and replaces the earlier "no new npm dependencies"
position — the reopening has happened and this is the decision, not a hedge. The
reasoning: the app will grow over time, the owner reviews the code rather than
vibe-coding it, a framework keeps UI patterns consistent screen-to-screen as it
grows, and a build step is already normal here (the server compiles TypeScript
with `tsc`). Vite specifically — first-class Vue integration, near-zero config,
instant dev server, and a standard/recognisable setup for anyone reading the code
later — not webpack. Output is plain static JS/CSS/HTML; no SSR, no second
service, no change to deployment shape. State management stays **component-local**
(`ref`/`reactive` + `fetch`); no Pinia/Vuex and no `vue-router` — with only three
views a small reactive `view` state in `App.vue` is enough, and adding a router
or store would be unjustified scope for this size.

**Repository layout additions.**
- `web-client/` — the Vite + Vue source (git-tracked): `web-client/index.html`,
  `web-client/vite.config.ts`, `web-client/src/main.ts`, `web-client/src/App.vue`
  (holds the reactive `view`/`selectedId` state and switches between the three
  views), and `web-client/src/api.ts` (a thin `fetch` wrapper over the JSON API —
  the single place that knows route paths and shapes errors).
- Vue view SFCs under `web-client/src/views/`: `ArchiveView.vue`,
  `ScheduleView.vue`, `RecordingDetail.vue`. Extract a shared component only where
  it removes real duplication (e.g. `web-client/src/components/RecordingList.vue`
  shared by archive and schedule lists); do not pre-factor speculative
  components.
- `web-client/vite.config.ts`: `@vitejs/plugin-vue`, `root: "web-client"`,
  `build.outDir: "../dist/public"`, and a dev-server `proxy` forwarding
  `/recordings`, `/cookies`, and `/health` to the local Express API so
  `vite dev` works against a running backend.
- `design-prototypes/` — git-ignored (add to `.gitignore`); holds the three
  competing static-HTML themes from the gate. Never shipped or committed.

**Build and serving integration.**
- Add `vue`/`vite`/`@vitejs/plugin-vue` to `package.json`, and a `build:client`
  script (`vite build`). Extend the existing `build` script to run the client
  build after `tsc` so the client lands in `dist/public` after the `clean` step
  wipes `dist` and `tsc` repopulates it: `build` becomes
  `npm run clean && tsc -p tsconfig.json && vite build`. Add `dev:client`
  (`vite dev`) for local UI work. The container release build
  (`Dockerfile.build` → `scripts/build-release.sh`) already runs `npm run build`
  with dev dependencies present, so Vite runs there with no pipeline change.
- Serve the built client from `src/app.ts` in `createApp` via
  `express.static(<dist>/public)` mounted at `/`. Register it **after** the
  existing API routes so it never shadows `/recordings`, `/cookies`, `/health`,
  or the private routes; static serving only answers real files (`index.html`,
  hashed `assets/*`). Because the `web` release package already ships `dist/`
  (Phase 1 Part B), `dist/public` is carried along automatically — **no change to
  the deps/web/reconciler package boundaries**.

**Views and API mapping (existing Phase 0/1 routes only — no new read/write
endpoints).** `GET /recordings` filters by a **single** status
(`?status=<one>`), so the client fetches `GET /recordings` once and partitions
the result client-side rather than issuing multiple filtered calls.
- **`ArchiveView.vue`** → `GET /recordings`, keep rows with status `recorded`
  (finished/streamable), newest first; tap a row to open the detail view.
- **`ScheduleView.vue`** → same `GET /recordings` result, keep `scheduled` +
  `recording` for the upcoming/running list; **create** → `POST /recordings`;
  **edit** → `PATCH /recordings/:id`; **cancel** → `DELETE /recordings/:id`
  (existing soft cancel — keeps the row as `cancelled`); **stop early** →
  `PATCH /recordings/:id` setting `stop_at` to now (allowed while `recording`);
  **start now** → `PATCH /recordings/:id` setting `start_at` to now (while
  `scheduled`). No dedicated start/stop endpoints exist or are added.
- **`RecordingDetail.vue`** → `GET /recordings/:id` for metadata; the Phase 1
  `GET /recordings/:id/file` URL is both the `<video>` `src` and the copy-URL
  string (the file route serves `recorded` files and `409`s otherwise, so the
  player only renders for finished rows). Holds the delete control (below).

**Playback + share affordances (`RecordingDetail.vue`).**
- **Native player.** HTML5 `<video controls>` at `GET /recordings/:id/file`,
  browser built-in controls only — no custom JS player.
- **Copy stream URL.** An always-present "copy stream URL" button that puts the
  plain `http://<host>:<port>/recordings/<id>/file` URL on the clipboard, so the
  owner can paste it into VLC's *Open Network Stream* by hand on any device,
  regardless of deep-link support. This is the reliable fallback and is never
  gated behind platform detection.
- **VLC-iOS hand-off (optional, best-effort, iOS only).** VLC for iOS supports a
  hand-off URL scheme: `vlc-x-callback://x-callback-url/stream?url=<stream-URL>`
  (use this form; the plain `vlc://` scheme is unreliable). Show it as an
  **optional "Open in VLC" link on iOS only**, clearly secondary to the native
  player and the copy-URL fallback, which stay primary. Known caveats make it
  best-effort: it fails silently if VLC isn't installed, Safari shows an
  unavoidable "Open in VLC?" prompt, and reliability is inconsistent (some users
  report it working at most a couple of times, or failing via the scheme while
  the same stream opens fine when pasted manually). Frame it in the UI as "may
  not always work — use copy-URL if it doesn't." (An HLS/segmented-playlist
  pipeline was considered as a "more native" iOS path and rejected: materially
  bigger than the plain single-file `sendFile()` route already built and
  verified, and against the simplicity guidelines for a marginal gain.)

**Delete (the one new backend behaviour — removes file *and* row).** The only
deletion mechanism in the system; there is no age/size-based automated cleanup
anywhere. `DELETE /recordings/:id/file` (the route `spec.md` reserves for this)
performs a full purge: it unlinks the recording's on-disk file(s) **and** deletes
its SQLite row, so neither a dangling row pointing at a missing file nor an
orphaned file for a removed row is ever left behind. Despite `/file` in the path,
it deletes the whole record — a finished recording is only its file plus that row,
and keeping the row after the file is gone would strand a dangling reference.

1. Add `RecordingRepository.delete(id)` (deletes the row; the API remains the
   sole SQLite writer) and `RecorderService.deleteRecording(id)`: resolve the
   recording (`404` if absent), require status `recorded` (`409` otherwise, so a
   `scheduled`/`recording` row is cancelled through the existing route, never
   hard-deleted mid-capture), unlink `ts_path` (and the future `final_path`)
   tolerating an already-missing file, then delete the row. If unlink fails for
   any reason other than the file already being gone, return `500` and leave the
   row intact so the delete is safely retryable — never delete the row while its
   file may still exist.
2. Point the existing `DELETE /recordings/:id/file` handler in `src/app.ts` at
   `deleteRecording` and respond `204 No Content` on success (matching the
   `DELETE /cookies/:id` shape). Derived trim/split recordings (Phase 3) are
   independent rows with their own files and are deleted the same way, each on
   its own.
3. Extend the functional server suite (test names only):

```ts
// test/functional/server.test.ts (additional blocks)
t.test("deletes a finished recording's file and row on explicit request");
t.test("rejects deleting a recording that is not finished");
t.test("leaves no dangling row and no orphaned file after a delete");
```

**Implementation sequence.** The design-prototype gate (step 3) is a pause point
*within* implementation, not the finish line — real building continues past it.

1. Scaffold the Vite + Vue project under `web-client/` (config, `index.html`,
   `main.ts`, empty `App.vue`, `api.ts`), wire the `build`/`build:client`/
   `dev:client` scripts and `express.static("dist/public")` serving in
   `src/app.ts`, and confirm the shell loads and `api.ts` renders live
   `GET /recordings` data with throwaway markup.
2. Commit a project-root `AGENTS.md` documenting how any agent runs and debugs
   the codebase locally, so future sessions don't rediscover it from source. It
   covers the dev commands (`npm run dev:client`, `npm run build`, `npm test`),
   how to hit the API directly with curl for manual checks, and the relevant
   local ports/URLs (Vite dev server vs. the Express API). Keep it short and
   command-first; the actual file is written now during execution.
3. **Design-prototype gate.** Produce **three competing static-HTML visual
   themes** — full look-and-feel mockups with dummy data, no backend wiring — in
   the git-ignored `design-prototypes/` folder for the owner to open in a browser
   and pick one. **Each of the three prototypes must be built by an agent that
   first loads Claude Code's `frontend-design` skill** (the point of the gate is
   three genuinely distinct, intentional visual directions, not three
   templated-looking variants — so whoever dispatches the three sub-agents must
   instruct each to load `frontend-design` before building). **Pause here for the
   owner's pick;** the winning theme's HTML/CSS becomes the styling basis and the
   other two are discarded.
4. Port the chosen theme's markup and CSS into the real Vue SFCs — its layout and
   styles become the `<template>`/`<style>` of `App.vue` and the three view
   components, mobile-first with the desktop breakpoint (list + detail side by
   side past it). The static prototype is translated into components here; it is
   not shipped as-is.
5. Implement `ArchiveView.vue` and `ScheduleView.vue` against their endpoints per
   the mapping above (single `GET /recordings` fetch + client-side partition;
   create/edit/cancel; stop-early and start-now as `PATCH`es).
6. Implement `RecordingDetail.vue`: native `<video>` player, always-present
   copy-URL button, optional iOS-only "Open in VLC" link, and the delete control
   wired to `DELETE /recordings/:id/file`.
7. Implement the delete backend (`RecordingRepository.delete`,
   `RecorderService.deleteRecording`, route handler) and its functional tests.
8. **Playwright smoke pass.** Deliberately light: Playwright's built-in iPhone
   device profile (e.g. `devices['iPhone 13']`) over the core flows (list loads,
   schedule create, open detail, player present, copy-URL works, delete works),
   plus a desktop-viewport pass. Smoke-level device emulation, **not** exhaustive
   cross-device/browser mobile QA.
9. Verify on `irae-sheeta` against real recordings and confirm curl parity — no
   operation requires a browser-only path.

**Acceptance criteria — what "Phase 2 done" looks like.**
- [ ] Schedule, edit, cancel, stop-early, and start-now all work from the UI
      against real recordings on `irae-sheeta`.
- [ ] Archive view lists finished (`recorded`) recordings and plays them in the
      native `<video>` player.
- [ ] Deleting a finished recording removes both its file and its SQLite row —
      no dangling row, no orphaned file — from the UI (no manual SSH SQL/`rm`).
- [ ] Copy-URL puts a working `GET /recordings/:id/file` stream URL on the
      clipboard that opens in VLC's *Open Network Stream*.
- [ ] The optional iOS "Open in VLC" link appears on iOS only and degrades
      silently to copy-URL when it doesn't fire.
- [ ] Phone-width and post-breakpoint desktop layouts are both verified.
- [ ] Playwright's iPhone-profile pass and desktop pass are green.
- [ ] The client builds via `vite build` into `dist/public` and is served by the
      existing `web` service with no change to the release package boundaries.
- [ ] No operation requires a browser-only path — curl parity holds.

### Phase 3 — file operations

**Complexity: Medium.** Non-destructive derived-recording operations over
already-finished files. None of this touches the recorder core. (Deleting a
finished recording — file plus its SQLite row — moved to Phase 2 alongside the
other CRUD; derived recordings created here are independent rows deleted the same
way.)

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
Phase 4's remux inherits or extends this same mechanism (see Phase 4); it does
not require the earlier phases to build a heavier machinery on its behalf.
Offsets and cut points are validated numeric/`HH:MM:SS` values passed as argv,
never shell fragments.

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
   derived rows `failed`.
3. Derived recordings are listed, served, and themselves re-trimmable/re-
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

### Phase 4 — conversion and download

**Complexity: Medium.** Deprioritised — the owner said they likely will not care
about container conversion for a while, so this sits after Phase 3 and below the
web client. It is here for completeness, not near-term work.

**Job mechanism.** Remux reuses the **same lightweight one-shot tracked
`ffmpeg -c copy` job** introduced for trim/split in Phase 3 — that mechanism is
built first, in the earlier phase, so there is no forward reference to unbuilt
machinery. A full container remux is the same shape of operation as a trim (a
bounded `-c copy` pass over a finished file), so it needs nothing more robust
than trim/split already established. If, when this phase is built, concurrent
remuxes need capping or a longer job proves worth reconciling across reboot,
extend that mechanism then; do not pre-build a heavier reconciled `mux-<id>`
unit type on speculation.

1. **Remux/demux to a final container.** `ffmpeg -c copy` from the captured
   `.ts` into the final `mp4`/`mkv` container, publishing `final_path` only on
   atomic success and preserving the `.ts` on any failure. Two open decisions
   carry over unchanged and are resolved immediately before this phase, not now:
   - ⚠ **`mkv` vs `mp4`** for the final container (`-c copy`; mkv is the stated
     safe default if the audio/video codecs are not mp4-safe).
   - ⚠ **Trigger mechanism:** reconciler-driven vs. a systemd `.path` unit
     watching the output directory.
   Muxed `final_path` files are served through the existing Phase 1
   `GET /recordings/:id/file` route (already built for `.ts`); no separate
   serving-design decision remains.
2. **File download.** The Phase 1 streaming route already serves the raw bytes,
   so anyone can `curl -O` or browser-save a file today. Download is therefore a
   **UI affordance only** — a download link/button in the web client using the
   same `GET /recordings/:id/file` URL (a same-origin `<a download>`), with **no
   new backend work**. No `Content-Disposition: attachment` route is added
   unless a concrete need appears, keeping the streaming route a single code
   path.

### Lowest priority (unordered)

Deferred past every phase above, in no particular order.

**Reboot-recovery acceptance test.** The reconciler's reboot-recovery logic
(rule 1 in the reconciler tick responsibilities) already exists in code; this is
only the live verification step. Schedule a short recording, stop/restart the
dedicated user manager or reboot `irae-sheeta` during its window, and confirm
reconciliation resumes appending to the same `.ts` with a recalculated safety
cap.

**Candidates.** Bulk-import a schedule and promote entries to recordings. Decide
and document the candidate import format (⚠ JSON array vs. CSV vs. ICS; JSON is
the default assumption) immediately before building. Add the candidates
migration, repository, bulk import/list/delete API, and an atomic
promote-to-recording operation. Acceptance-test candidate promotion and
concurrent-promotion protection through curl.

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

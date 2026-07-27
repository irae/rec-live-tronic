# YouTube Live Recorder implementation plan

This plan turns `spec.md` into an implementation sequence. Phase 0 is the first
release and must be independently usable from `curl`. Later phases do not alter
the Phase 0 recording path.

## Simplicity guidelines (all future work)

These govern every new block from here on. They do not retroactively rewrite or
weaken already-shipped behaviour — the systemd hardening flags, permission
modes, sole-SQLite-writer invariant, sandboxed transient units, and existing
configuration all stay exactly as they are. "Simplify" means build the next
thing simply, not rip out working infrastructure.

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
- **Every phase ends with its changelog entry.** A phase's implementation
  sequence must literally end with adding its Beta N entry to `CHANGELOG.md`
  and bumping `package.json` to `0.N.0` (see the versioning convention under
  "Later phases"). This is a hard completion requirement, not an afterthought —
  a phase without its changelog entry is not done.

## Decisions made during betas

Architectural decisions still in force, regardless of which beta introduced
them. This is a current-state list, not a chronological log — superseded
decisions are omitted (see `CHANGELOG.md` and git log for history).

- Node.js 24 LTS, TypeScript compiled to JavaScript, npm, Express, and
  `better-sqlite3`. Production runs compiled JavaScript with `node`. SQL stays
  parameterized and explicit behind small repositories — no ORM.
- The API and reconciler run as the dedicated, non-login `rec-live-tronic`
  account under root-owned system units. A lingering systemd user manager for
  that account hosts the unprivileged `rec-<id>.service` transient recorder
  units via `systemd-run --user` / `systemctl --user`. No sudoers or polkit
  rules.
- The listen host is configuration, binding `0.0.0.0` so LAN and Tailscale
  clients both work. The application never configures Tailscale, reverse
  proxies, DNS, or firewalls — those stay deployment policy.
- The API is the sole SQLite writer. The reconciler reads SQLite directly and
  claims status transitions via compare-and-set requests to a private
  Unix-socket listener. Public routes never accept arbitrary status changes.
- Private state lives under `/var/lib/rec-live-tronic`, recordings under
  `/srv/rec-live-tronic/recordings`, config under `/etc/rec-live-tronic`. The
  shared `rec-media` group has read/write access to recordings, recorder logs,
  and cookies (group-write via `UMask=0007`); SQLite control state stays
  private to the service UID, reachable only through the private socket.
- Recording IDs are generated server-side; unit names and output paths derive
  only from those IDs. Titles, URLs, quality strings, uploaded filenames, and
  other request data never become command fragments, shell words, or
  filesystem/unit identifiers.
- Capture is streamlink's binary `--stdout` appended by systemd
  (`StandardOutput=append:<recordings-root>/<id>.ts`) — reboot-safe append
  that streamlink's own `--output` cannot provide. Recorder stderr appends to
  the shared `<id>.log` next to the media file.
- The reconciler is the authoritative scheduled stopper: once
  `now >= stop_at` it stops the unit and waits for it to go inactive before
  changing durable status. `RuntimeMaxSec` is only the dead-reconciler
  backstop; Streamlink is never trusted to enforce `stop_at`. The tick runs
  every 10 seconds. Live control commits SQLite first, then acts on the unit
  immediately (`PATCH stop_at` refreshes the backstop; cancellation stops the
  unit at once) instead of waiting for the next tick.
- The internal `last_started_boot_id` field distinguishes a transient unit
  lost during reboot (relaunch within the active window) from a unit that
  ended on the current boot (finalize according to file presence).
- Trash is orthogonal to status: a nullable `trashed_at` marks a row trashed
  while it keeps its terminal status; default and `?status=` listings exclude
  trashed rows. Permanent delete is gated to trashed rows. A deliberately
  simple in-process sweep (app start + daily interval, no reconciler, cron,
  or systemd timer) purges trash older than 30 days.
- On a finished (`recorded`) recording only free-text metadata is editable
  (`title`, `stage`, `artist`, `venue`, `event`); `start_at`/`stop_at`/
  `quality`/`url` describe what was actually captured and stay immutable
  post-capture. The title is composed server-side from
  artist/venue/event/stage only at creation when no explicit title is given,
  and is never recomposed by later metadata edits.
- ffmpeg/ffprobe work (cut extraction, MP4 remux) runs as in-process one-shot
  `execFile` jobs — argv only, never a shell, bounded timeouts, binaries from
  the `ffmpegBin`/`ffprobeBin` config. No per-job systemd units, no
  reconciler involvement.
- Cut workflow: at most one active draft per source, its preview pieces in
  `recordingsDir/<sourceId>/`; Keep promotes chosen pieces to independent
  first-class `recorded` rows (`cut_from_id` lineage, real wall-clock
  sub-windows, inherited url/stage/quality, null `cookie_id`); the source is
  renamed and moved to trash on Keep — never destroyed by the cut itself.
- Finished recordings are served as faststart MP4 (H.264+AAC stream copy)
  produced by a post-capture in-process remux; browser playback is a plain
  `<video src>` with no client-side transmuxing library. Serving stays
  extension-aware forever, so a row whose remux failed keeps serving its
  `.ts`. (Phase 6 — full design in that section below.)

## Target host & root-installed dependencies

`irae-sheeta`: Debian 13 (`trixie`) x86-64, systemd 257, reached at
`irae-sheeta.tailc9708.ts.net` (host context, not an application dependency).
`/tmp` is a small tmpfs and must not hold recordings. The SSH account has no
sudo; root is used only for reviewed install/upgrade runs.

Installed by root before the repository's installer, which verifies versions
and never silently installs OS packages:

- Node.js 24 LTS with npm. (`better-sqlite3` ships prebuilt in the release
  tarball — the host installs no compiler toolchain.)
- A root-managed pipx Streamlink (pinned 8.4.0) at
  `/usr/local/bin/streamlink`, provisioned under `/opt/pipx` — never the
  human-owned installation under `/home/irae/.local`.
- `ffmpeg`/`ffprobe` (cut extraction since Phase 5, MP4 remux from Phase 6) —
  already present on the host.
- SQLite CLI for diagnosis and backup checks.

## Repository layout notes

The tree itself is the layout reference; only the non-obvious parts are worth
stating:

- `scripts/install-root.sh` — short, auditable root-side installer. A full run
  provisions the host and installs all three packages; `--deps`/`--web`/
  `--reconciler` do a fast partial redeploy, each selected package extracted
  and replaced unconditionally (no change detection).
- `scripts/install-sheeta.sh` — the owner's personal scp+ssh wrapper around
  `install-root.sh`. Deliberately absent from the README, which documents only
  the host-agnostic install path.
- `Dockerfile.build` + `scripts/build-release.sh` — reproducible Debian 13
  `linux/amd64` build/test/release producing the `web`/`reconciler`/`deps`
  tarballs.

## Functional test approach

Keep automated testing proportional to this small project; `tap` is the test
framework and runner. `npm test` builds the program and runs the functional
suites against its real process entry points: the server suite exercises the
public HTTP surface over a temporary SQLite database and filesystem, and the
recording-lifecycle suite drives the real one-tick reconciler with stub
`systemd-run`/`systemctl`/`streamlink`/`ffmpeg`/`ffprobe` executables at the
operating-system boundary. Tests assert observable API status, files, and
unit effects, not individual functions. Small pure helpers with real
edge-case surface (offset parsing, ffmpeg argv building, keyframe picking)
get targeted unit tests under `test/unit/`. Real systemd, Streamlink, the
release tarball, and the installer get pragmatic smoke checks during
`irae-sheeta` acceptance runs. Browser smoke passes use the Playwright
harness under `test/e2e/`.

## Phase 0 — done

Core recorder: Express API + finite reconciler tick + Streamlink over SQLite,
detached `rec-<id>` transient systemd units, release build + auditable
installer. See `CHANGELOG.md` — Beta 0. The architecture later phases build on
stays captured in "Decisions made during betas" above and "Operational
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

**Renumbering note (2026-07-26).** A new **Phase 7 — duration correctness +
stream-gap tracking** (scope reserved, design pending) was inserted after
Phase 6b; the former Phase 7 (audio-only) is now **Phase 8** and the former
Phase 8 (candidates) is now **Phase 9**.

**Versioning convention.** Completing Phase N bumps `package.json`'s `version`
to `0.N.0` (release-facing name: Beta N — see `CHANGELOG.md`). Phases 0–5 are
shipped, so the current version is `0.5.0`; completing **Phase 6a** ends by
bumping to `0.6.0` (Phase 6b, being deferred later work, doesn't gate this
bump and doesn't necessarily need one of its own — decide when it's picked
up).

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

### Phase 6a — MP4 transition (drop mpegts.js)

**Complexity: Medium.** Serve every finished recording as **MP4** (H.264+AAC
stream copy, `-movflags +faststart`) instead of raw MPEG-TS, so in-browser
playback becomes a plain `<video src>` on every platform and `mpegts.js` is
removed entirely. Capture is untouched: streamlink still appends MPEG-TS to
`<recordingsDir>/<id>.ts` (append-safe mid-write — that property stays load-
bearing); the MP4 is produced by a post-capture remux. This phase absorbs and
supersedes the old "Phase 8 — conversion, demux, format" sketch: its two open
decisions are resolved below, its download item is already shipped (Phase 4's
`?download=1`), its demux item is deferred (see "Lowest priority").

**Hard safety rule structuring the whole phase: no `.ts` file is deleted from
disk until the owner signs off the full manual verification.** This phase
(6a) ships code and the backfill with every `.ts` kept on disk as a safety
net — nothing in 6a ever deletes a `.ts`. Actually disposing of `.ts` files is
its own later phase, **Phase 6b** (below), deliberately not bundled into 6a:
6a's own steps end with docs/changelog/version (step 10), then go through a
fresh-context implementation review and the owner's own deploy + full manual
verification before 6a is considered done at all. Phase 6b — planned in more
depth once 6a actually ships — is a distinct, later piece of work, not a
same-phase final step.

**Decisions (all resolved here — implementation requires no judgment calls).**

- **Container: MP4** (`-c copy -movflags +faststart`). Hands-on verified in
  `docs/serving-format-research.md` (§2: real production `.ts` remuxed at
  2300x realtime, identical codecs, `moov` correctly front-loaded; §4: MKV
  ruled out — no native `<video>` support). Re-verified at scale during plan
  review, on the production host itself (`sheeta`, ffmpeg 7.1.5): the exact
  step-3 argv remuxed the largest existing capture (5.5 GB, 4h25m, 1080p) in
  27 s with zero warnings, output duration matching the source within
  0.001 s, both streams present, `moov` front-loaded; the step-6 cut argv
  (`-ss`/`-t` + `+faststart` + `-f mp4` to a `.tmp`-named output) likewise
  produced a clean, faststart-ed 120 s piece from the same file. `-c copy`
  alone is sufficient — ffmpeg ≥ 3.2 auto-inserts the `aac_adtstoasc`
  bitstream filter when muxing ADTS AAC into MP4, and converts Annex-B H.264
  to AVCC automatically, so no explicit `-bsf` argument exists in this phase;
  a damaged capture that nonetheless fails to remux is contained by the
  per-file verification + keep-the-`.ts` fallback below. Resolves the old ⚠
  mkv-vs-mp4 open decision.
- **Job mechanism: the in-process one-shot `execFile` ffmpeg job** Phase 5
  built for cut extraction (`src/api/cut-extract.ts` pattern — argv only,
  never a shell, bounded timeout). No reconciler involvement, no systemd
  `.path` unit. Resolves the old ⚠ trigger-mechanism open decision.
- **`ts_path` keeps its column name** and simply holds an `.mp4` path after
  the transition. A rename would need a migration plus renaming the `tsPath`
  identifier through repository/service/client/tests for zero behavioral
  gain — contrary to the simplicity guidelines. The mismatch gets a one-line
  note in `spec.md`'s data-model section (already there — see step 10).
- **Playback gating still holds: this app never plays an in-progress
  recording.** Re-confirmed in `docs/serving-format-research.md` §1 —
  `RecordingDetail.vue` mounts its player only under
  `v-if="recording.status === 'recorded'"`, and `CutConsole.vue` previews
  only extracted pieces. Dropping `mpegts.js` loses nothing.
- **Cut pieces are extracted natively as `.mp4`** — no separate remux step
  ever exists for Cut/Keep output. Sound because the extraction is the same
  `-c copy` stream copy; an explicit `-f mp4` keeps the `.tmp`-suffixed
  working name working (the exact reasoning the current `-f mpegts` comment
  in `src/api/cut-extract.ts` documents); `+faststart` needs seekable output,
  which a regular file is; and the ffprobe keyframe snap reads any input
  container. Cut sources may be `.ts` (not yet backfilled) or `.mp4`
  (backfilled/native) — ffmpeg reads both, no branching needed.
- **Backfill mechanism: a curl-triggered API route**
  (`POST /recordings/backfill-mp4`), not a `scripts/` script and not an
  `install-root.sh`/migration step. Decisive reason: the API is the sole
  SQLite writer (operational invariant) — a standalone script updating
  `ts_path` would either violate that or require stopping the service, and it
  would also need root/service-account access to the private data dir. A
  route matches the repo's curl-first style, runs with the service's own
  config and permissions, is idempotent (re-run until clean), and stays
  useful as recovery tooling. The owner runs one curl command (step 9).
- **Final `.ts` disposal (Phase 6b): delete outright, no quarantine.** The
  remux is a stream copy — the elementary streams are bit-identical by
  construction — and every output is verified with ffprobe (duration match +
  both streams present) *before* the source `.ts` is touched. A quarantine
  directory would add a sweep, states, and disk pressure to guard against a
  failure mode the verification already catches deterministically. The
  failure path IS the quarantine: if remux or verification fails, the `.ts`
  is kept, the row keeps serving it, and the error is `console.error`ed. This
  decision carries forward unchanged to Phase 6b whenever it's picked up.

**Serving/back-compat model (permanent, not transitional).**
`serveRecordingFile` in `src/app.ts` becomes extension-aware: Content-Type and
the Content-Disposition filename extension derive from `extname(tsPath)`
(`.mp4` → `video/mp4`, anything else → `video/mp2t` with `.ts`). This is kept
forever, not just during migration: a row whose live remux failed stays a
served, VLC-playable `.ts`, so a remux failure never breaks serving.

**Implementation sequence (commit after each numbered step).**

1. **ffmpeg back into the build image; un-skip the real-ffmpeg test.**
   Bandwidth is no longer a constraint (owner-confirmed; reverses commit
   `1e91b94`'s removal). In `Dockerfile.build` line 4, add `ffmpeg` to the
   `apt-get install -y --no-install-recommends` list of the `build` stage. In
   `test/unit/cut-extract.test.ts` line 47, change `t.skip(` to `t.test(`
   (the test resolves ffmpeg via `REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg"` on
   PATH). Done when: `npm test` passes locally and `scripts/build-release.sh`
   completes. Commit.
2. **Extension-aware serving (ships while every file is still `.ts`).** In
   `src/app.ts`: give `sanitizeFilename` (line 45) an `extension` parameter
   instead of the hardcoded `".ts"` suffix; in `serveRecordingFile`, derive
   the extension from `extname(tsPath)`, set `Content-Type` to `video/mp4`
   for `.mp4` else `video/mp2t`, and use `${id}<extension>` as the fallback
   filename; in the cut-piece route (`GET
   /recordings/:id/cut/:draftId/pieces/:index/file`), derive Content-Type
   from the piece path's extension the same way. Done when: `npm test` green
   and a `.ts` recording serves with identical headers to today. Commit.
3. **Remux capability.** New file `src/api/remux.ts` exporting:
   - `buildRemuxArgv(sourcePath: string, outputPath: string): string[]` —
     the argv `-y -i <sourcePath> -c copy -movflags +faststart -f mp4
     <outputPath>`.
   - `remuxToMp4(ffmpegBin: string, ffprobeBin: string, sourcePath: string,
     outputPath: string): Promise<void>` — runs ffmpeg to
     `${outputPath}.tmp`, verifies the tmp with ffprobe, then atomically
     `rename()`s to `outputPath`. Verification is two argv-only ffprobe
     calls in `cut-extract.ts`'s style (`-v error … -of csv=p=0`, 10s
     timeout each): `-show_entries format=duration` on both source and tmp
     must agree within 1 second, and `-show_entries stream=codec_type` on
     the tmp must yield exactly one `video` and one `audio` line. Any
     failure throws, best-effort removes the `.tmp`, and leaves no final
     `.mp4`. ffmpeg timeout: a fixed 10 minutes (600_000 ms) — measured on
     the production host, the largest existing capture (5.5 GB / 4h25m)
     remuxes in 27 s *including* faststart's second pass (which re-reads
     and rewrites the whole `mdat` in place — no extra temp file, but
     roughly double the write I/O — already inside that 27 s), so 10
     minutes is >20x headroom; a hung ffmpeg must not leak.
   Add `RecordingRepository.updateTsPath(id: string, tsPath: string)` to
   `src/recordings/repository.ts` (plain UPDATE + `updated_at`; API remains
   the sole writer). Unit tests in new `test/unit/remux.test.ts`, following
   `test/unit/cut-extract.test.ts`'s init pattern (env-resolved real ffmpeg):

   ```ts
   t.test("buildRemuxArgv emits copy, faststart, explicit mp4 format, and the tmp-safe output path");
   t.test("remuxToMp4 produces a verified mp4 from a real .ts and removes the .tmp");
   t.test("remuxToMp4 rejects and leaves no output when verification fails");
   ```
   Commit.
4. **Live remux for new recordings.** In `src/api/service.ts` add
   `RecorderService.remuxRecording(id): Promise<"remuxed" | "skipped" |
   "failed">`: returns `"skipped"` unless the row exists, status is
   `recorded`, and `tsPath` ends with `.ts`; output path
   `join(this.config.recordingsDir, `${id}.mp4`)`; on success call
   `this.recordings.updateTsPath(id, <mp4 path>)` and return `"remuxed"`.
   It does **not** delete the `.ts` (Phase 6b adds that). **It must never
   reject:** its entire body sits inside one try/catch; the catch
   `console.error`s the real error and returns `"failed"` — the row keeps
   serving its `.ts`. Hook it in `RecorderService.transition` (currently
   `src/api/service.ts:631`): when a transition successfully lands
   `status === "recorded"`, fire-and-forget `void this.remuxRecording(id)`
   — safe from unhandled rejections only because of the never-reject
   guarantee above, and the reconciler's CAS response must never wait on
   ffmpeg. Functional-test support: extend the functional suite's ffprobe
   stub (`test/functional/server.test.ts` line 43, currently `exit 1`): when
   its argv contains `format=duration` print a fixed duration (e.g.
   `120.0`), when it contains `stream=codec_type` print `video` and `audio`
   on two lines, and keep exiting 1 otherwise (the keyframe-snap calls use
   `format=start_time`/`frame=pts_time`, so they still fail fast and
   keyframe-snap behavior is unchanged) — remux verification then passes
   against the plain-text fixtures; the ffmpeg stub already copies input to
   output regardless of extension. Commit.
5. **The backfill route.** `POST /recordings/backfill-mp4` in `src/app.ts` →
   new `RecorderService.backfillMp4()`: iterate every `recorded` row
   **including trashed ones** (trash serves downloads/players too) whose
   `tsPath` ends `.ts`, await `remuxRecording` sequentially (never in
   parallel — the work is disk-throughput-bound, so parallelism only adds
   seek contention without finishing sooner), and tally its
   `"remuxed"`/`"skipped"`/`"failed"` return values into the response
   `{ "remuxed": <n>, "skipped": <n>, "failed": ["<id>", …] }`. Idempotent:
   a re-run only touches rows still on `.ts`. No body/params in this step
   (Phase 6b adds `delete_ts`). Commit.
6. **Cut pipeline emits `.mp4` pieces.** In `src/api/cut-extract.ts`, change
   `buildExtractArgv` to output `-c copy -movflags +faststart -f mp4` (drop
   `-f mpegts`; update the comment's reasoning — the `.tmp` argument is
   unchanged). In `src/api/service.ts`, replace every `piece-${index}.ts`
   with `piece-${index}.mp4` (the extraction loop ~lines 232–248,
   `getCutPieceFile` line 284, the keep loop line 378) and the Keep
   destination becomes `join(recordingsDir, `${newId}.mp4`)` with
   `tsPath: destPath` as today. The Adjust stale-piece cleanup removes both
   `piece-N.ts` and `piece-N.mp4` names (drafts spanning the deploy). A
   pre-deploy in-flight draft simply regenerates on Adjust; drafts are
   24h-swept, so no migration. Update the cut unit/functional tests'
   expected filenames. Commit.
7. **Purge unlinks both siblings.** In `purgeOne` (`src/api/service.ts`,
   currently ~line 620): after unlinking `recording.tsPath`, also unlink the
   sibling path with the other extension (`<recordingsDir>/<id>.ts` when
   `tsPath` ends `.mp4`, and vice versa), tolerating ENOENT — so a
   backfilled-then-purged row cannot orphan its safety-net `.ts`. Commit.
8. **Frontend drops `mpegts.js`.**
   - `web-client/src/views/RecordingDetail.vue`: remove the `mpegts` import,
     `useMpegts`, `setupPlayer`/teardown and the player branch — one plain
     `<video ref="videoEl" :src="streamUrl" controls>`.
   - `web-client/src/components/CutConsole.vue`: same — drop the
     `piecePlayers` map and lazyLoad workaround; plain
     `<video :src="piece.file_url" controls>` per piece.
   - `web-client/src/lib/file-url.ts` line 11: friendly-filename suffix
     `.ts` → `.mp4`. (Cosmetic-only mismatch for a not-yet-backfilled row is
     acceptable: the server's Content-Disposition carries the true name and
     VLC sniffs content; the backfill runs at deploy time anyway.)
   - Download labels "⬇ Download .ts" → "⬇ Download .mp4" in
     `RecordingDetail.vue` (line 119) and `TrashView.vue` (line 44).
   - Remove the `"mpegts.js"` dependency — note it lives in the **root**
     `package.json` (line 26; `web-client/` has no own package.json) — and
     run `npm install` to refresh `package-lock.json`.
   Done when: `npm run build` passes and `grep -rn mpegts web-client/
   package.json` returns nothing. Commit.
9. **Deploy, backfill, verify — then PAUSE.** Deploy normally
   (`scripts/install-sheeta.sh`). Owner runs the one-time backfill:

   ```sh
   curl -X POST http://irae-sheeta.tailc9708.ts.net:8787/recordings/backfill-mp4
   ```

   Re-run until `failed` is empty (idempotent). Then the owner works through
   `agent-communications/testing-plan-mp4-transition.md` end to end, against
   both a backfilled recording and a freshly-captured (natively-remuxed) one.
   Every `.ts` is still on disk throughout. **Phase 6a is not done until that
   checklist passes** (any bugs found get fixed before it's considered done).
   Phase 6b (final `.ts` cleanup, below) is separate later work, not a
   continuation blocked on this pause.
10. **Docs + version (last step of 6a — every phase ends here, no
    exceptions).** `spec.md` and `CHANGELOG.md` were already brought to this
    phase's target end-state during plan review (MP4 as the decided
    container/trigger, `mpegts.js` removed from the described architecture,
    the `ts_path`-holds-`.mp4` data-model note) — this step is a
    confirmation pass, re-check both against what was actually built and
    correct any drift, it is not starting from scratch. Bump `package.json`
    `version` to `0.6.0` (it was set to `0.5.0` when this plan landed) and
    add the Beta 6 entry to `CHANGELOG.md`. Commit.

**Phase 6a is done only once:** steps 1–10 are implemented and committed,
a fresh-context MAX-tier agent has reviewed the actual implementation
(code, tests, and docs together — not the plan) and any bugs it found are
fixed, and the owner has deployed, backfilled, and worked through the
testing plan with any resulting bugs fixed too. Phase 6b is planned and
started only after that.

**Functional tests** (server suite, names only):

```ts
// test/functional/server.test.ts (additional blocks)
t.test("serves a .ts recording as video/mp2t with a .ts filename");
t.test("serves an .mp4 recording as video/mp4 with an .mp4 filename");
t.test("remuxes to mp4 and re-points ts_path when a recording finalizes");
t.test("keeps serving the .ts when a remux fails");
t.test("backfill-mp4 remuxes every remaining .ts row, including trashed ones, and reruns clean");
t.test("cut pieces are extracted, served, and promoted as mp4");
t.test("permanent delete removes the .mp4 and its leftover .ts sibling");
```

**Acceptance criteria — what "Phase 6a done" looks like.**
- [ ] The release build image contains ffmpeg again and the real-ffmpeg unit
      test runs un-skipped.
- [ ] A freshly-captured recording is automatically remuxed to `.mp4` on
      finalize and plays via plain `<video>` in Chrome, Safari, and Firefox.
- [ ] Every pre-existing recording was backfilled to `.mp4` by the curl route,
      with every `.ts` file still intact on disk (6a never deletes one).
- [ ] `mpegts.js` is gone from the client and from `package.json`.
- [ ] Cut previews and promoted pieces are `.mp4` end to end; re-cutting a
      backfilled recording works.
- [ ] A failed remux leaves the row serving its `.ts` (extension-aware route)
      with the real error logged.
- [ ] curl parity holds for the backfill route — no browser-only path.
- [ ] `package.json` is `0.6.0`; `CHANGELOG.md` has the Beta 6 entry.
- [ ] A fresh-context MAX-tier implementation review has run and any bugs it
      found are fixed; the owner has completed
      `agent-communications/testing-plan-mp4-transition.md` and any bugs
      found there are fixed too.

### Phase 6b — final `.ts` cleanup (later, separate work)

**Complexity: Low — deliberately deferred, not part of 6a.** Once Phase 6a has
shipped and been running long enough that the owner is comfortable, this
phase actually deletes the now-redundant `.ts` files (backfilled ones with a
verified `.mp4` sibling, and going forward, every new recording's `.ts` right
after its live remux is verified). Not planned in implementation-sequence
detail here — do that when 6a has actually shipped and this is picked up —
but the decisions below carry forward unchanged from 6a's plan review and
should not be re-litigated:

- **Delete outright, no quarantine** (see the "Final `.ts` disposal" decision
  under Phase 6a) — the remux is a verified stream copy, and the failure path
  (keep serving the `.ts`) already is the safety net.
- `remuxRecording` gains a deletion tail: after a successful verify + rename +
  `updateTsPath`, unlink the source `.ts` (ENOENT tolerated, other unlink
  failures `console.error`ed, non-fatal). End-state flow becomes: record →
  reconciler finalizes `recorded` → API remuxes + verifies → `.ts` deleted
  immediately.
- `backfillMp4` gains an optional JSON body `{"delete_ts": true}`: for rows
  whose `tsPath` already ends `.mp4` with a leftover `.ts` sibling, re-verify
  the `.mp4` with ffprobe and unlink the `.ts`, reporting those in the same
  response counts. Owner runs this once, same curl-first pattern as 6a's
  backfill.
- Functional tests (names only, to add when this phase is actually planned):

  ```ts
  t.test("delete_ts backfill removes only verified leftover .ts files");
  t.test("deletes the source .ts after a verified live remux");
  ```
- Ends, like every phase, with its own `CHANGELOG.md` entry (folding into the
  Beta 6 entry or a small Beta 6b addendum — decide when this is planned) and
  a version bump if the versioning convention calls for one at that point.

### Phase 7 — duration correctness + stream-gap tracking

**Not yet planned in detail — scope reserved, design pending.** Verify and
correct every recording's `stop_at` against the real, ffprobe-measured
duration of its actual media file rather than trusting `stop_at - start_at`,
since a capture's file can contain real internal gaps (streamlink reconnect
stalls) that complicate what "duration" even means. Track and flag when a
capture had a stream gap — streamlink reconnected but didn't recover
seamlessly — recording gap count, offset, and per-gap duration in the DB and
surfacing them in the UI (a count badge with click-through to a detail
dialog). This connects to the PTS-gap collapse/preservation fixes in the remux
and cut-extraction pipelines (commit `4427cda`, and the `remux.ts` equivalent
`b5bdb68`): this phase is about making the recording lifecycle correctly aware
of and honest about those gaps, not just handling them safely at the file
level. No schema, API shape, or implementation sequence is decided here.

### Phase 8 — audio-only

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

### Phase 9 — candidates (research)

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

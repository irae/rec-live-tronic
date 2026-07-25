# Changelog

Release-facing history. Each **Beta N** is the completed milestone plan.md
tracks internally as **Phase N**, and corresponds to package version `0.N.0`
(convention: completing Phase N bumps `package.json` to `0.N.0`). Entries are
deliberately high-level — full rationale and step-by-step history live in
`git log`, per this repo's doc conventions.

## Beta 0 — core recorder (`0.0.0`)

Node 24 / TypeScript Express API + finite reconciler tick + Streamlink over
SQLite (WAL, `better-sqlite3`), curl-first. Recordings run as detached
`rec-<id>` transient `systemd --user` units that survive API/reconciler
restarts; the reconciler is the authoritative scheduled stopper. Schedule,
list, live-edit `stop_at`, cancel, and cookie upload via curl. Containerized
`linux/amd64` release build, auditable `scripts/install-root.sh`, shared
`rec-media` group access. Live-acceptance-tested on `irae-sheeta`. Capture
uses streamlink `--stdout` + systemd `StandardOutput=append:` because
streamlink's own `--output`/`--force` cannot do reboot-safe appends. The
originally sketched `muxed` status and `final_path` column never shipped —
finished recordings stay `recorded`, and the later MP4 remux (Phase 6)
re-points `ts_path` in place instead.

## Beta 1 — VLC streaming + package split (`0.1.0`)

`GET /recordings/:id/file` serves finished recordings with HTTP range support
(VLC-openable, seekable). Release split into `web` / `reconciler` / `deps`
tarballs so code-only deploys skip the large dependency transfer.

## Beta 2 — web client (`0.2.0`)

Mobile-first Vue 3 + Vite SPA (`web-client/`) served by the existing Express
API: schedule (create/edit/cancel/start-now/stop-early), archive, and
per-recording detail with `mpegts.js` playback, copy-stream-URL, and iOS/Mac
"Open in VLC" links. Optional `stage` label derived at creation. Hard delete
(`DELETE /recordings/:id/file`) removing file + row. Known mpegts.js
limitation, later mooted by the Phase 6 MP4 transition: it cannot be told an
accurate up-front duration for MPEG-TS, so with `lazyLoad` on (required for
multi-GB files), duration/seek-to-end only became accurate progressively as
the file demuxed.

## Beta 3 — trash / retention (`0.3.0`)

Delete became a reversible move-to-trash (`trashed_at` column); dedicated
Trash view with restore and gated permanent delete; global header disk-space
readout (actual + projected free space); simple app-start + daily 30-day
trash auto-purge.

## Beta 4 — misc actions, metadata, and UX batch (`0.4.0`)

Scheduling/download quality-of-life (Phases 4, 4a, 4b): `1:10` duration
default, Now mode (create-and-start immediately), 10s reconciler tick, oEmbed
title prefill, raw-`.ts` download with friendly filenames, metadata-driven
quality picker for live URLs. Title/stage editing on finished recordings with
an Edit-prominent detail layout. `artist`/`venue`/`event` metadata columns
with server-side title composition, toast system, no-confirm trash, Archive
quick-delete, global blinking recording indicator.

## Beta 5 — the Cut workflow (`0.5.0`)

Non-destructive Trim/Split over finished recordings via preview-then-promote:
`ffmpeg -c copy` extraction (keyframe-snapped via ffprobe) into per-source
working folders, playable rough-cut previews, Adjust loop, and Keep promoting
pieces to first-class `recorded` rows with lineage (`cut_from_id`), real
wall-clock dates, and full per-piece metadata overrides. Plus the follow-up
UX pass: per-piece VLC links, friendly file URLs, source renamed + trashed on
Keep, full-width console, unified 60s polling, Archive sort control.

## Beta 6 — the MP4 transition (`0.6.0`)

Finished recordings are now served as faststart MP4 instead of raw MPEG-TS:
an in-process one-shot `ffmpeg -c copy -movflags +faststart` stream-copy
remux runs automatically when a recording lands `recorded`, verified with
ffprobe (duration match, both streams present), plus a one-time idempotent
`POST /recordings/backfill-mp4` sweep to remux every pre-existing recording.
Cut/Split pieces are now extracted natively as `.mp4` rather than remuxed
after the fact. `mpegts.js` is dropped entirely — every player is a plain
`<video>` element. Every `.ts` file is kept on disk as a safety net (no
deletion in this phase — that's separate, later Phase 6b work).

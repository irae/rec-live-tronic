# Trim/Split Preview Research: "Fake Preview URL" vs. Client-Side Scrub

## Executive Summary

Phase 5 (planned) adds non-destructive trim/split: `POST /recordings/:id/trim` and
`.../split` run a real `ffmpeg -c copy -ss <start> [-to <end>]` job that produces a
**new derived recording row** with its own file; the source `.ts` is never modified.
This document investigates a *preview* shown **before** the user commits to that real
job. An earlier pass looked at (1) client-side scrub in the existing `mpegts.js`
player and (2) a disposable server-side `ffmpeg -c copy` clip, and the owner asked for
a proper look at a **third** option: a *fake preview URL* — an endpoint that
byte-range-serves a slice of the **already-captured `.ts` file**, starting near the
nearest keyframe to the requested cut, so a player begins clean decode there, **without**
a full ffmpeg remux.

**Verdict:** The "fake preview URL" (raw byte-range slice of the existing `.ts`) is
**technically feasible but not worth building** — it is strictly dominated by
`ffmpeg -ss … -to … -c copy`, which is *equally* cheap (I/O-bound, ~0.03 s to extract a
10 s range in local testing, and scales with the *clip* length, not the source file
length) yet produces clean, self-contained, near-zero-PTS output, whereas the raw slice
inherits boundary decode glitches and a large non-resettable timestamp offset, and still
requires an `ffprobe` keyframe scan to compute the byte offset. **The genuinely cheapest
option needs no server at all:** this app's existing `mpegts.js` player **already does
keyframe-accurate, byte-offset-based client-side seeking** (verified in its source
below), and the "imprecise duration" limitation this repo documented is almost entirely
moot for a *scrub-to-mark* interaction, because a mark can only be placed on a frame the
user has navigated to — which is therefore already demuxed and accurate.

**Recommendation:** Client-side preview in the existing player (mark in/out by scrubbing,
play-from-in, auto-pause-at-out overlay) — **zero backend, no new dependency, no new
route.** If a server-rendered preview is ever wanted anyway, use the short-range
`-c copy` extraction (ephemeral temp file or stream), **not** a hand-rolled byte-range
slice — that idea can be dropped. Trash-and-redo (Phase 3) remains the ultimate safety net.

All commands below were run locally against a synthesized 60 s / 21 MB 720p H.264+AAC
MPEG-TS with a fixed 2 s GOP (`ffmpeg -f lavfi -i testsrc2 … -c:v libx264 -g 48
-keyint_min 48 -sc_threshold 0 -c:a aac -f mpegts`), on `ffmpeg`/`ffprobe` 8.1.1. The
host and this app already depend on both binaries (`plan.md`: "`ffmpeg` … already
present"; `package.json`: `mpegts.js ^1.8.0`).

---

## 1. Does ffprobe expose keyframe positions (time *and* byte offset) cheaply?

### Finding: Yes — timestamps **and** byte offsets, without a full decode, and windowable

`ffprobe` with `-skip_frame nokey` demuxes but only *returns* keyframe (I-picture)
frames, and `frame=pkt_pos` gives the **byte offset** of each keyframe's packet directly:

```
$ ffprobe -v error -select_streams v -skip_frame nokey \
    -show_entries frame=pts_time,pkt_pos,pict_type -of csv=p=0 test.ts
1.483333,564,I
3.483333,714024,I
5.483333,1497044,I
7.483333,2206556,I
9.483333,3009504,I
...            (30 keyframes total for the 60 s file, i.e. one per 2 s GOP)
```

Two things matter here for the "fake preview URL" idea:

1. **Byte offset is directly available** (`pkt_pos`), not just the timestamp — so you
   *could* compute where to start a raw byte-range slice.
2. **The first keyframe's offset is 564, not 0** — the leading PAT/PMT program tables sit
   in the packets *before* the first keyframe. This is the whole crux of §2: a byte slice
   that starts *at* a keyframe skips the file's original leading PAT/PMT.

**Cost, and why it doesn't need to scan a multi-GB file.** A full keyframe scan of the
60 s file was ~0.12 s; `-skip_frame nokey` avoids per-frame *decode* work but still walks
the container end-to-end, so full-file cost scales with duration/size (a multi-hour
capture would be seconds-to-tens-of-seconds, not instant). But you never need the whole
file: `-read_intervals` seeks and scans only a window around the requested cut point:

```
$ ffprobe -v error -read_intervals 30%40 -select_streams v -skip_frame nokey \
    -show_entries frame=pts_time,pkt_pos -of csv=p=0 test.ts     # ~0.046 s
31.483333,11209312
33.483333,12009816
35.483333,12719328
...
```

So finding the nearest keyframe to a requested cut is an **O(window)**, sub-100 ms
operation regardless of total recording length. This part of the idea is real and cheap.

**Key Sources:**
- [FFprobe documentation — `-show_frames`, `-select_streams`, `-read_intervals`](https://ffmpeg.org/ffprobe.html)
- [FFmpeg `-skip_frame` decoder option (`nokey` = keep only keyframes)](https://ffmpeg.org/ffmpeg-codecs.html#Decoders)
- [StackOverflow — listing keyframe timestamps and byte positions with ffprobe (`pkt_pos`, `skip_frame nokey`)](https://stackoverflow.com/questions/18085458/how-to-see-the-actual-keyframes-in-a-video)
- [FFmpeg Wiki — Seeking (`-ss` before `-i` does a fast keyframe-accurate input seek)](https://trac.ffmpeg.org/wiki/Seeking)

---

## 2. Is a raw byte-range slice starting at a mid-file keyframe actually playable?

### Finding: Yes, it parses and decodes — *because* PAT/PMT recur — but with real caveats that erase its advantage

MPEG-TS is a 188-byte-packet stream whose PAT/PMT program tables are re-emitted
periodically (FFmpeg's mpegts muxer defaults to a PAT/PMT period of ~0.1 s; streamlink's
captures are concatenated HLS segments, each of which *begins* with PAT/PMT — so tables
recur every few seconds in real captures). A demuxer that starts mid-file resyncs on the
next `0x47` sync byte and picks up the next PAT/PMT. Confirmed against a raw `dd` slice
starting exactly at the 31.48 s keyframe's byte offset (11209312), **no ffmpeg remux**:

```
$ dd if=test.ts of=slice_raw.ts bs=1 skip=11209312 count=4000000
$ ffprobe -v warning slice_raw.ts        # resyncs, finds the program:
codec_name=h264 / codec_type=video
codec_name=aac  / codec_type=audio
start_time=31.158000
```

So a mid-file slice **is** a valid, self-describing TS on its own — no need to manually
re-inject PAT/PMT. But decoding it exposes two problems that a preview would inherit:

```
$ ffmpeg -v error -i slice_raw.ts -f null -
[h264] Reference 2 >= 2
[h264] error while decoding MB 68 28, bytestream -4     # boundary GOP glitch
$ ffprobe -count_frames … slice_raw.ts  →  255 frames decoded (recovers after the glitch)
```

1. **Boundary decode glitches.** The first packets of the slice are mid-GOP fragments /
   B-frames referencing frames that no longer precede them, so the decoder emits errors
   until the next clean keyframe+PAT/PMT. It recovers, but the first fraction of a second
   is corrupt.
2. **Non-zero start PTS (31.158 s).** The slice keeps the source's original timestamps, so
   a player shows the preview starting at ~31 s, not 0, and you cannot reset that without
   rewriting timestamps — which *is* a remux. mpegts.js would range-fetch and play it, but
   the scrubber would read wrong.

**Why this matters:** the only thing the raw-slice approach buys over a real
container-level extraction is "avoid running ffmpeg." §3 shows that avoidance saves
nothing, because the container-level extraction is *itself* near-instant — while fixing
both caveats for free.

**Key Sources:**
- [ISO/IEC 13818-1 (MPEG-2 Systems / Transport Stream) — 188-byte packets, PAT/PMT, PCR](https://en.wikipedia.org/wiki/MPEG_transport_stream)
- [FFmpeg mpegts muxer — periodic PAT/PMT (`pat_period` / `sdt_period`) defaults](https://ffmpeg.org/ffmpeg-formats.html#mpegts-1)
- [Apple HLS spec — each MPEG-TS media segment must carry PAT/PMT so it decodes independently](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- Local decode evidence above (`ffmpeg -f null -` boundary errors; `start_time=31.158`).

---

## 3. The "cheap reslice" middle ground: `-ss … -to … -c copy` on the short range

### Finding: This is the actual pragmatic server option, and it dominates the raw slice

The earlier pass rejected "a disposable server-side preview clip" as *duplicating the real
trim job*. That rejection is correct on **simplicity/duplication** grounds (it is literally
the same ffmpeg invocation Phase 5's trim already runs) — but it was framed as if the clip
were *expensive*. It is not. `-c copy` does no decode/encode; with `-ss` placed **before**
`-i`, ffmpeg fast-seeks to the input keyframe, so cost scales with the **clip** length, not
the source length:

```
$ ffmpeg -y -v error -ss 31.48 -to 41.48 -i test.ts -c copy reset_out.ts    # ~0.036 s
$ ffprobe -v error -show_entries format=start_time,duration reset_out.ts
start_time=1.400000        # near-zero, unlike the raw slice's 31.158
duration=10.350333
$ ffmpeg -v error -i reset_out.ts -f null -     # (no output) → clean decode, no glitch
```

Compared head-to-head with the raw byte-range slice, for the *same* requested range:

| Property | Raw byte-range slice (`dd` from `pkt_pos`) | `-ss … -to … -c copy` |
|---|---|---|
| Extraction cost | ~instant | ~0.036 s (equally I/O-bound; no re-encode) |
| Needs an ffprobe keyframe scan first | Yes (to get `pkt_pos`) | No (ffmpeg seeks to keyframe itself) |
| Keyframe-clean first frame | No — boundary decode errors | Yes — clean |
| Start timestamp | ~31 s (unresettable without a remux) | ~0 s (resets by default) |
| Self-contained / valid TS | Yes (PAT/PMT recur) | Yes |
| Bounded to the short preview range | Yes | Yes (scales with clip, not file) |

The raw slice wins on *nothing* and loses on decode cleanliness, timestamps, and needing a
separate ffprobe pass. **So "cheapness" is not the axis that separates a preview from the
real trim job** — the axis is *durability*: the real Phase 5 trim creates a persistent
**derived-recording row** (its own ID, output path, `recorded`/`failed` state, listed and
re-trimmable); a *preview* would write an **ephemeral** temp file (or stream) deleted
immediately, with none of that row machinery. That is a genuine, meaningful difference — but
it is a difference in *bookkeeping*, not in ffmpeg cost. Whether that ephemeral clip is
worth a new route at all is answered by §4/§5: probably not, because the client can already
preview with no server work.

**Key Sources:**
- [FFmpeg Wiki — Seeking: `-ss` before `-i` is fast (keyframe) input seek; `-c copy` = stream copy, no transcode](https://trac.ffmpeg.org/wiki/Seeking)
- [`docs/browser-playback-research.md` §3 — stream copy (`ffmpeg -c copy`) is I/O-bound, ~3–4% CPU, "not a bottleneck"](./browser-playback-research.md) (established in this repo already)
- Local timing evidence above (10 s range extracted in ~0.036 s, clean decode, `start_time≈0`).

---

## 4. Existing minimal tools: `mpegts.js` already does client-side keyframe seeking

### Finding: The library this app already ships does time→keyframe→byte-offset seeking itself — no server change needed for a preview

This is the most important finding, and it was under-weighted in the earlier pass, which
framed client-side scrub only as "cheap but imprecise." Reading `mpegts.js` v1.8.0 source
(already vendored at `node_modules/mpegts.js`) shows it **already implements exactly the
keyframe-byte-offset seeking the "fake preview URL" idea proposed to build server-side:**

- Its TS demuxer resyncs on the `0x47` sync byte and re-parses PAT/PMT **inline, by PID,
  wherever they recur** (`src/demux/ts-demuxer.ts`: `sync_byte !== 0x47` guard ~L276-278;
  PMT/PID handling ~L325-368), and it tracks each video keyframe via the
  `random_access_indicator` (~L298, L337, L418). This is the same "PAT/PMT recur so you can
  start mid-stream" property §2 relies on — handled for us, client-side.
- It builds a keyframe index that maps **playback time → byte position**, and seeks by
  fetching a byte range starting at the keyframe's file offset
  (`src/core/transmuxing-controller.js` L188-190):
  `getNearestKeyframe(milliseconds)` → `this._ioctl.seek(keyframe.fileposition)`.
- The range seek is wired to real HTTP range requests (`seekType: 'range'` default in
  `src/config.js`; `RangeSeekHandler` / `xhr-range-loader.js`) against the existing
  `GET /recordings/:id/file` route, which already advertises `Accept-Ranges`
  (`spec.md`: the file route has "HTTP range support … the web client's `mpegts.js` player
  range-fetch against").

**What the documented limitation actually is — and why it barely bites a scrub UX.**
This repo's resolved decision (`spec.md` "Open decisions"; the comment in
`RecordingDetail.vue` ~L144-148) is that mpegts.js cannot be *forced* to a total duration
up front — `overridedDuration`/`_updateMediaSourceDuration` only apply to FLV / a Safari
`audio/mpeg` edge case, not MPEG-TS — so **duration and forward-seek-to-an-unloaded-point**
become accurate only *progressively*, as more of the file demuxes. Crucially, that
imprecision is about *jumping ahead to a region not yet loaded*. In a **scrub-to-mark**
interaction the user sets in/out points **by navigating the player to a frame and looking
at it** — which requires that region to be demuxed, at which point mpegts.js's keyframe
index for it is exact. You cannot mark a frame you have not seen. So the accuracy hole
(typing "end = 1:59:00" on a barely-loaded 2 h file) is one a scrub UX does not walk into.

**No new dependency is warranted.** mpegts.js (already a dep) covers client-side preview;
`ffmpeg`/`ffprobe` (already present) cover the server fallback if ever needed. Nothing in
the "fake preview URL" idea requires a new MPEG-TS indexing library — and adding one would
violate this repo's stated principle ("prefer … an existing dependency's built-in
behaviour … never build generic/extensible abstractions for a single current use case",
`plan.md` Simplicity guidelines).

**Key Sources:**
- [mpegts.js repo (v1.8.0, actively maintained)](https://github.com/xqq/mpegts.js) — and the vendored source read here: `src/demux/ts-demuxer.ts`, `src/core/transmuxing-controller.js` (L188-215), `src/io/io-controller.js`, `src/io/range-seek-handler.js`, `src/config.js`.
- [`docs/browser-playback-research.md` Addendum — mpegts.js range-fetches the existing file route for seeking; iOS `ManagedMediaSource` support in v1.8.0](./browser-playback-research.md)
- `spec.md` "Open decisions" (resolved) — the exact `overridedDuration` /
  `_updateMediaSourceDuration` MPEG-TS limitation, quoted above.
- `web-client/src/views/RecordingDetail.vue` L141-158 — the current player setup and its
  duration comment.

---

## 5. Recommendation

### Verdict on the owner's "fake preview URL" question

**Feasible, but do not build it.** A raw byte-range slice of the existing `.ts` starting at
a keyframe *does* play (PAT/PMT recur, §2), and ffprobe *can* hand you the keyframe byte
offset cheaply (§1). But the approach is **strictly dominated** by `ffmpeg -ss … -to …
-c copy` (§3): same near-instant cost, but clean first frame and near-zero timestamps
instead of boundary glitches and a 31-second PTS offset — and `-c copy` doesn't even need
the separate ffprobe scan. So the "third option" collapses into the *second* option the
earlier pass already named (a disposable `-c copy` clip), just arrived at from the other
direction. There is no distinct, cheaper "byte-slice" win to be had.

### What to actually do (guidance, not implementation)

1. **Primary: client-side preview in the existing player — no backend, no new route, no new
   dependency.** In `RecordingDetail.vue`, on top of the current `mpegts.js` player, add a
   "mark in / mark out" affordance driven by the video element's `currentTime`, plus a
   play-from-in / auto-pause-at-out preview loop. mpegts.js already keyframe-seeks by byte
   offset via the existing `GET /recordings/:id/file` range route (§4), so scrubbing to and
   previewing the marked region needs nothing server-side. The marked in/out values are then
   submitted verbatim to the *real* `POST /recordings/:id/trim` (or `/split`) job Phase 5
   already defines. Because marks are set on frames the user has scrubbed to (hence demuxed),
   the documented duration/forward-seek imprecision is largely avoided; the residual coarseness
   is keyframe-granularity, which is exactly the granularity the real `-c copy` trim will cut
   at anyway — so the preview and the committed result agree.

2. **Fallback if a server-rendered preview is ever demanded:** a short-range
   `ffmpeg -ss … -to … -c copy` into an **ephemeral** temp file (or streamed response),
   deleted immediately — explicitly *not* the persistent derived-recording-row machinery of
   the real trim job, and explicitly **not** a hand-rolled byte-range slice (drop that; §3
   shows it only loses). This stays consistent with `docs/browser-playback-research.md` §4:
   serve it as a written file with range support rather than a non-seekable pipe.

3. **Safety net regardless (already free):** Phase 3 trash/restore/30-day-purge already covers
   a bad cut with zero new code — the source is never modified, so a mis-trim is trashed and
   redone. This remains the backstop the plan already recommends, and the client-side preview
   in (1) is the "optional aid for picking timestamps" the plan's own recommendation gestures
   at — now confirmed to be more precise than that recommendation assumed.

**Bottom line for the plan:** the honest answer to "can we serve a fake preview URL by
byte-slicing the existing `.ts` instead of remuxing?" is *yes but pointless* — the cheap
operation it was trying to avoid (`-c copy`) is already as cheap and strictly better, and
the truly cheapest preview needs no server at all because `mpegts.js` already does the
keyframe seeking client-side. Recommend the zero-backend client-side scrub preview, keep
trash-and-redo as the safety net, and shelve both server-side preview variants.

---

## References and Sources

- [FFprobe documentation (`-show_frames`, `-select_streams`, `-read_intervals`, `-show_entries frame=pkt_pos`)](https://ffmpeg.org/ffprobe.html)
- [FFmpeg codecs — `-skip_frame nokey` decoder option](https://ffmpeg.org/ffmpeg-codecs.html#Decoders)
- [FFmpeg Wiki — Seeking (`-ss` before `-i`; stream copy semantics)](https://trac.ffmpeg.org/wiki/Seeking)
- [FFmpeg mpegts muxer — periodic PAT/PMT (`pat_period`)](https://ffmpeg.org/ffmpeg-formats.html#mpegts-1)
- [StackOverflow — keyframe timestamps + byte positions via ffprobe](https://stackoverflow.com/questions/18085458/how-to-see-the-actual-keyframes-in-a-video)
- [MPEG transport stream (ISO/IEC 13818-1): 188-byte packets, PAT/PMT, PCR](https://en.wikipedia.org/wiki/MPEG_transport_stream)
- [Apple HLS Authoring Spec — each TS segment carries PAT/PMT to decode independently](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices)
- [mpegts.js — HTML5 MPEG-TS Stream Player (v1.8.0)](https://github.com/xqq/mpegts.js); vendored source: `src/demux/ts-demuxer.ts`, `src/core/transmuxing-controller.js`, `src/io/io-controller.js`, `src/io/range-seek-handler.js`, `src/config.js`.
- In-repo: [`docs/browser-playback-research.md`](./browser-playback-research.md) (§3 remux cost, §4 pipe vs. file range support, Addendum on mpegts.js); `spec.md` "Open decisions" (mpegts.js duration limitation) and file-route range support; `plan.md` Phase 5 (trim/split, derived-row pattern, 10–20 min padding, Simplicity guidelines); `web-client/src/views/RecordingDetail.vue` L141-158.

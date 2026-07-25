# Serving Format Research: MP4 Remux as a Replacement for mpegts.js

## Executive Summary

**Verdict: Yes — remux finished recordings to MP4 (H.264+AAC copy, `-movflags +faststart`).** This lets the app drop `mpegts.js` entirely for finished-recording playback, and since the app never plays a still-recording file (confirmed below), that covers **100% of this app's actual in-browser playback scenarios**, not just some of them.

- **Confirmed by hands-on test** (this machine, `ffmpeg 8.1.1`): remuxing a real 28 MB / 116-second `.ts` sample pulled from `sheeta` production recordings took **0.104s wall-clock at 2300x realtime speed**, produced byte-identical codecs (h264 Main profile, aac LC 44.1kHz stereo), and verified `moov`-before-`mdat` placement (faststart correctly applied).
- **Confirmed by code**: `RecordingDetail.vue`'s player (and `CutConsole.vue`'s per-piece preview player) only mount `mpegts.js`/`<video>` when `recording.status === 'recorded'` — a finished file. There is no code path anywhere in this app that attempts to play a `recording`-status (still-growing) file. The "drop mpegts.js" win is unconditional.
- **Confirmed by grep**: no existing remux/MP4 code path exists anywhere in `src/` today (`grep -rn "mp4|remux|movflags|faststart" src/` returns nothing). This is still an open gap, not something already implemented — despite `browser-playback-research.md` recommending it.
- MP4 remains the right container choice; fragmented MP4/CMAF and MKV are both worth a one-line mention but not warranted here (see §4).

---

## 1. Does this app ever need to play an in-progress recording?

**No.** Verified directly in `web-client/src/views/RecordingDetail.vue`:

```
<div v-if="recording.status === 'recorded'" class="orig" ...>
  ...
  <video v-if="useMpegts" ref="videoEl" controls class="video-player"></video>
  <video v-else ref="videoEl" :src="streamUrl" controls class="video-player"></video>
</div>
<div v-else class="player player--placeholder">
  <div class="not-ready">
    <p>Recording not ready to play yet.</p>
```

The `<video>`/mpegts.js player only mounts under `v-if="recording.status === 'recorded'"`; every other status (`scheduled`, `recording`, `muxed`, `cancelled`, `failed`, `missed`) renders the `not-ready` placeholder instead. `setupPlayer()` in the `<script setup>` block is likewise only called after `recording.value.status === "recorded"`. `CutConsole.vue`'s per-piece mpegts.js preview players operate on already-extracted cut pieces (finished files), not the live source.

**Implication:** mpegts.js's unique selling point over server-side remux — the ability to play a still-growing MPEG-TS file — is not exercised anywhere in this codebase today. There is no scenario where dropping mpegts.js in favor of a finished-file-only MP4 remux would leave any current playback path worse off.

---

## 2. Hands-on remux verification

**Setup:** copied a real production `.ts` recording from `sheeta:/srv/rec-live-tronic/recordings/rec-33c4e9e95f5c43c98c7d4a38e39cffd9.ts` (28 MB, 116s, 720p) to local scratch space (not modified in place). Confirmed source codecs via `ffprobe`:

```
Stream #0:0: Video: h264 (Main), yuv420p, 1280x720, 30 fps
Stream #0:1: Audio: aac (LC), 44100 Hz, stereo, 130 kb/s
```

**Command run:**

```
$ time ffmpeg -y -i sample.ts -c copy -movflags +faststart output.mp4
```

**Real output (verbatim, trimmed to the relevant lines):**

```
Input #0, mpegts, from 'sample.ts':
  Duration: 00:01:56.00, start: 1.403178, bitrate: 2039 kb/s
  Stream #0:0[0x100]: Video: h264 (Main), yuv420p(tv, bt709, progressive), 1280x720 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 90k tbn
  Stream #0:1[0x101]: Audio: aac (LC), 44100 Hz, stereo, fltp, 130 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (copy)
  Stream #0:1 -> #0:1 (copy)
Output #0, mp4, to 'output.mp4':
  Stream #0:0: Video: h264 (Main) (avc1 / 0x31637661), yuv420p, 1280x720, 30 fps
  Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 130 kb/s
[mp4 @ 0x1458064e0] Starting second pass: moving the moov atom to the beginning of the file
[out#0/mp4] video:25522KiB audio:1846KiB ... muxing overhead: 0.243211%
frame= 3480 fps=0.0 q=-1.0 Lsize=27435KiB time=00:01:56.00 bitrate=1937.5kbits/s speed=2.3e+03x elapsed=0:00:00.05

real  0m0.104s
user  0m0.077s
sys   0m0.033s
```

**No errors.** `speed=2.3e+03x` (2300x realtime) and `0.104s` wall time for a nearly 2-minute recording — this is I/O-bound container repackaging, not proportional to a re-encode's cost (a real re-encode of this size/duration would run at roughly realtime or slower, i.e. ~100s+, not 0.1s).

**Output verification (`ffprobe output.mp4`):**

```
[STREAM] codec_name=h264, profile=Main, 1280x720
[STREAM] codec_name=aac, profile=LC, 44100 Hz, stereo
[FORMAT] duration=116.003673, size=28093205
```

Codecs identical to source, duration preserved exactly. Checked the first 200 bytes of `output.mp4` directly — `ftyp` box immediately followed by `moov` (not `mdat`), confirming `+faststart` correctly relocated the index to the front of the file, which is what makes the file both progressively playable and immediately range-request-seekable without a second network round-trip to fetch a trailing `moov`.

(Sample and output files were scratch-only, not left in the repo or on the production host.)

---

## 3. Browser support for MP4 (H.264+AAC) via plain `<video>` — verified

Unlike raw `.ts` (established as broken in `browser-playback-research.md` §1), MP4 with H.264 video + AAC audio is universally and natively supported by a plain `<video src>` with no JS library, across all four target platforms:

- H.264 has dedicated hardware decode paths on iOS and Android, and MP4/H.264/AAC plays natively via `<video>` in Chrome, Firefox, Safari, and Edge, desktop and mobile alike — this is the most broadly-compatible combination in the web video ecosystem (MDN Web video codec guide; BrowserStack HTML5 codec guide; caniuse `mpeg4`).
- `-movflags +faststart` (moving the `moov` atom before `mdat`) is what makes an MP4 both instantly startable and properly range-seekable over plain HTTP — the browser reads the index up front and issues `Range` requests to jump to arbitrary byte offsets, which is exactly what `Express`'s `sendFile()` (already used for the current `.ts` route) natively supports for a static file.

**No JS transmuxing library is needed for any of these four platforms once the file is MP4/H.264/AAC with faststart.**

**Key sources:**
- [MDN — Web video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)
- [BrowserStack — Complete Guide to HTML5 Codecs](https://www.browserstack.com/guide/html5-codec)
- [caniuse — MPEG-4/H.264 video format](https://caniuse.com/mpeg4)
- [mpegflow — MP4 faststart: moov at front, why it matters](https://www.mpegflow.com/topics/containers/mp4-faststart)

---

## 4. Container choice: MP4 vs. alternatives (brief)

- **MP4 (H.264+AAC, faststart) — recommended, no change from `browser-playback-research.md`'s original call.** Best native `<video>` compatibility of any container across all four platforms; remux is a pure stream-copy; works for both playback and download.
- **Fragmented MP4 (fMP4)/CMAF — not warranted.** fMP4 exists to support adaptive bitrate streaming (DASH/HLS-over-fMP4) and MSE-based players — neither applies here (single fixed-quality file, no adaptive renditions, and the whole point of this change is to *stop* needing an MSE-based JS player). Plain progressive MP4 is simpler and sufficient.
- **Matroska (MKV) — ruled out.** Same codecs, zero-cost remux target in principle, but has no meaningful native `<video src>` support in any of the four target browsers (all four would silently fail or prompt a download, the same failure mode `.ts` has today). No benefit over MP4 for this app's actual requirement (native playback).

---

## 5. Does an MP4 remux already exist in this codebase?

**No.** `grep -rn "mp4\|remux\|movflags\|faststart" src/ -i` returns zero matches anywhere in the backend. `RecordingDetail.vue`'s `streamUrl` still points at `GET /recordings/:id/file`, which — per the repository's route naming and the `.ts`-only file layout observed on `sheeta` (`rec-<id>.ts` next to `rec-<id>.log`, no `.mp4` siblings) — serves the raw `.ts` file. This confirms `browser-playback-research.md`'s recommendation was never implemented; the client's only playback path for a raw `.ts` today is `mpegts.js`. This is an open gap, not a regression.

---

## 6. Timing/caching tradeoffs (options only, no recommendation)

Given how cheap the remux proved to be (0.104s for a 2-minute file; scales roughly linearly with duration since it's I/O-bound, not CPU-bound), three shapes are possible for *when* the MP4 gets produced:

1. **Eager, at capture-finish.** Remux immediately when a recording transitions to `recorded` (or a new `muxed` status, already present as a placeholder value in `RecordingDetail.vue`'s `formatStatus` map). Upside: MP4 is always ready by the time anyone opens the detail page. Downside: doubles on-disk storage for every recording, including ones nobody ever plays back.
2. **Lazy, on first request, cached to disk.** Remux only when `GET /recordings/:id/file` (or a new `.mp4`-specific route) is first requested for a `recorded` file with no `.mp4` sibling yet; write the result once, serve it (and all future requests) from disk after that. Upside: no wasted disk/CPU for recordings never viewed. Downside: first viewer pays a one-time latency hit (proportional to file size — likely sub-second to a few seconds even for multi-GB files, per the near-zero CPU cost measured above, but still a synchronous wait unless handled asynchronously).
3. **Remux on every request, never cached.** Given the demonstrated cost (2300x realtime, sub-100ms per ~2 minutes of footage) this is likely cheap enough to *work*, but wastes CPU and I/O repeatedly for a deterministic, idempotent operation with no reason to redo it — probably worth ruling out on cleanliness grounds alone, independent of whether the cost is trivial.

No decision is made here; this is scoping context for whoever picks an approach later.

---

## References and Sources

- [MDN — Web video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)
- [BrowserStack — Complete Guide to HTML5 Codecs for Audio and Video Playback](https://www.browserstack.com/guide/html5-codec)
- [caniuse — MPEG-4/H.264 video format](https://caniuse.com/mpeg4)
- [mpegflow — MP4 faststart: moov at front, why it matters, and how to set it](https://www.mpegflow.com/topics/containers/mp4-faststart)
- Hands-on verification: `ffmpeg 8.1.1` / `ffprobe` run locally against a real production `.ts` recording copied from `sheeta:/srv/rec-live-tronic/recordings/` (this document, §2)
- `web-client/src/views/RecordingDetail.vue` and `web-client/src/components/CutConsole.vue` (this repo) — confirms the `recorded`-status gating referenced in §1
- Builds on `docs/browser-playback-research.md` (this repo) — §§1–5 there remain the source of truth for the base MPEG-TS/browser-incompatibility and remux-mechanics findings; not repeated here

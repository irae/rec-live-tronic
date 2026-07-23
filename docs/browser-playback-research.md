# Browser Playback Research: MPEG-TS and Remuxing Strategy

## Executive Summary

This document investigates whether raw MPEG-TS (MPEG-2 Transport Stream) files—as currently captured by streamlink into `.ts` format—can be reliably played in modern browsers via plain HTML5 `<video>` elements, and whether a lightweight, non-re-encoding remux to MP4 or Matroska is a viable solution.

**Verdict — CORRECTED (see note below):** No current major browser natively plays a raw, standalone `.ts` file given directly as a `<video src>`. This is not a Firefox-only gap; it affects Chrome, Edge, and Safari too. A lightweight remux to MP4 (using `ffmpeg -c copy`) is **technically sound, performant, and reliable**, and is not optional polish — it's required for the existing `RecordingDetail.vue` `<video :src="streamUrl">` player to work at all for any user. Piped remux with HTTP range-request support is **not practical** (see §4); a **post-capture remux (write to file, serve the result)** is the only viable approach and aligns with the existing Phase 3 plan.

> **Correction note:** the original draft of this document claimed Chrome, Edge, and Safari have "native MPEG-TS support" for a plain `<video src="file.ts">`, based on sources that actually describe MSE-based demuxing (via a JS library doing the work, e.g. `mpegts.js`/`hls.js`) or genuine HLS `.m3u8`-playlist support — neither of which is what this app currently does (`RecordingDetail.vue` passes the raw `.ts` file straight to `<video src>`, no JS library, no playlist). This was caught and corrected by the orchestrator via direct verification before this document was committed. See the corrected table and sources below.

---

## 1. Native `.ts` (MPEG-TS) Playback Support in Modern Browsers

### Finding: No major browser natively plays a standalone `.ts` file via `<video src>`

| Browser | Plays a raw standalone `.ts` via `<video src>`? | What actually works instead |
|---------|---------|-------|
| **Chrome / Edge** (Chromium) | ❌ No — navigating to a `.ts` URL triggers a **download**, not playback | Chromium's HLS demuxer (landing around Chrome 142) handles `.m3u8` **playlists**, not a bare `.ts` file. Raw MPEG-TS playback still requires a JS library (`mpegts.js`/`hls.js`) doing MSE-based transmuxing to fragmented MP4 client-side. |
| **Safari** | ❌ No — a single `.ts` file has no playlist context, so Safari's `<video>` element can't play it standalone | Safari's genuine native strength is HLS **playlists** (`.m3u8` referencing `.ts` segments) — a materially different thing from a single, playlist-less `.ts` file. |
| **Firefox** | ❌ No | No native MPEG-TS/HLS support at all; only MP4 and WebM via MSE. |

**Practical implication for this app specifically:** `RecordingDetail.vue`'s `<video :src="streamUrl">` (where `streamUrl` is the raw `GET /recordings/:id/file` `.ts` URL, no JS transmuxing library, no `.m3u8` playlist) is very likely **not functional video playback in any current browser today** — at best it may show a blank/broken player, or the browser may attempt to download the file instead of playing it. This should be verified hands-on (actually pressing play and confirming decoded frames render, not just that the `<video>` element and its controls appear on the page) as a priority, since prior manual smoke testing only confirmed the player *element* rendered, not that video actually played.

**Key Sources:**
- [Chromium HLS demuxer support, Chrome 142](https://www.testmuai.com/learning-hub/hls-browser-support/) — confirms Chromium's native HLS handling is for `.m3u8` playlists, not raw `.ts`.
- [Chromium developer group thread on enabling single-.ts playback](https://groups.google.com/a/chromium.org/g/chromium-dev/c/1tBgPWRGKgw) — confirms a bare `.ts` file is not natively playable in Chromium without extra work.
- [mpegts.js](https://github.com/xqq/mpegts.js) / [hls.js](https://github.com/video-dev/hls.js) — both exist specifically because browsers need a JS library to transmux MPEG-TS to fragmented MP4 via MSE; their existence is itself evidence there's no native path.
- Apple Developer Forums discussion confirming a standalone `.ts` file (no `.m3u8`) is not reliably played by Safari/AVPlayer-based clients.
- [Firefox Bug 1672109](https://bugzilla.mozilla.org/show_bug.cgi?id=1672109) — confirms Firefox lacks MSE support for MPEG-TS, only MP4 and WebM.

### Practical Implication

**Direct `.ts` playback does not work natively in any of the four major browsers.** A remux to MP4 (§2–3) is the fix, and per §4, it must be a file written to disk (not piped) to preserve HTTP range-request support for both browser seeking and VLC's *Open Network Stream*.

---

## 2. Codecs Used by Streamlink When Capturing YouTube Live Streams

### Finding: H.264 + AAC — Already Browser-Compatible

**Streamlink's Codec Approach:**

Streamlink **does not re-encode** streams. According to the maintainer discussion on [GitHub discussion #4489](https://github.com/streamlink/streamlink/discussions/4489):

> "Streamlink doesn't re-encode video/audio streams. Streams will at most get re-muxed, depending on the stream type or options passed. Most video streams however already are h264, so you don't have to re-encode anything."

**YouTube Live HLS Streams:**

YouTube publishes live streams via HLS, which uses H.264 video and AAC audio codecs. The [Dacast blog on streaming codecs (2025)](https://www.dacast.com/blog/codec-basics-for-online-video-audio-and-live-streaming/) and [YouTube's HLS ingestion guide](https://developers.google.com/youtube/v3/live/guides/hls-ingestion) confirm:

- H.264 (AVC) is the primary video codec for YouTube HLS.
- AAC-LC is the standard audio codec.

**Container Reality:**

When streamlink captures a YouTube HLS stream with `--stdout`, the output is a single MPEG-TS file concatenating all HLS segments (which are themselves MPEG-TS chunks). The **bitstream data (H.264 + AAC) is unchanged** — only the container format differs.

### Critical Implication

**The codecs are already browser-native in other containers.** H.264 video and AAC audio are natively supported by all modern browsers when packaged in MP4 or WebM containers. The only problem is the **MPEG-TS container wrapper**, not the codec data inside it.

This means:
- **No re-encoding needed.** A remux from MPEG-TS to MP4 simply repackages the same H.264 + AAC bitstream.
- **Zero quality loss.** Stream copy (`ffmpeg -c copy`) preserves the exact video and audio quality.
- **Very fast operation.** Since no decoding or encoding occurs, processing is I/O-bound, not CPU-bound.

---

## 3. Lightweight Remux (ffmpeg -c copy) — CPU Cost and Reliability

### Finding: Extremely Cheap and Widely Proven

**Performance Data:**

Real-world measurements from [FFmpeg-Cookbook](https://ffmpeg-cookbook.com/en/articles/ffmpeg-copy-codec-vs-reencode/) and GitHub discussions show:

| Scenario | CPU Usage | Notes |
|----------|-----------|-------|
| MPEG-TS → MP4 copy (1080p) | 3–4% | Changing container only; no decode/encode |
| Raspberry Pi Zero (1080p) | <10% | Low-power systems handle it fine |
| Audio-only re-encode vs. `-c:a copy` | 85% → 18% | Dramatic reduction when switching to copy |

**Processing Time:**

Remuxing a typical YouTube live-stream capture (1–4 hours, 1–3 GB) to MP4 takes **a few seconds to a few minutes**, depending on disk I/O speed. For example, a 2 GB `.ts` file typically remuxes in under 30 seconds on a standard SSD.

**Reliability:**

Remuxing with `ffmpeg -c copy` is extremely stable and has been used in production by:
- Jellyfin (open-source media server) for DVR/live TV remuxing.
- Plex for on-the-fly transcoding fallback (remux as a cheaper alternative to full transcode).
- OBS Studio for post-capture remuxing MP4 files.

There are no known inherent stability issues; failures are typically disk-space or I/O errors, not codec/mux problems.

**Key Sources:**
- [FFmpeg-Cookbook on copy vs. re-encode](https://ffmpeg-cookbook.com/en/articles/ffmpeg-copy-codec-vs-reencode/)
- [Jellyfin live TV remuxing discussion](https://forum.jellyfin.org/t-any-way-to-remux-livetv-encoding-from-ts-to-mkv-in-realtime-for-dvr/) and [GitHub issues](https://github.com/jellyfin/jellyfin-androidtv/issues/2568)
- OBS Forum discussions on post-capture remuxing

### Conclusion on Remux Cost

**Remuxing is cheap enough that it's not a bottleneck.** The operation is so light that it can be done on commodity hardware (even Raspberry Pi) without any performance concern. The real question is not "is it affordable?" but "where in the pipeline does it fit?" (see Question 4 and 5).

---

## 4. HTTP Range Requests and Piped vs. Cached Remux

### Finding: Piped Remux Cannot Support HTTP Range Requests

**The Core Issue:**

HTTP range requests (used by browsers for seeking, and required by VLC's *Open Network Stream*) depend on:
1. A known `Content-Length` for the full resource.
2. The ability to respond to a `Range: bytes=start-end` request with a `206 Partial Content` response.
3. **Seekable output** — the server must be able to jump to an arbitrary byte position and read from there.

**FFmpeg Pipe Protocol:**

According to the [FFmpeg protocols documentation](https://ffmpeg.org/ffmpeg-protocols.html):

> "Note that some formats (typically MOV), require the output protocol to be seekable, so they will fail with the pipe output protocol."

The pipe protocol is **inherently non-seekable**. FFmpeg cannot seek within a pipe because a pipe, by definition, is a unidirectional stream with no random-access capability. You can only read/write sequentially from the current position.

**Practical Implication:**

If you spawn an `ffmpeg` process on-the-fly to remux a `.ts` file and pipe the output to an HTTP response body:

```bash
ffmpeg -i input.ts -c copy -f mp4 pipe:1 | send_over_http
```

The HTTP client **cannot seek within this stream**. Attempting a `Range` request will fail or be silently ignored because:
- The server doesn't know the final size (it's being generated on the fly).
- It cannot jump to an arbitrary position in a live pipe.
- VLC's `Open Network Stream` expects `Accept-Ranges: bytes` and proper `Content-Range` headers — both impossible with a non-seekable pipe.

**Cached (File-Based) Remux:**

If you instead:
1. Remux once to a file on disk: `ffmpeg -i input.ts -c copy output.mp4`
2. Then serve the `.mp4` file via Express's `sendFile()` (as the current Phase 1 code does for `.ts`):

The file is fully seekable, Express's `sendFile()` adds proper `Accept-Ranges` and `Content-Range` headers, and HTTP range requests work perfectly. VLC's *Open Network Stream* can seek without issues.

**Key Sources:**
- [FFmpeg protocols documentation](https://ffmpeg.org/ffmpeg-protocols.html)
- [Surma's blog on range requests and video](https://surma.dev/things/range-requests/) — explains how browsers use range requests for seeking.
- [BigBinary blog on MP4 transmuxing and range request headers](https://www.bigbinary.com/blog/mp4_transmuxing_and_streaming_support-loom-alternative-part-3)

### Verdict on Remux Strategy

**Piped remux is not viable if HTTP range-request support is required.** The existing Phase 1 implementation uses `response.sendFile()` with range support — this constraint rules out on-the-fly remux.

**Cached remux (write to file, then serve) is the only practical approach.** This is already how Jellyfin, Plex, and other DVR systems handle MPEG-TS → MP4 remuxing for streaming.

---

## 5. Remuxing Finished vs. In-Progress Files

### Finding: Remux Should Only Apply to Finished Recordings

**In-Progress Files Are Problematic:**

FFmpeg was not designed to handle files that are actively being written to. According to [FFmpeg user discussions on growing files](https://libav-user.ffmpeg.narkive.com/X4EHHtnx/growing-memory-when-writing-live-source-to-mpeg4-file-cont-from-ffmpeg-dev):

1. **Container Index Issue:** MP4 and MOV containers store an index (moov atom) that describes all samples in the file. This index **must be written at the end of the file**, meaning it must be kept in memory as the file grows. As more frames are added, memory usage grows unbounded.

2. **Seeking Problem:** FFmpeg doesn't dynamically update a source's known size and seek position while reading from a growing file. Reading from a partially-written file can succeed, but seeking within it is unreliable.

3. **MPEG-TS Exception:** MPEG-TS files **do not require an index** and can be safely appended to even while being read — this is why streamlink uses MPEG-TS in the first place (append-safe, killable mid-write, still playable).

**Industry Practice:**

Checking Jellyfin, Plex, and other DVR systems:
- **Jellyfin** [remuxes live TV recordings only after capture completes](https://github.com/jellyfin/jellyfin-androidtv/issues/2568).
- **Plex** buffers the live stream, then triggers remux after recording stops.
- **OBS** remuxes only post-recording; it does not attempt live remux of growing files.

**Alignment with Spec and Phase 3 Plan:**

The existing `spec.md` and `plan.md` already specify:

> "Remux/demux to a final container ... publishing `final_path` only on atomic success ... Muxed `final_path` files are served through the existing Phase 1 `GET /recordings/:id/file` route."

The plan treats remux as a **post-capture, bounded operation** on a **finished file** — not a live, growing operation. This is the correct design.

**Key Sources:**
- [OBS forum on remuxing incomplete files](https://obsproject.com/forum/threads/why-doesn%E2%80%99t-automatic-remux-to-mp4-work-with-custom-output-ffmpeg.183175/)
- [FFmpeg discussion on growing MPEG4 files](https://libav-user.ffmpeg.narkive.com/X4EHHtnx/growing-memory-when-writing-live-source-to-mpeg4-file-cont-from-ffmpeg-dev)
- [Jellyfin live TV thread](https://forum.jellyfin.org/t-any-way-to-remux-livetv-encoding-from-ts-to-mkv-in-realtime-for-dvr/)

### Verdict on Finished vs. In-Progress

**Remux only after capture completes.** Attempting to remux a growing file is unreliable and defeats the purpose of using MPEG-TS (which is append-safe). The Phase 3 plan is correct to scope remux as a post-recording operation.

---

## Recommendation

### Is Remuxing Worth Doing?

**Yes, but with clear scope.**

**Benefits:**
1. **Universal browser playback — this is likely a currently-broken core feature, not a gap.** MP4 is natively playable in all modern browsers (Chrome, Firefox, Safari, Edge) via the `<video>` element. Per the corrected §1 findings, the raw `.ts` file the app serves today is very likely **not playable in any browser** via the current plain `<video :src>` implementation — this isn't "Firefox users miss out," it's "verify whether this feature works for anyone right now."
2. **Zero CPU cost.** Stream copy (`ffmpeg -c copy`) uses 3–4% CPU on a 1080p file; it's negligible.
3. **Proven at scale.** Jellyfin, Plex, and other DVR systems do this routinely with no issues.
4. **Resolves Phase 3 open decision.** The spec lists "mkv vs. mp4" as an open decision for the final container — MP4 with stream copy is the natural answer once this research confirms codec compatibility.

**Constraints:**
1. **File-based only.** Remux must happen after recording finishes, not during. This is already how Phase 3 is planned.
2. **No on-the-fly remux for seeking.** Piping remuxed output to an HTTP response cannot support range requests; the only way to support VLC's *Open Network Stream* and browser seeking is to write the remuxed file to disk first.
3. **Adds a post-processing step.** The reconciler or a separate worker will need to remux finished recordings. The existing Phase 3 plan already accounts for this with "transcode/remux worker ... systemd units, concurrency-capped."

### Scope and Feasibility

**This is a small, well-scoped implementation task.**

**Why:**
- The codecs are already browser-compatible (H.264 + AAC, no re-encoding needed).
- The remux operation is simple (`ffmpeg -c copy -i input.ts output.mp4`) and performant.
- The infrastructure (systemd transient units, post-capture job scheduling) already exists in Phase 0/1.
- The decision (MP4 vs. MKV) can be resolved: **MP4 is the better default** because it's more universally supported for streaming (all browsers play MP4; not all browsers or older VLC versions play MKV reliably).
- Testing is straightforward: capture a `.ts` file, remux it, verify it plays in all browsers and VLC.

**Implementation Shape:**
1. Add a remux job to the reconciler (after a recording transitions to `recorded` status).
2. Spawn an `ffmpeg -i input.ts -c copy -f mp4 output.mp4` process as a systemd transient unit or a simple tracked async job.
3. Update the `GET /recordings/:id/file` route to serve the `.mp4` if it exists, falling back to `.ts` if not yet remuxed.
4. Optional: add a remux status field to the schema (e.g., `muxed` status, parallel to `recorded`).

None of this requires new dependencies, complex orchestration, or risky refactoring.

### Recommendation: Proceed with Phase 3 Remux as Planned

**Go ahead with Phase 3 remux implementation.** This research confirms that:
- The problem (browser playback of `.ts` files) is real and worth solving.
- The solution (lightweight stream-copy remux to MP4) is cheap, proven, and low-risk.
- The scope is narrow and aligns with the existing plan.
- The open decision (mkv vs. mp4) should resolve to **MP4** for maximum browser and player compatibility.

This is not a marginal improvement or premature optimization — per the corrected §1 findings, it's very likely a **fix for a currently-broken core feature** (in-browser playback), not just a Firefox-specific edge case. Recommend verifying hands-on (in an actual Chrome/Safari session against a real recording) whether playback currently works at all, before treating this as lower priority than other polish items.

---

## References and Sources

- [Chromium dev group — enabling single-.ts playback in Chromium](https://groups.google.com/a/chromium.org/g/chromium-dev/c/1tBgPWRGKgw) — confirms no native path for a bare `.ts` file.
- [TestMu AI — HLS Browser Support, Codecs, Known Issues](https://www.testmuai.com/learning-hub/hls-browser-support/) — Chromium's HLS demuxer (Chrome 142+) is for `.m3u8` playlists, not raw `.ts`.
- [Firefox Bug 1672109 — MPEG-TS Support](https://bugzilla.mozilla.org/show_bug.cgi?id=1672109)
- [mpegts.js — HTML5 MPEG-TS Stream Player](https://github.com/xqq/mpegts.js)
- [Bitmovin — Container Formats Blog](https://bitmovin.com/blog/fun-with-container-formats-3/)
- [Streamlink GitHub Discussion #4489 — Codec Handling](https://github.com/streamlink/streamlink/discussions/4489)
- [Dacast — Streaming Codecs (2025)](https://www.dacast.com/blog/codec-basics-for-online-video-audio-and-live-streaming/)
- [YouTube HLS Ingestion Guide](https://developers.google.com/youtube/v3/live/guides/hls-ingestion)
- [FFmpeg-Cookbook — Copy vs. Re-encode](https://ffmpeg-cookbook.com/en/articles/ffmpeg-copy-codec-vs-reencode/)
- [FFmpeg Protocols Documentation](https://ffmpeg.org/ffmpeg-protocols.html)
- [Surma — Range Requests and Video](https://surma.dev/things/range-requests/)
- [BigBinary — MP4 Transmuxing and Range Requests](https://www.bigbinary.com/blog/mp4_transmuxing_and_streaming_support-loom-alternative-part-3)
- [Jellyfin Live TV Remuxing Discussion](https://forum.jellyfin.org/t-any-way-to-remux-livetv-encoding-from-ts-to-mkv-in-realtime-for-dvr/)
- [Jellyfin Android TV — Live TV Transcoding Issues](https://github.com/jellyfin/jellyfin-androidtv/issues/2568)
- [OBS Forum — Post-Capture Remuxing](https://obsproject.com/forum/threads/why-doesn%E2%80%99t-automatic-remux-to-mp4-work-with-custom-output-ffmpeg.183175/)
- [FFmpeg User Discussion — Growing Files](https://libav-user.ffmpeg.narkive.com/X4EHHtnx/growing-memory-when-writing-live-source-to-mpeg4-file-cont-from-ffmpeg-dev)
- [Streamlink GitHub Issue #2935 — HLS Live Restart](https://github.com/streamlink/streamlink/issues/2935)
- [Streamlink Documentation — CLI](https://streamlink.github.io/cli.html)

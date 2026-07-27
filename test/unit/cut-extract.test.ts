import t from "tap";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtractArgv, extractSegment, pickKeyframeAtOrBefore } from "../../src/api/cut-extract.js";

const execFileAsync = promisify(execFile);

const ffmpegBin = process.env.REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.REC_LIVE_TEST_FFPROBE_BIN ?? "ffprobe";

async function streamDuration(path: string, kind: "v" | "a"): Promise<number> {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v", "error", "-select_streams", kind,
    "-show_entries", "stream=duration", "-of", "csv=p=0", path,
  ]);
  return Number.parseFloat(stdout.trim());
}

t.test("buildExtractArgv preserves source PTS gaps (copyts) while re-basing the seek to output zero", (t) => {
  const argv = buildExtractArgv("/source/path.ts", { start: 5, end: 15 }, "/output/piece-0.mp4.tmp");
  t.same(argv, [
    "-y",
    "-loglevel",
    "error",
    "-copyts",
    "-start_at_zero",
    "-ss",
    "0:00:05",
    "-t",
    "0:00:10",
    "-i",
    "/source/path.ts",
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-output_ts_offset",
    "-0:00:05",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "/output/piece-0.mp4.tmp",
  ]);
  t.end();
});

t.test("pickKeyframeAtOrBefore", (t) => {
  t.test("picks the closest keyframe at or before the target, from raw container-timebase pts", (t) => {
    const csv = "20807.564622\n20812.564622\n20817.564622\n20822.564622\n";
    t.equal(pickKeyframeAtOrBefore(csv, 20807.564622, 12), 10);
    t.end();
  });

  t.test("never picks a keyframe after the target", (t) => {
    const csv = "0\n5\n10\n";
    t.equal(pickKeyframeAtOrBefore(csv, 0, 7), 5);
    t.end();
  });

  t.test("returns undefined when every keyframe in the window is after the target", (t) => {
    const csv = "10\n15\n";
    t.equal(pickKeyframeAtOrBefore(csv, 0, 5), undefined);
    t.end();
  });

  t.test("returns undefined for empty or unparseable input", (t) => {
    t.equal(pickKeyframeAtOrBefore("", 0, 5), undefined);
    t.equal(pickKeyframeAtOrBefore("\n\n", 0, 5), undefined);
    t.end();
  });

  t.test("tolerates an exact match at the target", (t) => {
    const csv = "0\n5\n10\n";
    t.equal(pickKeyframeAtOrBefore(csv, 0, 10), 10);
    t.end();
  });

  t.end();
});

t.test("extractSegment writes a real, non-empty file to a .tmp-suffixed output path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-cut-extract-"));
  const sourcePath = join(root, "source.ts");
  const outputPath = join(root, "piece-0.mp4.tmp");
  try {
    // Synthesize a tiny real MPEG-TS source (2s, 1 keyframe) so this test
    // exercises real ffmpeg muxer/format detection, not a stub -- the
    // functional suite's ffmpeg stub is what let this regression through:
    // it never actually invokes ffmpeg's output-format auto-detection.
    await execFileAsync(ffmpegBin, [
      "-y", "-f", "lavfi", "-i", "testsrc2=duration=2:size=64x64:rate=10",
      "-f", "lavfi", "-i", "anullsrc=duration=2",
      "-c:v", "libx264", "-c:a", "aac", "-f", "mpegts", sourcePath,
    ]);

    await extractSegment(ffmpegBin, sourcePath, { start: 0, end: 1 }, outputPath);

    const output = await stat(outputPath);
    t.ok(output.isFile(), "output file exists");
    t.ok(output.size > 0, "output file is non-empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

t.test("extractSegment keeps audio and video aligned across a source video PTS gap (no A/V desync)", async (t) => {
  // Real streamlink HLS captures contain video stalls -- stretches where the
  // video PTS jumps forward tens of seconds while audio keeps flowing. Under a
  // naive `-c copy` extraction ffmpeg's mpegts discontinuity handling collapses
  // those gaps out of the video timeline (but not audio), so the piece's video
  // runs progressively ahead of its audio. This fixture reproduces that: video
  // frames from t=20..60 are dropped (a 40s gap, past ffmpeg's discontinuity
  // threshold) while audio stays continuous for the full 90s. Before the
  // -copyts fix the extracted video stream was ~50s against a ~90s audio stream.
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-cut-extract-sync-"));
  const sourcePath = join(root, "source.ts");
  const outputPath = join(root, "piece-0.mp4.tmp");
  try {
    await execFileAsync(ffmpegBin, [
      "-y",
      "-f", "lavfi", "-i", "testsrc2=duration=90:size=64x64:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=90",
      "-vf", "select='if(between(t,20,60),0,1)'", "-fps_mode", "passthrough",
      "-c:v", "libx264", "-g", "30", "-c:a", "aac", "-f", "mpegts", sourcePath,
    ]);

    await extractSegment(ffmpegBin, sourcePath, { start: 0, end: 90 }, outputPath);

    const videoDuration = await streamDuration(outputPath, "v");
    const audioDuration = await streamDuration(outputPath, "a");
    t.ok(Number.isFinite(videoDuration) && videoDuration > 0, "output has a video stream");
    t.ok(Number.isFinite(audioDuration) && audioDuration > 0, "output has an audio stream");
    // Under the old `-c copy` extraction these diverged by ~40s (the collapsed
    // gap). The fix keeps the gap in the video timeline so both streams span the
    // same duration; 3s tolerance absorbs container/codec framing slack.
    t.ok(Math.abs(videoDuration - audioDuration) < 3, `video (${videoDuration}s) and audio (${audioDuration}s) stay aligned`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

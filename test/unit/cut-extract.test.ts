import t from "tap";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExtractArgv, extractSegment, pickKeyframeAtOrBefore } from "../../src/api/cut-extract.js";

const execFileAsync = promisify(execFile);

const ffmpegBin = process.env.REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg";

t.test("buildExtractArgv emits copy, faststart, explicit mp4 format, and suppressed loglevel", (t) => {
  const argv = buildExtractArgv("/source/path.ts", { start: 5, end: 15 }, "/output/piece-0.mp4.tmp");
  t.same(argv, [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "0:00:05",
    "-i",
    "/source/path.ts",
    "-t",
    "0:00:10",
    "-c",
    "copy",
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

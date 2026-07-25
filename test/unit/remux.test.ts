import t from "tap";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRemuxArgv, remuxToMp4 } from "../../src/api/remux.js";

const execFileAsync = promisify(execFile);

const ffmpegBin = process.env.REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg";
const ffprobeBin = process.env.REC_LIVE_TEST_FFPROBE_BIN ?? "ffprobe";

t.test("buildRemuxArgv emits copy, faststart, explicit mp4 format, and the tmp-safe output path", (t) => {
  const argv = buildRemuxArgv("/source/path.ts", "/output/path.mp4.tmp");
  t.same(argv, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    "/source/path.ts",
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    "/output/path.mp4.tmp",
  ]);
  t.end();
});

t.test("remuxToMp4 produces a verified mp4 from a real .ts and removes the .tmp", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-remux-"));
  const sourcePath = join(root, "source.ts");
  const outputPath = join(root, "output.mp4");
  try {
    // Synthesize a tiny real MPEG-TS source (2s, video + audio) so this test
    // exercises real ffmpeg muxer/format detection and verification
    await execFileAsync(ffmpegBin, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=2:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-f",
      "mpegts",
      sourcePath,
    ]);

    // Remux to MP4
    await remuxToMp4(ffmpegBin, ffprobeBin, sourcePath, outputPath);

    // Verify output file exists and has content
    const output = await stat(outputPath);
    t.ok(output.isFile(), "output .mp4 file exists");
    t.ok(output.size > 0, "output .mp4 file is non-empty");

    // Verify temporary file was cleaned up
    t.rejects(stat(join(root, "output.mp4.tmp")), "temporary .tmp file does not exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

t.test("remuxToMp4 rejects and leaves no output when verification fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-remux-fail-"));
  const sourcePath = join(root, "source.ts");
  const outputPath = join(root, "output.mp4");
  const failingFfprobe = join(root, "ffprobe-stub");

  try {
    // Synthesize a tiny real MPEG-TS source
    await execFileAsync(ffmpegBin, [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=2:size=64x64:rate=10",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-f",
      "mpegts",
      sourcePath,
    ]);

    // Create a stub ffprobe that always exits with error
    await writeFile(failingFfprobe, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await chmod(failingFfprobe, 0o755);

    // Attempt remux with failing ffprobe
    await t.rejects(remuxToMp4(ffmpegBin, failingFfprobe, sourcePath, outputPath), "remux rejects when verification fails");

    // Verify output .mp4 does not exist
    t.rejects(stat(outputPath), "final .mp4 file does not exist");

    // Verify temporary file was cleaned up
    t.rejects(stat(join(root, "output.mp4.tmp")), "temporary .tmp file does not exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

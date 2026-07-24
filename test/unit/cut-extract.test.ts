import t from "tap";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSegment } from "../../src/api/cut-extract.js";

const execFileAsync = promisify(execFile);

const ffmpegBin = process.env.REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg";

t.test("extractSegment writes a real, non-empty file to a .tmp-suffixed output path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-cut-extract-"));
  const sourcePath = join(root, "source.ts");
  const outputPath = join(root, "piece-0.ts.tmp");
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

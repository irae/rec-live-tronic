import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatOffset } from "../recordings/cut-offsets.js";

const execFileAsync = promisify(execFile);

export interface CutSegment {
  start: number;
  end: number;
}

// -ss before -i gives ffmpeg's fast keyframe seek. With -ss as an input
// option, ffmpeg resets output timestamps to start at 0 at the seek point,
// so -to is measured from that reset zero -- not from the source's original
// timeline (verified empirically against ffmpeg 8.1.1: `-ss 10 -to 20`
// produced a ~20s, not ~10s, output). -t <duration> sidesteps that reset
// entirely and was verified to produce the correct segment length. Offsets
// are argv entries only -- never interpolated into a shell string --
// mirroring streamlink-command.ts.
// -f mpegts is required, not cosmetic: without it ffmpeg picks the output
// muxer from the output filename's extension, and the working ".ts.tmp"
// name (written before an atomic rename to the final ".ts" path) has no
// extension ffmpeg recognizes, so it refuses to open the output at all
// ("Unable to choose an output format" / "Invalid argument").
export function buildExtractArgv(sourcePath: string, segment: CutSegment, outputPath: string): string[] {
  return ["-y", "-ss", formatOffset(segment.start), "-i", sourcePath, "-t", formatOffset(segment.end - segment.start), "-c", "copy", "-f", "mpegts", outputPath];
}

export async function extractSegment(ffmpegBin: string, sourcePath: string, segment: CutSegment, outputPath: string): Promise<void> {
  await execFileAsync(ffmpegBin, buildExtractArgv(sourcePath, segment, outputPath), { timeout: 30_000 });
}

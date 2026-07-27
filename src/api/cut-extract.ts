import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatOffset } from "../recordings/cut-offsets.js";

const execFileAsync = promisify(execFile);

export interface CutSegment {
  start: number;
  end: number;
}

// -ss/-t are input options (before -i): -ss gives ffmpeg's fast keyframe seek,
// -t limits how much is read from the seek point, so the segment length is
// measured from the seek -- not the file start.
//
// -copyts is load-bearing and non-obvious. Real streamlink captures (concatenated
// HLS segments) contain video PTS discontinuities -- gaps where the video stalls
// for tens of seconds while audio keeps flowing (confirmed on a real capture:
// video gaps of 40s/15s/etc totalling ~100s against a continuous audio track).
// Without -copyts, ffmpeg's default mpegts timestamp handling "corrects" any jump
// past its discontinuity threshold by packing the video packets contiguously --
// collapsing those gaps out of the video timeline while leaving audio untouched.
// The result is a piece whose video runs progressively AHEAD of its audio (verified:
// a source with a 40s video stall produced a 90s piece with only ~50s of video).
// The raw source plays fine because a player honours the PTS gaps as freezes;
// -c copy through the muxer silently drops them. -copyts preserves the original
// timestamps (gaps intact); -start_at_zero + -output_ts_offset re-base the seek
// point to output 0 (start_at_zero shifts by the input's start_time, leaving the
// seek keyframe at segment.start, which output_ts_offset then cancels); and
// -avoid_negative_ts make_zero clamps the small audio-leads-video head offset.
// Offsets are argv entries only -- never interpolated into a shell string --
// mirroring streamlink-command.ts.
// -f mp4 is required with -movflags +faststart: without it, ffmpeg picks the
// output muxer from the output filename's extension, and the working ".mp4.tmp"
// name (written before an atomic rename to the final ".mp4" path) would have no
// extension ffmpeg recognizes, so it refuses to open the output at all.
export function buildExtractArgv(sourcePath: string, segment: CutSegment, outputPath: string): string[] {
  return ["-y", "-loglevel", "error", "-copyts", "-start_at_zero", "-ss", formatOffset(segment.start), "-t", formatOffset(segment.end - segment.start), "-i", sourcePath, "-c", "copy", "-avoid_negative_ts", "make_zero", "-output_ts_offset", `-${formatOffset(segment.start)}`, "-movflags", "+faststart", "-f", "mp4", outputPath];
}

// -ss's fast/keyframe seek + -c copy seeks the VIDEO stream to its nearest
// keyframe but seeks AUDIO independently to the literal requested time.
// Real streamlink captures (concatenated HLS segments) have irregular
// keyframe spacing -- confirmed against a real production capture, gaps up
// to 5s -- so an unaligned cut point can leave several seconds of
// audio-only playback before the first video frame appears (reproduced:
// audio started at 1.42s, first video frame not until 3.40s). Explicitly
// finding the real keyframe nearest at-or-before the requested start (via
// ffprobe, not trusted to -ss's approximation) and cutting exactly there
// makes both streams begin together (reproduced: audio 1.4036s, video
// 1.400s -- effectively aligned).
const KEYFRAME_SEARCH_WINDOW_SECONDS = 15;
const SNAP_EPSILON_SECONDS = 0.01;

// Pure so it's unit-testable without spawning ffprobe. `framesCsv` is the
// stdout of `ffprobe -show_entries frame=pts_time -of csv=p=0` (one raw,
// container-timebase pts per line); `startTime` is the source's own
// `format=start_time` (real captures don't start their PTS clock at 0).
export function pickKeyframeAtOrBefore(framesCsv: string, startTime: number, targetSeconds: number): number | undefined {
  let best: number | undefined;
  for (const line of framesCsv.split("\n")) {
    const raw = Number.parseFloat(line.trim());
    if (!Number.isFinite(raw)) continue;
    const relative = raw - startTime;
    if (relative <= targetSeconds && (best === undefined || relative > best)) best = relative;
  }
  return best;
}

async function findKeyframeAtOrBefore(ffprobeBin: string, sourcePath: string, targetSeconds: number): Promise<number | undefined> {
  try {
    const { stdout: formatOut } = await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", sourcePath], { timeout: 10_000 });
    const startTime = Number.parseFloat(formatOut.trim());
    if (!Number.isFinite(startTime)) return undefined;
    const windowStart = Math.max(startTime, startTime + targetSeconds - KEYFRAME_SEARCH_WINDOW_SECONDS);
    const windowEnd = startTime + targetSeconds + 0.05;
    const { stdout: framesOut } = await execFileAsync(ffprobeBin, [
      "-v", "error", "-select_streams", "v", "-skip_frame", "nokey",
      "-read_intervals", `${windowStart}%${windowEnd}`,
      "-show_entries", "frame=pts_time", "-of", "csv=p=0", sourcePath,
    ], { timeout: 10_000 });
    return pickKeyframeAtOrBefore(framesOut, startTime, targetSeconds);
  } catch {
    return undefined;
  }
}

export async function extractSegment(ffmpegBin: string, sourcePath: string, segment: CutSegment, outputPath: string, ffprobeBin?: string): Promise<void> {
  let effectiveSegment = segment;
  if (ffprobeBin) {
    const snapped = await findKeyframeAtOrBefore(ffprobeBin, sourcePath, segment.start);
    if (snapped !== undefined && segment.start - snapped > SNAP_EPSILON_SECONDS) effectiveSegment = { start: snapped, end: segment.end };
  }
  // Phase 5's 30s budget was set before this same phase added
  // `-movflags +faststart` to the extraction output, which -- like remux.ts's
  // own faststart pass -- roughly doubles write I/O (a second pass re-reads
  // and rewrites the whole mdat in place). Cut pieces are trimmed segments,
  // typically much smaller than a full capture, but a large Split of a
  // multi-hour recording can still produce a piece big enough for the old
  // budget to be tight. 120s gives generous headroom without going as high as
  // remux.ts's 10-minute budget, which is sized for a full, unbounded-length
  // capture rather than a source-bounded cut piece.
  await execFileAsync(ffmpegBin, buildExtractArgv(sourcePath, effectiveSegment, outputPath), { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
}

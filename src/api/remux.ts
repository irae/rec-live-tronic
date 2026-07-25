import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rename, rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export function buildRemuxArgv(sourcePath: string, outputPath: string): string[] {
  return ["-y", "-i", sourcePath, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", outputPath];
}

async function verifyRemuxOutput(ffprobeBin: string, sourcePath: string, outputPath: string): Promise<void> {
  // Get source duration
  const sourceResult = await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", sourcePath], { timeout: 10_000 });
  const sourceDuration = Number.parseFloat(sourceResult.stdout.trim());
  if (!Number.isFinite(sourceDuration)) {
    throw new Error("Failed to parse source duration");
  }

  // Get output duration
  const outputResult = await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath], { timeout: 10_000 });
  const outputDuration = Number.parseFloat(outputResult.stdout.trim());
  if (!Number.isFinite(outputDuration)) {
    throw new Error("Failed to parse output duration");
  }

  // Verify durations match within 1 second
  if (Math.abs(sourceDuration - outputDuration) > 1) {
    throw new Error(`Duration mismatch: source ${sourceDuration}s, output ${outputDuration}s`);
  }

  // Verify output has exactly one video and one audio stream
  const streamsResult = await execFileAsync(ffprobeBin, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", outputPath], { timeout: 10_000 });
  const streams = streamsResult.stdout.trim().split("\n").filter(line => line.length > 0);
  const videoCount = streams.filter(s => s === "video").length;
  const audioCount = streams.filter(s => s === "audio").length;

  if (videoCount !== 1 || audioCount !== 1) {
    throw new Error(`Invalid stream configuration: ${videoCount} video, ${audioCount} audio (expected 1 video, 1 audio)`);
  }
}

export async function remuxToMp4(ffmpegBin: string, ffprobeBin: string, sourcePath: string, outputPath: string): Promise<void> {
  const tmpPath = `${outputPath}.tmp`;
  try {
    // Run ffmpeg to temporary output
    await execFileAsync(ffmpegBin, buildRemuxArgv(sourcePath, tmpPath), { timeout: 600_000 });

    // Verify the temporary output
    await verifyRemuxOutput(ffprobeBin, sourcePath, tmpPath);

    // Atomically rename to final output path
    await rename(tmpPath, outputPath);
  } catch (error) {
    // Best-effort cleanup of temporary file
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

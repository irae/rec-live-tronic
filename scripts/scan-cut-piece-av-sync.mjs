#!/usr/bin/env node

// READ-ONLY diagnostic. Finds cut pieces whose audio and video streams have
// drifted apart -- the signature of the PTS-gap-collapse bug fixed in
// buildExtractArgv (a source video stall gets packed contiguously by `-c copy`,
// so the piece's video runs progressively ahead of its audio). It never writes
// to the database or to any media file; the only remediation is a human
// re-running the Cut/Keep flow in the app against the (restored) source, so
// this script deliberately has no --apply mode.
//
// Usage: node scan-cut-piece-av-sync.mjs <db-path> [--threshold <seconds>]
//   <db-path>      path to rec-live-tronic.sqlite (open read-only)
//   --threshold N  divergence in seconds to flag as suspect (default 2)
//
// Each cut piece's own file is probed for its video- and audio-stream
// durations; a piece is flagged when |audio - video| exceeds the threshold.
// A correct piece has near-equal stream durations (a small trailing
// video-freeze in the source can legitimately leave audio a second or two
// longer, hence the tolerance).

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);
const ffprobeBin = process.env.REC_LIVE_TEST_FFPROBE_BIN ?? "ffprobe";

async function streamDuration(path, kind) {
  const { stdout } = await execFileAsync(ffprobeBin, [
    "-v", "error", "-select_streams", kind,
    "-show_entries", "stream=duration", "-of", "csv=p=0", path,
  ]);
  return Number.parseFloat(stdout.trim());
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return "?";
  return `${seconds.toFixed(1)}s`;
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const thresholdIdx = args.indexOf("--threshold");
  const threshold = thresholdIdx !== -1 ? Number.parseFloat(args[thresholdIdx + 1]) : 2;

  if (!dbPath || !Number.isFinite(threshold)) {
    console.error("Usage: node scan-cut-piece-av-sync.mjs <db-path> [--threshold <seconds>]");
    console.error("\nREAD-ONLY. Flags cut pieces whose audio/video stream durations diverge");
    console.error(`by more than <seconds> (default 2). No writes are ever performed.\n`);
    process.exit(1);
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    console.error(`Failed to open database (read-only): ${dbPath}`);
    console.error(error.message);
    process.exit(1);
  }

  console.log(`Database: ${dbPath} (read-only)`);
  console.log(`Flagging cut pieces with |audio - video| > ${threshold}s\n`);

  const pieces = db
    .prepare(`SELECT id, title, ts_path, cut_from_id FROM recordings WHERE cut_from_id IS NOT NULL ORDER BY created_at ASC`)
    .all();
  console.log(`Found ${pieces.length} cut pieces (cut_from_id IS NOT NULL).\n`);

  const flagged = [];
  const skipped = [];

  for (const piece of pieces) {
    if (!piece.ts_path || !existsSync(piece.ts_path)) {
      skipped.push({ id: piece.id, reason: `file missing: ${piece.ts_path ?? "(none)"}` });
      continue;
    }
    let videoDuration;
    let audioDuration;
    try {
      videoDuration = await streamDuration(piece.ts_path, "v");
      audioDuration = await streamDuration(piece.ts_path, "a");
    } catch (error) {
      skipped.push({ id: piece.id, reason: `ffprobe failed: ${error.message}` });
      continue;
    }
    if (!Number.isFinite(videoDuration) || !Number.isFinite(audioDuration)) {
      skipped.push({ id: piece.id, reason: `unreadable stream durations (v=${videoDuration}, a=${audioDuration})` });
      continue;
    }
    const divergence = Math.abs(audioDuration - videoDuration);
    if (divergence > threshold) {
      flagged.push({ id: piece.id, title: piece.title, source: piece.cut_from_id, videoDuration, audioDuration, divergence });
    }
  }

  if (flagged.length > 0) {
    console.log(`SUSPECT cut pieces (audio/video drift > ${threshold}s):\n`);
    flagged.sort((a, b) => b.divergence - a.divergence);
    for (const f of flagged) {
      console.log(`  ${f.id}`);
      console.log(`    title:  ${f.title}`);
      console.log(`    source: ${f.source}`);
      console.log(`    video=${fmt(f.videoDuration)}  audio=${fmt(f.audioDuration)}  drift=${fmt(f.divergence)}`);
      console.log("");
    }
  } else {
    console.log("No cut pieces exceeded the divergence threshold.\n");
  }

  if (skipped.length > 0) {
    console.log(`Skipped ${skipped.length} piece(s):`);
    for (const s of skipped) console.log(`  ${s.id}: ${s.reason}`);
    console.log("");
  }

  console.log(`Summary: ${flagged.length} suspect, ${skipped.length} skipped, ${pieces.length - flagged.length - skipped.length} ok.`);
  console.log("Remediation is a human re-running the Cut/Keep flow against the source; this script writes nothing.");
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

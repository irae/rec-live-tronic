#!/usr/bin/env node

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Replicate toUnixMilliseconds logic inline
function toUnixMilliseconds(value) {
  if (typeof value === "string") {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
      throw new TypeError(`Timestamp must include a UTC offset: ${value}`);
    }
    return Date.parse(value);
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  throw new TypeError(`Invalid timestamp type: ${typeof value}`);
}

// Replicate toRfc3339 logic inline
function toRfc3339(milliseconds) {
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError(`Stored timestamp is not a valid UTC instant: ${milliseconds}`);
  }
  return new Date(milliseconds).toISOString();
}

// Parse cut draft params JSON and extract segments
function parseParams(paramsJson, durationSeconds) {
  const params = JSON.parse(paramsJson);
  const mode = params.mode || "unknown";

  if (mode === "trim") {
    // trim mode: { mode: 'trim', start: '..', end: '..' }
    // Need to parse offset strings (e.g. "10s", "1m30s") back to seconds
    // For now, assume they're already numeric or can be parsed
    const startStr = params.start;
    const endStr = params.end;

    // Try to parse offset format (hh:mm:ss or mm:ss or just seconds)
    const parseOffset = (str) => {
      if (typeof str === "number") return str;
      if (typeof str !== "string") throw new Error(`Invalid offset: ${str}`);

      const parts = str.split(":");
      if (parts.length === 1) {
        // Plain seconds, possibly with 's' suffix
        return parseFloat(parts[0]);
      } else if (parts.length === 2) {
        // mm:ss
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
      } else if (parts.length === 3) {
        // hh:mm:ss
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
      }
      throw new Error(`Invalid offset format: ${str}`);
    };

    const start = parseOffset(startStr);
    const end = parseOffset(endStr);
    return { mode: "trim", segments: [{ start, end }] };
  } else if (mode === "split") {
    // split mode: { mode: 'split', cuts: [...] }
    const cuts = (params.cuts || []).map((cutStr) => {
      if (typeof cutStr === "number") return cutStr;
      if (typeof cutStr !== "string") throw new Error(`Invalid cut value: ${cutStr}`);

      const parts = cutStr.split(":");
      if (parts.length === 1) {
        return parseFloat(parts[0]);
      } else if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseInt(parts[1]);
      } else if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
      }
      throw new Error(`Invalid cut format: ${cutStr}`);
    });

    const boundaries = [0, ...cuts, durationSeconds];
    const segments = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
      segments.push({ start: boundaries[i], end: boundaries[i + 1] });
    }
    return { mode: "split", segments };
  }

  throw new Error(`Unknown cut mode: ${mode}`);
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "??:??:??";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dbPath = args[0];
  const apply = args.includes("--apply");

  if (!dbPath) {
    console.error("Usage: node backfill-cut-piece-dates.mjs <db-path> [--apply]");
    console.error("\nDefault behavior (no --apply): DRY RUN - prints corrections without writing.");
    console.error("With --apply: Actually updates the database.\n");
    process.exit(1);
  }

  let db;
  try {
    db = new Database(dbPath);
  } catch (error) {
    console.error(`Failed to open database: ${dbPath}`);
    console.error(error.message);
    process.exit(1);
  }

  console.log(`Opening database: ${dbPath}`);
  if (apply) {
    console.log("Mode: APPLY (writing to database)");
  } else {
    console.log("Mode: DRY RUN (no writes)");
  }
  console.log("");

  try {
    // Find all recordings where cut_from_id IS NOT NULL (derived cut pieces)
    const derivedRecordings = db
      .prepare(`SELECT id, title, start_at, stop_at, cut_from_id, version, created_at FROM recordings WHERE cut_from_id IS NOT NULL ORDER BY cut_from_id ASC, created_at ASC`)
      .all();

    console.log(`Found ${derivedRecordings.length} derived cut pieces.\n`);

    const corrections = [];
    const skipped = [];
    const ambiguous = [];

    for (const derived of derivedRecordings) {
      const sourceId = derived.cut_from_id;

      // Get the source recording
      const source = db.prepare(`SELECT id, start_at, stop_at FROM recordings WHERE id = ?`).get(sourceId);
      if (!source) {
        skipped.push({ id: derived.id, title: derived.title, reason: "Source recording not found" });
        continue;
      }

      // Get the promoted cut draft for this source
      const draft = db
        .prepare(`SELECT id, params, piece_count FROM cut_drafts WHERE source_id = ? AND status = 'promoted'`)
        .get(sourceId);

      if (!draft) {
        skipped.push({ id: derived.id, title: derived.title, reason: "No promoted cut draft found for source" });
        continue;
      }

      // Parse the draft params to get segments
      let parsedDraft;
      try {
        const durationSeconds = (source.stop_at - source.start_at) / 1000;
        parsedDraft = parseParams(draft.params, durationSeconds);
      } catch (error) {
        skipped.push({ id: derived.id, title: derived.title, reason: `Failed to parse draft params: ${error.message}` });
        continue;
      }

      // Get all derived recordings for this source, sorted by creation time
      const allDerived = db
        .prepare(`SELECT id, title, start_at, stop_at, version, created_at FROM recordings WHERE cut_from_id = ? ORDER BY created_at ASC`)
        .all(sourceId);

      // Safety check: count must match segment count exactly
      if (allDerived.length !== parsedDraft.segments.length) {
        ambiguous.push({
          sourceId,
          reason: `Segment count mismatch: ${parsedDraft.segments.length} segments but ${allDerived.length} derived recordings`,
        });
        continue;
      }

      // Find the index of this derived recording in the sorted list
      const derivedIndex = allDerived.findIndex((r) => r.id === derived.id);
      if (derivedIndex === -1) {
        skipped.push({ id: derived.id, title: derived.title, reason: "Recording not found in derived list" });
        continue;
      }

      const segment = parsedDraft.segments[derivedIndex];
      const sourceStartMs = source.start_at; // Already in milliseconds

      // Compute the correct start_at and stop_at
      const correctStartAtMs = Math.round(sourceStartMs + segment.start * 1000);
      const correctStopAtMs = Math.round(sourceStartMs + segment.end * 1000);
      const correctStartAt = toRfc3339(correctStartAtMs);
      const correctStopAt = toRfc3339(correctStopAtMs);

      // Check if current dates exactly match source's (bug signature)
      const derivedStartAt = toRfc3339(derived.start_at);
      const derivedStopAt = toRfc3339(derived.stop_at);
      const sourceStartAt = toRfc3339(source.start_at);
      const sourceStopAt = toRfc3339(source.stop_at);

      if (derivedStartAt !== sourceStartAt || derivedStopAt !== sourceStopAt) {
        // Already has different dates, skip (already corrected or manually edited)
        skipped.push({
          id: derived.id,
          title: derived.title,
          reason: "Already has different dates (not matching source)",
        });
        continue;
      }

      // This is a candidate for correction
      const currentDuration = (derived.stop_at - derived.start_at) / 1000;
      const correctDuration = correctStopAtMs - correctStartAtMs;
      corrections.push({
        id: derived.id,
        title: derived.title,
        oldStartAt: derivedStartAt,
        oldStopAt: derivedStopAt,
        newStartAt: correctStartAt,
        newStopAt: correctStopAt,
        oldDuration: currentDuration,
        newDuration: correctDuration / 1000,
        version: derived.version,
        correctStartAtMs,
        correctStopAtMs,
      });
    }

    // Print report
    console.log("=" .repeat(120));
    console.log("CORRECTIONS TO APPLY");
    console.log("=" .repeat(120));

    if (corrections.length === 0) {
      console.log("No recordings need correction.\n");
    } else {
      console.log(`\n${corrections.length} recording(s) need date correction:\n`);
      console.log(
        "ID".padEnd(20) +
        "Title".padEnd(50) +
        "Old Duration".padEnd(14) +
        "New Duration".padEnd(14)
      );
      console.log("-".repeat(120));

      for (const c of corrections) {
        console.log(
          c.id.padEnd(20) +
          c.title.slice(0, 49).padEnd(50) +
          formatDuration(c.oldDuration).padEnd(14) +
          formatDuration(c.newDuration).padEnd(14)
        );
        console.log(
          "".padEnd(20) +
          `Old: ${c.oldStartAt} → ${c.oldStopAt}`.padEnd(50)
        );
        console.log(
          "".padEnd(20) +
          `New: ${c.newStartAt} → ${c.newStopAt}`.padEnd(50)
        );
        console.log("");
      }
    }

    if (ambiguous.length > 0) {
      console.log("\n" + "=" .repeat(120));
      console.log("SKIPPED - AMBIGUOUS (MANUAL REVIEW NEEDED)");
      console.log("=" .repeat(120));
      console.log(`\n${ambiguous.length} source(s) have ambiguous segment counts:\n`);
      for (const a of ambiguous) {
        console.log(`Source: ${a.sourceId}`);
        console.log(`  ${a.reason}\n`);
      }
    }

    if (skipped.length > 0) {
      console.log("\n" + "=" .repeat(120));
      console.log("SKIPPED - OTHER REASONS");
      console.log("=" .repeat(120));
      console.log(`\n${skipped.length} recording(s) skipped:\n`);
      for (const s of skipped) {
        console.log(`${s.id} ("${s.title}") - ${s.reason}`);
      }
      console.log("");
    }

    // Apply corrections if --apply flag was given
    if (apply && corrections.length > 0) {
      console.log("\n" + "=" .repeat(120));
      console.log("APPLYING CORRECTIONS");
      console.log("=" .repeat(120));
      console.log("");

      const updateStmt = db.prepare(
        `UPDATE recordings SET start_at = ?, stop_at = ?, updated_at = ? WHERE id = ? AND version = ?`
      );

      const transaction = db.transaction(() => {
        let updated = 0;
        let failed = 0;
        const failedIds = [];

        for (const c of corrections) {
          const now = Date.now();
          const result = updateStmt.run(c.correctStartAtMs, c.correctStopAtMs, now, c.id, c.version);
          if (result.changes === 1) {
            updated++;
            console.log(`✓ Updated ${c.id}`);
          } else {
            failed++;
            failedIds.push(c.id);
            console.log(`✗ Failed to update ${c.id} (version mismatch or not found)`);
          }
        }

        console.log(`\nResult: ${updated} updated, ${failed} failed`);
        if (failedIds.length > 0) {
          console.log(`Failed IDs: ${failedIds.join(", ")}`);
        }
        return { updated, failed };
      });

      try {
        const result = transaction();
        console.log(`\nCommitted: ${result.updated} rows updated to database.`);
      } catch (error) {
        console.error(`Transaction failed: ${error.message}`);
        process.exit(1);
      }
    } else if (!apply && corrections.length > 0) {
      console.log("\n" + "=" .repeat(120));
      console.log("DRY RUN MODE");
      console.log("=" .repeat(120));
      console.log(`\nNo changes made. Run with --apply flag to write ${corrections.length} correction(s) to the database.`);
    }

    console.log("");
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

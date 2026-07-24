import type Database from "better-sqlite3";
import { toRfc3339, toUnixMilliseconds, type UtcInstant } from "../db/instants.js";

export const cutModes = ["trim", "split"] as const;
export type CutMode = (typeof cutModes)[number];

export const cutDraftStatuses = ["previewing", "promoted", "failed"] as const;
export type CutDraftStatus = (typeof cutDraftStatuses)[number];

export interface CutDraft {
  id: string;
  sourceId: string;
  mode: CutMode;
  params: string;
  workingDir: string;
  status: CutDraftStatus;
  pieceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertPreviewingInput {
  id: string;
  sourceId: string;
  mode: CutMode;
  params: string;
  workingDir: string;
  pieceCount: number;
  now?: UtcInstant;
}

interface CutDraftRow {
  id: string;
  source_id: string;
  mode: string;
  params: string;
  working_dir: string;
  status: string;
  piece_count: number;
  created_at: number;
  updated_at: number;
}

const selectColumns = `SELECT id, source_id, mode, params, working_dir, status, piece_count, created_at, updated_at FROM cut_drafts`;

function assertMode(mode: string): asserts mode is CutMode {
  if (!cutModes.includes(mode as CutMode)) throw new TypeError(`Invalid cut mode: ${mode}`);
}

function timestamp(value: UtcInstant | undefined): number {
  return toUnixMilliseconds(value ?? new Date(), "now");
}

function mapCutDraft(row: CutDraftRow): CutDraft {
  assertMode(row.mode);
  if (!cutDraftStatuses.includes(row.status as CutDraftStatus)) throw new TypeError(`Invalid cut draft status: ${row.status}`);
  return {
    id: row.id,
    sourceId: row.source_id,
    mode: row.mode,
    params: row.params,
    workingDir: row.working_dir,
    status: row.status as CutDraftStatus,
    pieceCount: row.piece_count,
    createdAt: toRfc3339(row.created_at),
    updatedAt: toRfc3339(row.updated_at),
  };
}

// One `cut_drafts` row per source recording's in-progress edit. A source has
// at most one `previewing` row at a time (enforced by a partial unique index
// in the migration) -- the Adjust loop reuses that same row and working
// folder rather than accumulating orphaned drafts.
export class CutDraftRepository {
  constructor(private readonly database: Database.Database) {}

  // Creates a new previewing draft for the source, or -- if the source
  // already has one -- regenerates it in place (same id, same working_dir,
  // fresh mode/params/piece_count/updated_at). This is what makes the Adjust
  // loop leak no intermediate rows.
  upsertPreviewing(input: UpsertPreviewingInput): CutDraft {
    const now = timestamp(input.now);
    return this.database.transaction((): CutDraft => {
      const active = this.getActiveBySource(input.sourceId);
      if (active) {
        this.database.prepare(`UPDATE cut_drafts SET mode = ?, params = ?, working_dir = ?, status = 'previewing', piece_count = ?, updated_at = ? WHERE id = ?`)
          .run(input.mode, input.params, input.workingDir, input.pieceCount, now, active.id);
        return this.getRequired(active.id);
      }
      this.database.prepare(`INSERT INTO cut_drafts (id, source_id, mode, params, working_dir, status, piece_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'previewing', ?, ?, ?)`)
        .run(input.id, input.sourceId, input.mode, input.params, input.workingDir, input.pieceCount, now, now);
      return this.getRequired(input.id);
    })();
  }

  getById(id: string): CutDraft | undefined {
    const row = this.database.prepare(`${selectColumns} WHERE id = ?`).get(id) as CutDraftRow | undefined;
    return row === undefined ? undefined : mapCutDraft(row);
  }

  getActiveBySource(sourceId: string): CutDraft | undefined {
    const row = this.database.prepare(`${selectColumns} WHERE source_id = ? AND status = 'previewing'`).get(sourceId) as CutDraftRow | undefined;
    return row === undefined ? undefined : mapCutDraft(row);
  }

  markPromoted(id: string, now?: UtcInstant): CutDraft | undefined {
    return this.database.transaction((): CutDraft | undefined => {
      if (this.getById(id) === undefined) return undefined;
      this.database.prepare(`UPDATE cut_drafts SET status = 'promoted', updated_at = ? WHERE id = ?`).run(timestamp(now), id);
      return this.getRequired(id);
    })();
  }

  delete(id: string): void {
    this.database.prepare("DELETE FROM cut_drafts WHERE id = ?").run(id);
  }

  // Previewing drafts whose working folder hasn't been touched (regenerated
  // via Adjust) since before the cutoff -- candidates for sweepStaleCutDrafts.
  listStaleOlderThan(millisecondsSinceEpoch: number): CutDraft[] {
    const rows = this.database.prepare(`${selectColumns} WHERE status = 'previewing' AND updated_at < ? ORDER BY updated_at ASC`)
      .all(millisecondsSinceEpoch);
    return (rows as CutDraftRow[]).map(mapCutDraft);
  }

  private getRequired(id: string): CutDraft {
    const draft = this.getById(id);
    if (draft === undefined) throw new Error(`Cut draft ${id} disappeared during its transaction`);
    return draft;
  }
}

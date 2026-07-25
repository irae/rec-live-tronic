import type Database from "better-sqlite3";
import { toRfc3339, toUnixMilliseconds, type UtcInstant } from "../db/instants.js";

export const recordingStatuses = ["scheduled", "recording", "recorded", "cancelled", "failed", "missed"] as const;
export type RecordingStatus = (typeof recordingStatuses)[number];

export const allowedStatusTransitions: Readonly<Record<RecordingStatus, readonly RecordingStatus[]>> = {
  scheduled: ["recording", "recorded", "cancelled", "failed", "missed"],
  recording: ["recording", "recorded", "cancelled", "failed"],
  recorded: [],
  cancelled: [],
  failed: [],
  missed: [],
};

export interface Recording {
  id: string;
  url: string;
  title: string;
  stage: string | null;
  artist: string | null;
  venue: string | null;
  event: string | null;
  trashedAt: string | null;
  cookieId: string | null;
  cookiePath: string | null;
  cutFromId: string | null;
  quality: string;
  startAt: string;
  stopAt: string;
  status: RecordingStatus;
  unitName: string;
  tsPath: string;
  lastStartedBootId: string | null;
  lastStartedStopAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRecordingInput {
  id: string;
  url: string;
  title: string;
  stage?: string | null;
  artist?: string | null;
  venue?: string | null;
  event?: string | null;
  cookieId?: string | null;
  quality: string;
  startAt: UtcInstant;
  stopAt: UtcInstant;
  status?: RecordingStatus;
  unitName: string;
  tsPath: string;
  cutFromId?: string | null;
  now?: UtcInstant;
}

export interface UpdateScheduledDetails {
  title?: string;
  stage?: string | null;
  artist?: string | null;
  venue?: string | null;
  event?: string | null;
  quality?: string;
  startAt?: UtcInstant;
  stopAt?: UtcInstant;
  now?: UtcInstant;
}

export interface StatusCompareAndSet {
  id: string;
  expectedStatus: RecordingStatus;
  expectedVersion: number;
  status: RecordingStatus;
  lastStartedBootId?: string | null;
  lastStartedStopAt?: UtcInstant | null;
  now?: UtcInstant;
}

export type MutationResult<T> = { outcome: "updated"; value: T } | { outcome: "not_found" } | { outcome: "conflict" };

interface RecordingRow {
  id: string;
  url: string;
  title: string;
  stage: string | null;
  artist: string | null;
  venue: string | null;
  event: string | null;
  trashed_at: number | null;
  cookie_id: string | null;
  cookie_path: string | null;
  cut_from_id: string | null;
  quality: string;
  start_at: number;
  stop_at: number;
  status: string;
  unit_name: string;
  ts_path: string;
  last_started_boot_id: string | null;
  last_started_stop_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

const selectColumns = `
  SELECT recordings.id, recordings.url, recordings.title, recordings.stage, recordings.artist, recordings.venue, recordings.event, recordings.trashed_at, recordings.cookie_id, cookies.path AS cookie_path,
         recordings.quality, recordings.start_at, recordings.stop_at, recordings.status, recordings.unit_name,
         recordings.ts_path, recordings.last_started_boot_id, recordings.last_started_stop_at, recordings.cut_from_id, recordings.version, recordings.created_at, recordings.updated_at
  FROM recordings LEFT JOIN cookies ON cookies.id = recordings.cookie_id`;

function assertStatus(status: string): asserts status is RecordingStatus {
  if (!recordingStatuses.includes(status as RecordingStatus)) throw new TypeError(`Invalid recording status: ${status}`);
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("Expected version must be a non-negative integer");
}

function timestamp(value: UtcInstant | undefined, field: string): number {
  return toUnixMilliseconds(value ?? new Date(), field);
}

function mapRecording(row: RecordingRow): Recording {
  assertStatus(row.status);
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    stage: row.stage,
    artist: row.artist,
    venue: row.venue,
    event: row.event,
    trashedAt: row.trashed_at === null ? null : toRfc3339(row.trashed_at),
    cookieId: row.cookie_id,
    cookiePath: row.cookie_path,
    cutFromId: row.cut_from_id,
    quality: row.quality,
    startAt: toRfc3339(row.start_at),
    stopAt: toRfc3339(row.stop_at),
    status: row.status,
    unitName: row.unit_name,
    tsPath: row.ts_path,
    lastStartedBootId: row.last_started_boot_id,
    lastStartedStopAt: row.last_started_stop_at === null ? null : toRfc3339(row.last_started_stop_at),
    version: row.version,
    createdAt: toRfc3339(row.created_at),
    updatedAt: toRfc3339(row.updated_at),
  };
}

export class RecordingRepository {
  constructor(private readonly database: Database.Database) {}

  create(input: CreateRecordingInput): Recording {
    const startAt = timestamp(input.startAt, "startAt");
    const stopAt = timestamp(input.stopAt, "stopAt");
    if (startAt >= stopAt) throw new RangeError("startAt must be before stopAt");
    const now = timestamp(input.now, "now");
    const status = input.status ?? "scheduled";
    assertStatus(status);
    return this.database.transaction(() => {
      this.database.prepare(`INSERT INTO recordings
        (id, url, title, stage, artist, venue, event, cookie_id, quality, start_at, stop_at, status, unit_name, ts_path, cut_from_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.url, input.title, input.stage ?? null, input.artist ?? null, input.venue ?? null, input.event ?? null, input.cookieId ?? null, input.quality, startAt, stopAt, status, input.unitName, input.tsPath, input.cutFromId ?? null, now, now);
      return this.getRequired(input.id);
    })();
  }

  getById(id: string): Recording | undefined {
    const row = this.database.prepare(`${selectColumns} WHERE recordings.id = ?`).get(id) as RecordingRow | undefined;
    return row === undefined ? undefined : mapRecording(row);
  }

  list(filters: { status?: RecordingStatus; trashed?: boolean; cutFromId?: string } = {}): Recording[] {
    if (filters.status !== undefined) assertStatus(filters.status);
    let whereClause = "";
    const params: Array<string | null> = [];
    if (filters.trashed === true) {
      whereClause = " WHERE recordings.trashed_at IS NOT NULL";
    } else if (filters.trashed === false || filters.trashed === undefined) {
      whereClause = " WHERE recordings.trashed_at IS NULL";
    }
    if (filters.status !== undefined) {
      whereClause += (whereClause ? " AND" : " WHERE") + " recordings.status = ?";
      params.push(filters.status);
    }
    if (filters.cutFromId !== undefined) {
      whereClause += (whereClause ? " AND" : " WHERE") + " recordings.cut_from_id = ?";
      params.push(filters.cutFromId);
    }
    const rows = this.database.prepare(`${selectColumns}${whereClause} ORDER BY ${filters.trashed === true ? "recordings.trashed_at DESC" : "recordings.created_at DESC"}`).all(...params);
    return (rows as RecordingRow[]).map(mapRecording);
  }

  updateScheduledDetails(id: string, expectedVersion: number, patch: UpdateScheduledDetails): MutationResult<Recording> {
    assertVersion(expectedVersion);
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    let startAt: number | undefined;
    let stopAt: number | undefined;
    if (patch.title !== undefined) {
      fields.push("title = ?");
      values.push(patch.title);
    }
    if (patch.stage !== undefined) {
      fields.push("stage = ?");
      values.push(patch.stage);
    }
    if (patch.artist !== undefined) {
      fields.push("artist = ?");
      values.push(patch.artist);
    }
    if (patch.venue !== undefined) {
      fields.push("venue = ?");
      values.push(patch.venue);
    }
    if (patch.event !== undefined) {
      fields.push("event = ?");
      values.push(patch.event);
    }
    if (patch.quality !== undefined) {
      fields.push("quality = ?");
      values.push(patch.quality);
    }
    if (patch.startAt !== undefined) {
      startAt = timestamp(patch.startAt, "startAt");
      fields.push("start_at = ?");
      values.push(startAt);
    }
    if (patch.stopAt !== undefined) {
      stopAt = timestamp(patch.stopAt, "stopAt");
      fields.push("stop_at = ?");
      values.push(stopAt);
    }
    if (fields.length === 0) throw new TypeError("At least one recording detail is required");
    return this.database.transaction((): MutationResult<Recording> => {
      const existing = this.getById(id);
      if (existing === undefined) return { outcome: "not_found" };
      if (existing.status === "recording" && (patch.quality !== undefined || patch.startAt !== undefined)) {
        return { outcome: "conflict" };
      }
      if (existing.status === "recorded" && patch.quality !== undefined) {
        return { outcome: "conflict" };
      }
      if (existing.status !== "scheduled" && existing.status !== "recording" && existing.status !== "recorded") return { outcome: "conflict" };
      const effectiveStart = startAt ?? toUnixMilliseconds(existing.startAt, "stored startAt");
      const effectiveStop = stopAt ?? toUnixMilliseconds(existing.stopAt, "stored stopAt");
      if (effectiveStart >= effectiveStop) throw new RangeError("startAt must be before stopAt");
      const now = timestamp(patch.now, "now");
      const result = this.database.prepare(`UPDATE recordings SET ${fields.join(", ")}, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND status = ?`)
        .run(...values, now, id, expectedVersion, existing.status);
      if (result.changes !== 1) return { outcome: "conflict" };
      return { outcome: "updated", value: this.getRequired(id) };
    })();
  }

  cancel(id: string, expectedVersion: number, now?: UtcInstant): MutationResult<Recording> {
    assertVersion(expectedVersion);
    return this.database.transaction((): MutationResult<Recording> => {
      if (this.getById(id) === undefined) return { outcome: "not_found" };
      const result = this.database.prepare("UPDATE recordings SET status = 'cancelled', updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND status IN ('scheduled', 'recording')")
        .run(timestamp(now, "now"), id, expectedVersion);
      if (result.changes !== 1) return { outcome: "conflict" };
      return { outcome: "updated", value: this.getRequired(id) };
    })();
  }

  compareAndSetStatus(input: StatusCompareAndSet): MutationResult<Recording> {
    assertStatus(input.expectedStatus);
    assertStatus(input.status);
    assertVersion(input.expectedVersion);
    if (!allowedStatusTransitions[input.expectedStatus].includes(input.status)) {
      throw new TypeError(`Invalid recording status transition: ${input.expectedStatus} -> ${input.status}`);
    }
    return this.database.transaction((): MutationResult<Recording> => {
      if (this.getById(input.id) === undefined) return { outcome: "not_found" };
      const values: Array<string | number | null> = [input.status];
      let launchClauses = "";
      if (input.lastStartedBootId !== undefined) {
        launchClauses += ", last_started_boot_id = ?";
        values.push(input.lastStartedBootId);
      }
      if (input.lastStartedStopAt !== undefined) {
        launchClauses += ", last_started_stop_at = ?";
        values.push(input.lastStartedStopAt === null ? null : timestamp(input.lastStartedStopAt, "lastStartedStopAt"));
      }
      values.push(timestamp(input.now, "now"), input.id, input.expectedStatus, input.expectedVersion);
      const result = this.database.prepare(`UPDATE recordings SET status = ?${launchClauses}, updated_at = ?, version = version + 1 WHERE id = ? AND status = ? AND version = ?`)
        .run(...values);
      if (result.changes !== 1) return { outcome: "conflict" };
      return { outcome: "updated", value: this.getRequired(input.id) };
    })();
  }

  markLaunch(id: string, expectedVersion: number, stopAt: UtcInstant): MutationResult<Recording> {
    return this.compareAndSetStatus({ id, expectedStatus: "recording", expectedVersion, status: "recording", lastStartedStopAt: stopAt });
  }

  listDueScheduled(now: UtcInstant): Recording[] {
    return this.listByWindow("scheduled", now, "start_at <= ? AND stop_at > ?");
  }

  listActiveRecordings(now: UtcInstant): Recording[] {
    return this.listByWindow("recording", now, "start_at <= ? AND stop_at > ?");
  }

  listElapsedScheduled(now: UtcInstant): Recording[] {
    return this.listByWindow("scheduled", now, "stop_at <= ?");
  }

  listElapsedRecordings(now: UtcInstant): Recording[] {
    return this.listByWindow("recording", now, "stop_at <= ?");
  }

  listCancelled(): Recording[] {
    return this.list({ status: "cancelled" });
  }

  delete(id: string): void {
    this.database.transaction(() => {
      const existing = this.getById(id);
      if (existing === undefined) throw new Error(`Recording ${id} not found`);
      this.database.prepare("DELETE FROM recordings WHERE id = ?").run(id);
    })();
  }

  trash(id: string, now?: UtcInstant): MutationResult<Recording> {
    return this.database.transaction((): MutationResult<Recording> => {
      if (this.getById(id) === undefined) return { outcome: "not_found" };
      const trashedAt = timestamp(now, "now");
      this.database.prepare("UPDATE recordings SET trashed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(trashedAt, trashedAt, id);
      return { outcome: "updated", value: this.getRequired(id) };
    })();
  }

  restore(id: string, now?: UtcInstant): MutationResult<Recording> {
    return this.database.transaction((): MutationResult<Recording> => {
      const existing = this.getById(id);
      if (existing === undefined) return { outcome: "not_found" };
      if (existing.trashedAt === null) return { outcome: "conflict" };
      const updatedAt = timestamp(now, "now");
      this.database.prepare("UPDATE recordings SET trashed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?")
        .run(updatedAt, id);
      return { outcome: "updated", value: this.getRequired(id) };
    })();
  }

  purge(id: string): boolean {
    const result = this.database.prepare("DELETE FROM recordings WHERE id = ? AND trashed_at IS NOT NULL").run(id);
    return result.changes > 0;
  }

  listTrashedOlderThan(millisecondsSinceEpoch: number): Recording[] {
    const rows = this.database.prepare(`${selectColumns} WHERE recordings.trashed_at IS NOT NULL AND recordings.trashed_at < ? ORDER BY recordings.trashed_at ASC`)
      .all(millisecondsSinceEpoch);
    return (rows as RecordingRow[]).map(mapRecording);
  }

  private listByWindow(status: RecordingStatus, now: UtcInstant, predicate: string): Recording[] {
    const value = timestamp(now, "now");
    const parameterCount = (predicate.match(/\?/g) ?? []).length;
    const rows = this.database.prepare(`${selectColumns} WHERE recordings.status = ? AND ${predicate} ORDER BY recordings.start_at ASC`)
      .all(status, ...Array<number>(parameterCount).fill(value));
    return (rows as RecordingRow[]).map(mapRecording);
  }

  updateTsPath(id: string, tsPath: string, now?: UtcInstant): void {
    const updatedAt = timestamp(now, "now");
    this.database.prepare("UPDATE recordings SET ts_path = ?, updated_at = ?, version = version + 1 WHERE id = ?")
      .run(tsPath, updatedAt, id);
  }

  private getRequired(id: string): Recording {
    const recording = this.getById(id);
    if (recording === undefined) throw new Error(`Recording ${id} disappeared during its transaction`);
    return recording;
  }
}

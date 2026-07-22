import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { CookieRepository, type CookieMetadata } from "../cookies/repository.js";
import { toUnixMilliseconds } from "../db/instants.js";
import { RecordingRepository, recordingStatuses, type Recording, type RecordingStatus } from "../recordings/repository.js";
import type { Config } from "../config.js";
import type { SystemdClient } from "../systemd/client.js";
import { AppError } from "../app.js";
import { storeCookieAtomically } from "./storage.js";

const qualityValues = ["best", "1080p", "720p", "480p", "360p", "worst"] as const;
const allowedYouTubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

type RecordingInput = { url: unknown; title: unknown; cookie_id?: unknown; quality?: unknown; start_at: unknown; stop_at: unknown };
type RecordingPatch = { title?: unknown; quality?: unknown; start_at?: unknown; stop_at?: unknown };

function text(value: unknown, field: string, limit = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new AppError("VALIDATION_ERROR", 400, `${field} must be a non-empty string`);
  return value.trim();
}

function instant(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AppError("VALIDATION_ERROR", 400, `${field} must be an RFC 3339 instant with UTC offset`);
  try { toUnixMilliseconds(value, field); return value; } catch { throw new AppError("VALIDATION_ERROR", 400, `${field} must be a valid RFC 3339 instant with UTC offset`); }
}

function quality(value: unknown): string {
  const parsed = text(value, "quality", 20);
  if (!qualityValues.includes(parsed as (typeof qualityValues)[number])) throw new AppError("VALIDATION_ERROR", 400, "quality is invalid");
  return parsed;
}

function recordingId(): string { return `rec-${randomUUID().replaceAll("-", "")}`; }
function cookieId(): string { return `cookie-${randomUUID().replaceAll("-", "")}`; }

function validateUrl(value: unknown): string {
  const url = text(value, "url", 2_000);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new AppError("VALIDATION_ERROR", 400, "url must be an HTTPS YouTube URL"); }
  if (parsed.protocol !== "https:" || !allowedYouTubeHosts.has(parsed.hostname.toLowerCase()) || parsed.username || parsed.password) {
    throw new AppError("VALIDATION_ERROR", 400, "url must be an HTTPS YouTube URL");
  }
  return parsed.toString();
}

function mapRecording(recording: Recording): Omit<Recording, "cookiePath" | "unitName" | "tsPath" | "lastStartedBootId" | "lastStartedStopAt"> {
  const { cookiePath: _cookiePath, unitName: _unitName, tsPath: _tsPath, lastStartedBootId: _bootId, lastStartedStopAt: _stopAt, ...publicRecording } = recording;
  return publicRecording;
}

function requireStatus(value: unknown): RecordingStatus {
  if (typeof value !== "string" || !recordingStatuses.includes(value as RecordingStatus)) throw new AppError("VALIDATION_ERROR", 400, "status is invalid");
  return value as RecordingStatus;
}

export class RecorderService {
  constructor(
    private readonly recordings: RecordingRepository,
    private readonly cookies: CookieRepository,
    private readonly config: Config,
    private readonly systemd: SystemdClient,
  ) {}

  createRecording(input: RecordingInput): ReturnType<typeof mapRecording> {
    const startAt = instant(input.start_at, "start_at");
    const stopAt = instant(input.stop_at, "stop_at");
    if (toUnixMilliseconds(startAt, "start_at") >= toUnixMilliseconds(stopAt, "stop_at")) throw new AppError("VALIDATION_ERROR", 400, "start_at must be before stop_at");
    let cookieIdValue: string | null = null;
    if (input.cookie_id !== undefined && input.cookie_id !== null) {
      cookieIdValue = text(input.cookie_id, "cookie_id", 100);
      if (!this.cookies.getStoredById(cookieIdValue)) throw new AppError("UNKNOWN_COOKIE", 400, "cookie_id does not exist");
    }
    const qualityValue = input.quality === undefined ? "best" : quality(input.quality);
    const id = recordingId();
    return mapRecording(this.recordings.create({ id, url: validateUrl(input.url), title: text(input.title, "title"), cookieId: cookieIdValue, quality: qualityValue, startAt, stopAt, unitName: `${id}.service`, tsPath: join(this.config.recordingsDir, `${id}.ts`) }));
  }

  listRecordings(status?: unknown): ReturnType<typeof mapRecording>[] {
    return this.recordings.list(status === undefined ? {} : { status: requireStatus(status) }).map(mapRecording);
  }

  getRecording(id: string): ReturnType<typeof mapRecording> {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    return mapRecording(recording);
  }

  getRecordingFile(id: string): { status: RecordingStatus; tsPath: string } {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    return { status: recording.status, tsPath: recording.tsPath };
  }

  async patchRecording(id: string, input: RecordingPatch): Promise<{ recording: ReturnType<typeof mapRecording>; runtime_updated?: boolean; relaunched?: boolean; stop?: { attempted: true; confirmed: boolean } }> {
    const existing = this.recordings.getById(id);
    if (!existing) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (Object.keys(input).length === 0) throw new AppError("VALIDATION_ERROR", 400, "At least one mutable field is required");
    const patch: { title?: string; quality?: string; startAt?: string; stopAt?: string } = {};
    if (input.title !== undefined) patch.title = text(input.title, "title");
    if (input.quality !== undefined) patch.quality = quality(input.quality);
    if (input.start_at !== undefined) patch.startAt = instant(input.start_at, "start_at");
    if (input.stop_at !== undefined) patch.stopAt = instant(input.stop_at, "stop_at");
    const now = Date.now();
    if (existing.status === "scheduled") {
      if (toUnixMilliseconds(existing.startAt, "start_at") <= now) throw new AppError("STATUS_CONFLICT", 409, "Only future scheduled recordings can be changed");
    } else if (existing.status === "recording") {
      if (patch.title !== undefined || patch.quality !== undefined || patch.startAt !== undefined || patch.stopAt === undefined) throw new AppError("STATUS_CONFLICT", 409, "Running recordings may only change stop_at");
    } else throw new AppError("STATUS_CONFLICT", 409, "Recording cannot be changed in its current status");
    const effectiveStart = patch.startAt ?? existing.startAt;
    const effectiveStop = patch.stopAt ?? existing.stopAt;
    if (toUnixMilliseconds(effectiveStart, "start_at") >= toUnixMilliseconds(effectiveStop, "stop_at")) throw new AppError("VALIDATION_ERROR", 400, "start_at must be before stop_at");
    const result = this.recordings.updateScheduledDetails(id, existing.version, patch);
    if (result.outcome !== "updated") throw new AppError(result.outcome === "not_found" ? "NOT_FOUND" : "CONFLICT", result.outcome === "not_found" ? 404 : 409, "Recording changed concurrently");
    if (existing.status !== "recording" || patch.stopAt === undefined) return { recording: mapRecording(result.value) };
    if (toUnixMilliseconds(patch.stopAt, "stop_at") <= Date.now()) {
      const stop = await this.systemd.stopRecording(existing.unitName);
      return { recording: mapRecording(result.value), stop: { attempted: true, confirmed: stop.confirmed } };
    }
    // RuntimeMaxSec is relative to unit activation on some target systemd
    // versions. Refreshing it in place can therefore preempt the new durable
    // deadline. A confirmed stop followed by the append-mode launch gives it
    // an unambiguous fresh activation point.
    const stopped = await this.systemd.stopRecording(existing.unitName);
    if (!stopped.confirmed) return { recording: mapRecording(result.value), stop: { attempted: true, confirmed: false }, relaunched: false };
    const seconds = Math.max(1, Math.ceil((toUnixMilliseconds(patch.stopAt, "stop_at") - Date.now()) / 1000) + this.config.runtimeSafetySeconds);
    await this.systemd.startRecording(result.value, this.config, seconds);
    const marked = this.recordings.markLaunch(id, result.value.version, result.value.stopAt);
    if (marked.outcome === "updated") return { recording: mapRecording(marked.value), stop: { attempted: true, confirmed: true }, relaunched: true };
    return { recording: mapRecording(result.value), stop: { attempted: true, confirmed: true }, relaunched: true };
  }

  async cancelRecording(id: string): Promise<{ recording: ReturnType<typeof mapRecording>; stop: { attempted: boolean; confirmed: boolean } }> {
    const existing = this.recordings.getById(id);
    if (!existing) throw new AppError("NOT_FOUND", 404, "Recording not found");
    const result = this.recordings.cancel(id, existing.version);
    if (result.outcome !== "updated") throw new AppError("CONFLICT", 409, "Recording changed concurrently");
    if (existing.status !== "recording") return { recording: mapRecording(result.value), stop: { attempted: false, confirmed: false } };
    const stop = await this.systemd.stopRecording(existing.unitName);
    return { recording: mapRecording(result.value), stop: { attempted: true, confirmed: stop.confirmed } };
  }

  async createCookie(nameValue: unknown, bytes: Buffer): Promise<CookieMetadata> {
    const name = text(nameValue, "name", 200);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new AppError("VALIDATION_ERROR", 400, "cookie file is required");
    const id = cookieId();
    const path = join(this.config.cookiesDir, id);
    await storeCookieAtomically(this.config.cookiesDir, id, bytes);
    try {
      return this.cookies.createMetadata({ id, name, path });
    } catch (error) {
      try {
        await unlink(path);
      } catch (cleanupError) {
        throw new AppError("COOKIE_STORAGE_ROLLBACK_FAILED", 500, "Cookie storage cleanup failed; operator action is required");
      }
      throw error;
    }
  }

  listCookies(): CookieMetadata[] { return this.cookies.list(); }

  async deleteCookie(id: string): Promise<void> {
    const cookie = this.cookies.getStoredById(id);
    if (!cookie) throw new AppError("NOT_FOUND", 404, "Cookie not found");
    const result = this.cookies.deleteUnreferenced(id);
    if (result.outcome === "conflict") throw new AppError("COOKIE_IN_USE", 409, "Cookie is referenced by recordings");
    if (result.outcome === "not_found") throw new AppError("NOT_FOUND", 404, "Cookie not found");
    if (basename(cookie.path) === id && cookie.path === join(this.config.cookiesDir, id)) await unlink(cookie.path).catch(() => undefined);
  }

  transition(input: { id: string; expected_status: unknown; expected_version: unknown; status: unknown; last_started_boot_id?: unknown; last_started_stop_at?: unknown }): ReturnType<typeof mapRecording> {
    if (!Number.isSafeInteger(input.expected_version) || (input.expected_version as number) < 0) throw new AppError("VALIDATION_ERROR", 400, "expected_version is invalid");
    const lastStartedBootId = input.last_started_boot_id === undefined ? undefined : text(input.last_started_boot_id, "last_started_boot_id", 200);
    const lastStartedStopAt = input.last_started_stop_at === undefined ? undefined : instant(input.last_started_stop_at, "last_started_stop_at");
    try {
      const result = this.recordings.compareAndSetStatus({ id: input.id, expectedStatus: requireStatus(input.expected_status), expectedVersion: input.expected_version as number, status: requireStatus(input.status), ...(lastStartedBootId === undefined ? {} : { lastStartedBootId }), ...(lastStartedStopAt === undefined ? {} : { lastStartedStopAt }) });
      if (result.outcome !== "updated") throw new AppError(result.outcome === "not_found" ? "NOT_FOUND" : "CONFLICT", result.outcome === "not_found" ? 404 : 409, "Recording transition did not apply");
      return mapRecording(result.value);
    } catch (error) { if (error instanceof AppError) throw error; throw new AppError("VALIDATION_ERROR", 400, error instanceof Error ? error.message : "Invalid transition"); }
  }
}

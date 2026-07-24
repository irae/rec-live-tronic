import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { stat, unlink } from "node:fs/promises";
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

function stageFromTitle(title: string): string | null {
  const parts = title.split(" - ").map((part) => part.trim());
  if (parts.length !== 3 || parts.some((part) => part === "")) return null;
  return parts[1] ?? null;
}

// Best-effort YouTube metadata via the public oEmbed endpoint; the stage
// column stays null on any failure so recording creation never depends on this
// network call. The endpoint is config so functional tests point it off-network.
async function fetchOembedMetadata(endpoint: string, url: string): Promise<{ authorName: string | null; title: string | null }> {
  try {
    const response = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&format=json`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return { authorName: null, title: null };
    const data = await response.json() as { author_name?: unknown; title?: unknown };
    const author = typeof data.author_name === "string" && data.author_name.trim() ? data.author_name.trim().slice(0, 200) : null;
    const title = typeof data.title === "string" && data.title.trim() ? data.title.trim().slice(0, 500) : null;
    return { authorName: author, title };
  } catch {
    return { authorName: null, title: null };
  }
}

interface AvailableFormats {
  available: boolean;
  qualities: string[];
  best_matches: string | null;
}

const unavailableFormats: AvailableFormats = { available: false, qualities: [], best_matches: null };

// One-shot `streamlink --json <url>` probe to discover which named qualities a
// LIVE stream currently exposes. This never throws: any failure (non-live
// video, streamlink error, timeout, malformed JSON, missing binary) resolves
// to `unavailableFormats` so the formats route never blocks the recording form.
async function probeAvailableFormats(streamlinkBin: string, url: string): Promise<AvailableFormats> {
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(streamlinkBin, ["--json", url], { timeout: 8_000 }, (error, out) => {
        if (error) { reject(error); return; }
        resolve(out);
      });
    });
  } catch {
    return unavailableFormats;
  }

  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return unavailableFormats; }
  if (typeof parsed !== "object" || parsed === null) return unavailableFormats;
  const streams = (parsed as { streams?: unknown }).streams;
  if (typeof streams !== "object" || streams === null) return unavailableFormats;

  const streamEntries = streams as Record<string, { url?: unknown } | undefined>;
  const namedQualityPattern = /^(\d+)p$/;
  const qualities = Object.keys(streamEntries)
    .filter((key) => namedQualityPattern.test(key))
    .sort((a, b) => Number(b.match(namedQualityPattern)?.[1]) - Number(a.match(namedQualityPattern)?.[1]));

  const bestUrl = streamEntries.best?.url;
  const bestMatches = typeof bestUrl === "string"
    ? qualities.find((key) => streamEntries[key]?.url === bestUrl) ?? null
    : null;

  return { available: true, qualities, best_matches: bestMatches };
}

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

  async createRecording(input: RecordingInput): Promise<ReturnType<typeof mapRecording>> {
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
    const title = text(input.title, "title");
    const url = validateUrl(input.url);
    const stage = stageFromTitle(title) ?? (await fetchOembedMetadata(this.config.oembedEndpoint, url)).authorName;
    return mapRecording(this.recordings.create({ id, url, title, stage, cookieId: cookieIdValue, quality: qualityValue, startAt, stopAt, unitName: `${id}.service`, tsPath: join(this.config.recordingsDir, `${id}.ts`) }));
  }

  listRecordings(status?: unknown, filters?: { trashed?: boolean }): ReturnType<typeof mapRecording>[] {
    return this.recordings.list({
      ...(status !== undefined ? { status: requireStatus(status) } : {}),
      ...(filters?.trashed !== undefined ? { trashed: filters.trashed } : {}),
    }).map(mapRecording);
  }

  getRecording(id: string): ReturnType<typeof mapRecording> {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    return mapRecording(recording);
  }

  getRecordingFile(id: string): { status: RecordingStatus; tsPath: string; title: string } {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    return { status: recording.status, tsPath: recording.tsPath, title: recording.title };
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
      console.error(`Failed to create cookie metadata for ${id} (${path}):`, error);
      try {
        await unlink(path);
      } catch (cleanupError) {
        console.error(`Failed to clean up cookie file for ${id} (${path}):`, cleanupError);
        throw new AppError("COOKIE_STORAGE_ROLLBACK_FAILED", 500, "Cookie storage cleanup failed; operator action is required");
      }
      throw error;
    }
  }

  async getOembedMetadata(url: string): Promise<{ author_name: string | null; title: string | null }> {
    validateUrl(url);
    const oembed = await fetchOembedMetadata(this.config.oembedEndpoint, url);
    return { author_name: oembed.authorName, title: oembed.title };
  }

  async getAvailableFormats(url: string): Promise<AvailableFormats> {
    validateUrl(url);
    return probeAvailableFormats(this.config.streamlinkBin, url);
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

  async trashRecording(id: string): Promise<void> {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (recording.status !== "recorded") {
      throw new AppError("STATUS_CONFLICT", 409, "Only finished recordings can be trashed");
    }
    if (recording.trashedAt !== null) return;
    const result = this.recordings.trash(id);
    if (result.outcome === "not_found") throw new AppError("NOT_FOUND", 404, "Recording not found");
  }

  async restoreRecording(id: string): Promise<ReturnType<typeof mapRecording>> {
    const existing = this.recordings.getById(id);
    if (!existing) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (existing.trashedAt === null) throw new AppError("STATUS_CONFLICT", 409, "Recording is not in trash");
    const result = this.recordings.restore(id);
    if (result.outcome === "not_found") throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (result.outcome === "conflict") throw new AppError("STATUS_CONFLICT", 409, "Recording is not in trash");
    return mapRecording(result.value);
  }

  async permanentDeleteRecording(id: string): Promise<void> {
    const recording = this.recordings.getById(id);
    if (!recording) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (recording.trashedAt === null) throw new AppError("STATUS_CONFLICT", 409, "Only trashed recordings can be permanently deleted");
    try {
      await this.purgeOne(recording);
    } catch (error) {
      console.error(`Failed to unlink recording file for ${id} (${recording.tsPath}):`, error);
      throw new AppError("FILE_DELETE_ERROR", 500, "Failed to delete recording file");
    }
  }

  // Bytes still to be written by in-progress captures before they finish,
  // estimated from each recording's own elapsed-rate. statfs's actual_free
  // already reflects bytes written so far, so this must not double-count them.
  async getProjectedRemainingBytes(): Promise<number> {
    const inProgress = this.recordings.list({ status: "recording" });
    const now = Date.now();
    const remainders = await Promise.all(inProgress.map(async (recording) => {
      let currentSize = 0;
      try {
        currentSize = (await stat(recording.tsPath)).size;
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          console.error(`Failed to stat in-progress recording file for ${recording.id} (${recording.tsPath}):`, error);
        }
      }
      const startAtMs = toUnixMilliseconds(recording.startAt, "startAt");
      const stopAtMs = toUnixMilliseconds(recording.stopAt, "stopAt");
      const elapsedMs = now - startAtMs;
      if (elapsedMs <= 0) return 0;
      const rate = currentSize / elapsedMs;
      const remainingMs = Math.max(0, stopAtMs - now);
      return Math.max(0, rate * remainingMs);
    }));
    return remainders.reduce((sum, remaining) => sum + remaining, 0);
  }

  async autoSweepTrash(thirtyDaysMs: number = 30 * 24 * 60 * 60 * 1000): Promise<void> {
    const threshold = Date.now() - thirtyDaysMs;
    const toDelete = this.recordings.listTrashedOlderThan(threshold);
    for (const recording of toDelete) {
      try {
        await this.purgeOne(recording);
      } catch (error) {
        console.error(`Failed to unlink recording file during auto-sweep for ${recording.id} (${recording.tsPath}):`, error);
      }
    }
  }

  // Shared by permanentDeleteRecording and autoSweepTrash. Purges the row only
  // if the unlink succeeds (or the file was already gone), so an unlink
  // failure leaves the row intact instead of orphaning the file. purge()
  // itself only deletes rows still actually trashed, so a concurrent restore
  // racing the unlink can't be undone by a purge that lands after it.
  private async purgeOne(recording: Recording): Promise<void> {
    await unlink(recording.tsPath).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
    this.recordings.purge(recording.id);
  }

  transition(input: { id: string; expected_status: unknown; expected_version: unknown; status: unknown; last_started_boot_id?: unknown; last_started_stop_at?: unknown }): ReturnType<typeof mapRecording> {
    if (!Number.isSafeInteger(input.expected_version) || (input.expected_version as number) < 0) throw new AppError("VALIDATION_ERROR", 400, "expected_version is invalid");
    const lastStartedBootId = input.last_started_boot_id === undefined ? undefined : text(input.last_started_boot_id, "last_started_boot_id", 200);
    const lastStartedStopAt = input.last_started_stop_at === undefined ? undefined : instant(input.last_started_stop_at, "last_started_stop_at");
    try {
      const result = this.recordings.compareAndSetStatus({ id: input.id, expectedStatus: requireStatus(input.expected_status), expectedVersion: input.expected_version as number, status: requireStatus(input.status), ...(lastStartedBootId === undefined ? {} : { lastStartedBootId }), ...(lastStartedStopAt === undefined ? {} : { lastStartedStopAt }) });
      if (result.outcome !== "updated") throw new AppError(result.outcome === "not_found" ? "NOT_FOUND" : "CONFLICT", result.outcome === "not_found" ? 404 : 409, "Recording transition did not apply");
      return mapRecording(result.value);
    } catch (error) { if (error instanceof AppError) throw error; console.error(`Failed to transition recording ${input.id}:`, error); throw new AppError("VALIDATION_ERROR", 400, error instanceof Error ? error.message : "Invalid transition"); }
  }
}

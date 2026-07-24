import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { CookieRepository, type CookieMetadata } from "../cookies/repository.js";
import { toRfc3339, toUnixMilliseconds } from "../db/instants.js";
import { RecordingRepository, recordingStatuses, type Recording, type RecordingStatus } from "../recordings/repository.js";
import { CutDraftRepository, type CutDraft } from "../recordings/cut-draft-repository.js";
import type { Config } from "../config.js";
import type { SystemdClient } from "../systemd/client.js";
import { AppError } from "../app.js";
import { storeCookieAtomically } from "./storage.js";
import { extractSegment } from "./cut-extract.js";
import { parseCutRequest } from "./cut-request.js";
import { formatOffset } from "../recordings/cut-offsets.js";

const qualityValues = ["best", "1080p", "720p", "480p", "360p", "worst"] as const;
const allowedYouTubeHosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]);

type RecordingInput = { url: unknown; title?: unknown; artist?: unknown; venue?: unknown; event?: unknown; stage?: unknown; cookie_id?: unknown; quality?: unknown; start_at: unknown; stop_at: unknown };
type RecordingPatch = { title?: unknown; stage?: unknown; artist?: unknown; venue?: unknown; event?: unknown; quality?: unknown; start_at?: unknown; stop_at?: unknown };

function text(value: unknown, field: string, limit = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new AppError("VALIDATION_ERROR", 400, `${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, field: string, limit = 200): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new AppError("VALIDATION_ERROR", 400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > limit) throw new AppError("VALIDATION_ERROR", 400, `${field} must be a non-empty string`);
  return trimmed === "" ? null : trimmed;
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
function cutDraftId(): string { return `cut-${randomUUID().replaceAll("-", "")}`; }

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

interface CutPieceResponse {
  index: number;
  start: string;
  end: string;
  duration: string;
  file_url: string;
}

interface CutDraftResponse {
  id: string;
  mode: CutDraft["mode"];
  status: CutDraft["status"];
  pieces: CutPieceResponse[];
}

export class RecorderService {
  constructor(
    private readonly recordings: RecordingRepository,
    private readonly cookies: CookieRepository,
    private readonly config: Config,
    private readonly systemd: SystemdClient,
    private readonly cutDrafts: CutDraftRepository,
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
    const url = validateUrl(input.url);
    const artist = optionalText(input.artist, "artist");
    const venue = optionalText(input.venue, "venue");
    const event = optionalText(input.event, "event");
    const explicitStageInput = optionalText(input.stage, "stage");
    const explicitTitle = input.title === undefined || input.title === null ? null : text(input.title, "title");
    const composedTitle = [artist, venue, event, explicitStageInput].filter((segment): segment is string => segment !== null && segment !== "").join(" - ");
    const title = explicitTitle ?? composedTitle;
    if (!title) throw new AppError("VALIDATION_ERROR", 400, "title must be a non-empty string");
    const cappedTitle = title.length > 500 ? title.slice(0, 500) : title;
    const stage = explicitStageInput ?? stageFromTitle(title) ?? (await fetchOembedMetadata(this.config.oembedEndpoint, url)).authorName;
    return mapRecording(this.recordings.create({ id, url, title: cappedTitle, stage, artist, venue, event, cookieId: cookieIdValue, quality: qualityValue, startAt, stopAt, unitName: `${id}.service`, tsPath: join(this.config.recordingsDir, `${id}.ts`) }));
  }

  listRecordings(status?: unknown, filters?: { trashed?: boolean; cutFromId?: string }): ReturnType<typeof mapRecording>[] {
    return this.recordings.list({
      ...(status !== undefined ? { status: requireStatus(status) } : {}),
      ...(filters?.trashed !== undefined ? { trashed: filters.trashed } : {}),
      ...(filters?.cutFromId !== undefined ? { cutFromId: filters.cutFromId } : {}),
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

  // Creates the source's active cut draft, or -- if one already exists --
  // regenerates its preview pieces in place (the Adjust loop). Every -c copy
  // extraction lands in recordingsDir/${sourceId}/piece-<index>.ts; the
  // source row and its .ts are never touched.
  async createCutDraft(sourceId: string, input: unknown): Promise<{ draft: CutDraftResponse }> {
    const source = this.recordings.getById(sourceId);
    if (!source) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (source.status !== "recorded") throw new AppError("STATUS_CONFLICT", 409, "Only finished recordings can be cut");
    if (source.trashedAt !== null) throw new AppError("STATUS_CONFLICT", 409, "Cannot cut a trashed recording");
    const durationSeconds = (toUnixMilliseconds(source.stopAt, "stopAt") - toUnixMilliseconds(source.startAt, "startAt")) / 1000;
    const parsed = parseCutRequest(input, durationSeconds);

    const workingDir = join(this.config.recordingsDir, sourceId);
    await mkdir(workingDir, { recursive: true, mode: 0o770 });
    const existing = this.cutDrafts.getActiveBySource(sourceId);

    // Extract every segment to a .tmp path first. Only once ALL segments have
    // extracted successfully do we rename them into their final piece-N.ts
    // names and update the draft row -- a failure partway through (ffmpeg
    // error, seek timeout) must leave any existing previewing draft and its
    // old piece files completely untouched, not a mix of new/partial/old.
    const tmpPaths: string[] = [];
    try {
      for (let index = 0; index < parsed.segments.length; index += 1) {
        const segment = parsed.segments[index]!;
        const tmpPath = join(workingDir, `piece-${index}.ts.tmp`);
        tmpPaths.push(tmpPath);
        await extractSegment(this.config.ffmpegBin, source.tsPath, segment, tmpPath);
      }
    } catch (error) {
      await Promise.all(tmpPaths.map((tmpPath) => rm(tmpPath, { force: true }).catch(() => undefined)));
      throw error;
    }
    for (let index = 0; index < parsed.segments.length; index += 1) {
      await rename(join(workingDir, `piece-${index}.ts.tmp`), join(workingDir, `piece-${index}.ts`));
    }
    // A piece-count-reducing Adjust can leave stale higher-index piece files
    // from the previous, larger set -- remove them now that the new set is
    // fully in place.
    if (existing && existing.pieceCount > parsed.segments.length) {
      for (let index = parsed.segments.length; index < existing.pieceCount; index += 1) {
        await rm(join(workingDir, `piece-${index}.ts`), { force: true }).catch(() => undefined);
      }
    }

    const draft = this.cutDrafts.upsertPreviewing({
      id: existing?.id ?? cutDraftId(),
      sourceId,
      mode: parsed.mode,
      params: JSON.stringify(parsed.params),
      workingDir,
      pieceCount: parsed.segments.length,
    });

    return {
      draft: {
        id: draft.id,
        mode: draft.mode,
        status: draft.status,
        pieces: parsed.segments.map((segment, index) => ({
          index,
          start: formatOffset(segment.start),
          end: formatOffset(segment.end),
          duration: formatOffset(segment.end - segment.start),
          file_url: `/recordings/${sourceId}/cut/${draft.id}/pieces/${index}/file`,
        })),
      },
    };
  }

  getCutPieceFile(sourceId: string, draftId: string, indexRaw: string): { filePath: string } {
    const source = this.recordings.getById(sourceId);
    if (!source) throw new AppError("NOT_FOUND", 404, "Recording not found");
    const draft = this.cutDrafts.getById(draftId);
    if (!draft || draft.sourceId !== sourceId) throw new AppError("NOT_FOUND", 404, "Cut draft not found");
    const index = Number(indexRaw);
    if (!Number.isInteger(index) || index < 0 || index >= draft.pieceCount) throw new AppError("NOT_FOUND", 404, "Cut piece not found");
    return { filePath: join(draft.workingDir, `piece-${index}.ts`) };
  }

  // Promotes selected preview pieces of a previewing draft to first-class
  // `recorded` recordings, linked back to the source via cutFromId. Segments
  // are re-derived from the draft's stored params (rather than trusting
  // client input) so the promoted wall-clock windows always match what was
  // actually extracted. The source row and its .ts are never touched.
  async keepCutDraft(sourceId: string, draftId: string, input: unknown): Promise<{ recordings: ReturnType<typeof mapRecording>[] }> {
    const source = this.recordings.getById(sourceId);
    if (!source) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (source.trashedAt !== null) throw new AppError("STATUS_CONFLICT", 409, "Cannot cut a trashed recording");
    const draft = this.cutDrafts.getById(draftId);
    if (!draft || draft.sourceId !== sourceId) throw new AppError("NOT_FOUND", 404, "Cut draft not found");
    if (draft.status !== "previewing") throw new AppError("STATUS_CONFLICT", 409, "Cut draft is not previewing");

    const durationSeconds = (toUnixMilliseconds(source.stopAt, "stopAt") - toUnixMilliseconds(source.startAt, "startAt")) / 1000;
    const parsed = parseCutRequest({ mode: draft.mode, ...(JSON.parse(draft.params) as Record<string, unknown>) }, durationSeconds);

    if (input !== undefined && input !== null && typeof input !== "object") throw new AppError("VALIDATION_ERROR", 400, "Request body must be an object");
    const body = (input ?? {}) as { keep?: unknown; overrides?: unknown };

    let keepIndices: number[];
    if (body.keep === undefined) {
      keepIndices = draft.mode === "trim" ? [0] : parsed.segments.map((_segment, index) => index);
    } else {
      if (!Array.isArray(body.keep)) throw new AppError("VALIDATION_ERROR", 400, "keep must be an array of piece indices");
      const seen = new Set<number>();
      for (const raw of body.keep) {
        if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) >= parsed.segments.length) throw new AppError("VALIDATION_ERROR", 400, "keep contains an invalid piece index");
        seen.add(raw as number);
      }
      keepIndices = [...seen].sort((a, b) => a - b);
      if (keepIndices.length === 0) throw new AppError("VALIDATION_ERROR", 400, "keep must include at least one piece index");
    }

    let overrides: Record<string, { title?: unknown; artist?: unknown; venue?: unknown; event?: unknown; stage?: unknown; start_at?: unknown; stop_at?: unknown }> = {};
    if (body.overrides !== undefined) {
      if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) throw new AppError("VALIDATION_ERROR", 400, "overrides must be an object keyed by piece index");
      overrides = body.overrides as Record<string, { title?: unknown; artist?: unknown; venue?: unknown; event?: unknown; stage?: unknown; start_at?: unknown; stop_at?: unknown }>;
      for (const key of Object.keys(overrides)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= parsed.segments.length) throw new AppError("VALIDATION_ERROR", 400, "overrides contains an invalid piece index");
      }
    }

    // An override field that's absent or an empty string means "use the
    // default"; any other value goes through the same text() validation used
    // elsewhere in this file. Mirrors optionalText's empty-means-default
    // shape, but these are creation-time fields on a brand new row rather
    // than a PATCH-style clear-to-null.
    const overrideField = (value: unknown, field: string, limit = 200): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value === "string" && value.trim() === "") return undefined;
      return text(value, field, limit);
    };

    // First pass: validate everything and compute every value that could
    // throw (field overrides, RFC3339 conversion) before any file is
    // touched, so a 400 here has zero side effects on disk.
    const toPromote = keepIndices.map((index) => {
      const override = overrides[String(index)];
      if (override !== undefined && (typeof override !== "object" || override === null || Array.isArray(override))) {
        throw new AppError("VALIDATION_ERROR", 400, `overrides[${index}] must be an object`);
      }
      const title = overrideField(override?.title, `overrides[${index}].title`, 500)
        ?? (draft.mode === "trim" ? source.title : `${source.title} (part ${index + 1})`);
      const artist = overrideField(override?.artist, `overrides[${index}].artist`) ?? source.artist;
      const venue = overrideField(override?.venue, `overrides[${index}].venue`) ?? source.venue;
      const event = overrideField(override?.event, `overrides[${index}].event`) ?? source.event;
      const stage = overrideField(override?.stage, `overrides[${index}].stage`) ?? source.stage;
      // Cut pieces default to the same dates as the source recording (a cut
      // is conceptually "the same event," not a different sub-window) --
      // editable per piece since a split can plausibly want distinct dates.
      const startAt = override?.start_at !== undefined ? instant(override.start_at, `overrides[${index}].start_at`) : source.startAt;
      const stopAt = override?.stop_at !== undefined ? instant(override.stop_at, `overrides[${index}].stop_at`) : source.stopAt;
      if (toUnixMilliseconds(startAt, `overrides[${index}].start_at`) >= toUnixMilliseconds(stopAt, `overrides[${index}].stop_at`)) {
        throw new AppError("VALIDATION_ERROR", 400, `overrides[${index}].start_at must be before stop_at`);
      }
      return { index, newId: recordingId(), title, artist, venue, event, stage, startAt, stopAt };
    });

    // Second pass: everything is known-valid, so it's now safe to rename
    // piece files and create their recording rows.
    const derived: Recording[] = [];
    for (const { index, newId, title, artist, venue, event, stage, startAt, stopAt } of toPromote) {
      const piecePath = join(draft.workingDir, `piece-${index}.ts`);
      const destPath = join(this.config.recordingsDir, `${newId}.ts`);
      await rename(piecePath, destPath);
      const created = this.recordings.create({
        id: newId,
        url: source.url,
        title,
        stage,
        artist,
        venue,
        event,
        cookieId: null,
        quality: source.quality,
        startAt,
        stopAt,
        status: "recorded",
        unitName: `${newId}.service`,
        tsPath: destPath,
        cutFromId: sourceId,
      });
      derived.push(created);
    }

    this.cutDrafts.markPromoted(draftId);
    await rm(draft.workingDir, { recursive: true, force: true });

    // Every successful Keep renames and trashes the source: it's a live,
    // renamed-and-trashed backup rather than a first-class recording from
    // this point on. Only the row (title, trashed_at) changes -- the .ts file
    // on disk is never touched, same as any other trash operation.
    const renamed = this.recordings.updateScheduledDetails(sourceId, source.version, { title: `${source.title} (original recording)` });
    if (renamed.outcome !== "updated") throw new AppError("CONFLICT", 409, "Recording changed concurrently");
    this.recordings.trash(sourceId);

    return { recordings: derived.map(mapRecording) };
  }

  async abandonCutDraft(sourceId: string, draftId: string): Promise<void> {
    const source = this.recordings.getById(sourceId);
    if (!source) throw new AppError("NOT_FOUND", 404, "Recording not found");
    const draft = this.cutDrafts.getById(draftId);
    if (!draft || draft.sourceId !== sourceId) throw new AppError("NOT_FOUND", 404, "Cut draft not found");
    await rm(draft.workingDir, { recursive: true, force: true });
    this.cutDrafts.delete(draftId);
  }

  async patchRecording(id: string, input: RecordingPatch): Promise<{ recording: ReturnType<typeof mapRecording>; runtime_updated?: boolean; relaunched?: boolean; stop?: { attempted: true; confirmed: boolean } }> {
    const existing = this.recordings.getById(id);
    if (!existing) throw new AppError("NOT_FOUND", 404, "Recording not found");
    if (Object.keys(input).length === 0) throw new AppError("VALIDATION_ERROR", 400, "At least one mutable field is required");
    const patch: { title?: string; stage?: string | null; artist?: string | null; venue?: string | null; event?: string | null; quality?: string; startAt?: string; stopAt?: string } = {};
    if (input.title !== undefined) patch.title = text(input.title, "title");
    if (input.stage !== undefined) patch.stage = input.stage === null || (typeof input.stage === "string" && input.stage.trim() === "") ? null : text(input.stage, "stage", 200);
    if (input.artist !== undefined) patch.artist = input.artist === null || (typeof input.artist === "string" && input.artist.trim() === "") ? null : text(input.artist, "artist", 200);
    if (input.venue !== undefined) patch.venue = input.venue === null || (typeof input.venue === "string" && input.venue.trim() === "") ? null : text(input.venue, "venue", 200);
    if (input.event !== undefined) patch.event = input.event === null || (typeof input.event === "string" && input.event.trim() === "") ? null : text(input.event, "event", 200);
    if (input.quality !== undefined) patch.quality = quality(input.quality);
    if (input.start_at !== undefined) patch.startAt = instant(input.start_at, "start_at");
    if (input.stop_at !== undefined) patch.stopAt = instant(input.stop_at, "stop_at");
    const now = Date.now();
    if (existing.status === "scheduled") {
      if (toUnixMilliseconds(existing.startAt, "start_at") <= now) throw new AppError("STATUS_CONFLICT", 409, "Only future scheduled recordings can be changed");
    } else if (existing.status === "recording") {
      // quality and start_at are locked in mid-capture (streamlink already
      // launched with that quality; the actual start already happened) --
      // everything else, including stop_at (the one live control value),
      // is fair game while a recording is running.
      if (patch.quality !== undefined || patch.startAt !== undefined) throw new AppError("STATUS_CONFLICT", 409, "Running recordings may only change title, stage, artist, venue, event, or stop_at");
    } else if (existing.status === "recorded") {
      if (patch.quality !== undefined) throw new AppError("STATUS_CONFLICT", 409, "Finished recordings may only change title, stage, artist, venue, event, start_at, or stop_at");
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

  // Mirrors autoSweepTrash's shape for the cut-draft side of orphan cleanup:
  // any draft still `previewing` past maxAgeMs (an abandoned tab, or a first
  // screen closed after a draft was already created) has its working folder
  // and row removed. The row is only dropped once its folder is gone, so a
  // removal failure leaves the draft intact rather than orphaning the folder.
  async sweepStaleCutDrafts(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    const threshold = Date.now() - maxAgeMs;
    for (const draft of this.cutDrafts.listStaleOlderThan(threshold)) {
      try {
        await rm(draft.workingDir, { recursive: true, force: true });
        this.cutDrafts.delete(draft.id);
      } catch (error) {
        console.error(`Failed to sweep stale cut draft ${draft.id} (${draft.workingDir}):`, error);
      }
    }
  }

  // Shared by permanentDeleteRecording and autoSweepTrash. Purges the row only
  // if the unlink succeeds (or the file was already gone), so an unlink
  // failure leaves the row intact instead of orphaning the file. purge()
  // itself only deletes rows still actually trashed, so a concurrent restore
  // racing the unlink can't be undone by a purge that lands after it. Any
  // leftover `<id>/` cut working folder (an abandoned/stale draft next to a
  // recording that was itself a cut source) is best-effort cleaned up too --
  // its failure never blocks the row purge.
  private async purgeOne(recording: Recording): Promise<void> {
    await unlink(recording.tsPath).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    });
    await rm(join(this.config.recordingsDir, recording.id), { recursive: true, force: true }).catch((error) => {
      console.error(`Failed to remove cut working folder for ${recording.id}:`, error);
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

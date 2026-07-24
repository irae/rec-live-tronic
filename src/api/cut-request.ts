import { AppError } from "../app.js";
import { formatOffset, parseOffset } from "../recordings/cut-offsets.js";
import type { CutMode } from "../recordings/cut-draft-repository.js";
import type { CutSegment } from "./cut-extract.js";

export interface ParsedCutRequest {
  mode: CutMode;
  segments: CutSegment[];
  params: Record<string, unknown>;
}

function offset(raw: unknown, field: string): number {
  if (typeof raw !== "string") throw new AppError("VALIDATION_ERROR", 400, `${field} must be a string`);
  try {
    return parseOffset(raw, field);
  } catch {
    throw new AppError("VALIDATION_ERROR", 400, `${field} is malformed`);
  }
}

export function parseCutRequest(input: unknown, durationSeconds: number): ParsedCutRequest {
  if (typeof input !== "object" || input === null) throw new AppError("VALIDATION_ERROR", 400, "Request body is required");
  const body = input as Record<string, unknown>;

  if (body.mode === "trim") {
    const start = offset(body.start, "start");
    const endRaw = body.end ?? body.duration;
    const end = endRaw === undefined ? durationSeconds : offset(endRaw, "end");
    if (start < 0 || start >= durationSeconds) throw new AppError("VALIDATION_ERROR", 400, "start is out of range");
    if (end <= start || end > durationSeconds) throw new AppError("VALIDATION_ERROR", 400, "end is out of range");
    return {
      mode: "trim",
      segments: [{ start, end }],
      params: { start: formatOffset(start), end: formatOffset(end) },
    };
  }

  if (body.mode === "split") {
    if (!Array.isArray(body.cuts) || body.cuts.length === 0) throw new AppError("VALIDATION_ERROR", 400, "cuts must be a non-empty array");
    const cuts = body.cuts.map((raw, index) => offset(raw, `cuts[${index}]`));
    for (let index = 0; index < cuts.length; index += 1) {
      const value = cuts[index]!;
      if (value <= 0 || value >= durationSeconds) throw new AppError("VALIDATION_ERROR", 400, "cuts must fall strictly within the recording's duration");
      if (index > 0 && value <= cuts[index - 1]!) throw new AppError("VALIDATION_ERROR", 400, "cuts must be strictly increasing");
    }
    const boundaries = [0, ...cuts, durationSeconds];
    const segments: CutSegment[] = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      segments.push({ start: boundaries[index]!, end: boundaries[index + 1]! });
    }
    return {
      mode: "split",
      segments,
      params: { cuts: cuts.map((value) => formatOffset(value)) },
    };
  }

  throw new AppError("VALIDATION_ERROR", 400, "mode must be 'trim' or 'split'");
}

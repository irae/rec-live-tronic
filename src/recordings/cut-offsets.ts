// Parses/formats the offset strings used by the Cut workflow's trim/split
// endpoints. Accepted input shapes: "H:MM:SS", "MM:SS", "SS", each optionally
// with a fractional-second remainder (e.g. "1:23:45.5"). Output is always
// normalized to "H:MM:SS" (with a ".mmm" suffix when the value has a
// sub-second remainder) so it can be handed straight to ffmpeg's -ss/-to.
const segmentPattern = /^\d+(\.\d+)?$/;

export function parseOffset(raw: string, field = "offset"): number {
  if (typeof raw !== "string") throw new RangeError(`${field} must be a string`);
  const trimmed = raw.trim();
  if (trimmed === "") throw new RangeError(`${field} must be a non-empty string`);
  const parts = trimmed.split(":");
  if (parts.length < 1 || parts.length > 3) throw new RangeError(`${field} is malformed`);
  for (const part of parts) {
    if (!segmentPattern.test(part)) throw new RangeError(`${field} is malformed`);
  }
  const values = parts.map(Number);
  let seconds: number;
  if (values.length === 3) {
    const [hours, minutes, secs] = values as [number, number, number];
    if (minutes >= 60 || secs >= 60) throw new RangeError(`${field} is malformed`);
    seconds = hours * 3600 + minutes * 60 + secs;
  } else if (values.length === 2) {
    const [minutes, secs] = values as [number, number];
    if (secs >= 60) throw new RangeError(`${field} is malformed`);
    seconds = minutes * 60 + secs;
  } else {
    seconds = values[0]!;
  }
  if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError(`${field} is malformed`);
  return seconds;
}

export function formatOffset(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) throw new RangeError("offset must be a non-negative number");
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const wholeSeconds = Math.floor(seconds);
  const fraction = seconds - wholeSeconds;
  const secondsPart = fraction > 1e-6 ? seconds.toFixed(3).padStart(6, "0") : String(wholeSeconds).padStart(2, "0");
  return `${hours}:${String(minutes).padStart(2, "0")}:${secondsPart}`;
}

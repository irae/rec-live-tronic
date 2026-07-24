// Client-side counterpart to src/recordings/cut-offsets.ts: parses/formats
// the same H:MM:SS / MM:SS / SS offset strings the cut API accepts, for
// input validation and display before the timestamp ever reaches the server
// (which re-validates and is the source of truth).
const segmentPattern = /^\d+(\.\d+)?$/;

export function parseOffsetInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  if (parts.length < 1 || parts.length > 3) return null;
  if (!parts.every((part) => segmentPattern.test(part))) return null;
  const values = parts.map(Number);
  let seconds: number;
  if (values.length === 3) {
    const [hours, minutes, secs] = values as [number, number, number];
    if (minutes >= 60 || secs >= 60) return null;
    seconds = hours * 3600 + minutes * 60 + secs;
  } else if (values.length === 2) {
    const [minutes, secs] = values as [number, number];
    if (secs >= 60) return null;
    seconds = minutes * 60 + secs;
  } else {
    seconds = values[0]!;
  }
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function formatOffsetSeconds(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = Math.floor(safe % 60);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

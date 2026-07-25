// Client-side, cosmetic-only counterpart to sanitizeFilename in src/app.ts.
// The server ignores the actual content of the :filename route segment
// beyond routing on it, so this doesn't need to match exactly -- it just
// needs to produce something readable for VLC/downloads/copy-URL contexts.
function sanitizeFilenameClient(title: string): string {
  const sanitized = title
    .replace(/[^a-zA-Z0-9._\- ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return sanitized ? `${sanitized}.mp4` : "";
}

export function fileUrl(id: string, title: string, opts?: { download?: boolean }): string {
  const filename = sanitizeFilenameClient(title);
  const path = filename ? `/recordings/${id}/file/${encodeURIComponent(filename)}` : `/recordings/${id}/file`;
  return `${window.location.origin}${path}${opts?.download ? "?download=1" : ""}`;
}

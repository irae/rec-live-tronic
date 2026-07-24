// Shared VLC-deeplink + platform-detection helpers, used by both the main
// player (RecordingDetail.vue) and the cut-preview pieces (CutConsole.vue).
export function isIosDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

// iPadOS 13+ Safari reports its userAgent as a plain Mac, so exclude the
// touch-capable "MacIntel" case (real Macs aren't multi-touch) to avoid
// mistaking an iPad for a desktop Mac.
export function isMacDevice(): boolean {
  return !isIosDevice() && /Macintosh|Mac OS X/.test(navigator.userAgent) && navigator.maxTouchPoints <= 1;
}

export function vlcUrlFor(streamUrl: string): string {
  if (isMacDevice()) return `vlc://${streamUrl}`;
  return `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(streamUrl)}`;
}

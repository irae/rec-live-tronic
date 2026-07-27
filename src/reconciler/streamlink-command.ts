import type { Config } from "../config.js";
import type { Recording } from "../recordings/repository.js";

const quality = /^(best|worst|(?:360|480|720|1080)p)$/;

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new TypeError("Invalid recorder URL");
  return url.toString();
}

export function buildStreamlinkArgs(recording: Recording): string[] {
  if (!quality.test(recording.quality)) throw new TypeError("Invalid recorder quality");
  const args = [
    "--hls-live-restart",
    "--retry-streams",
    "5",
    "--retry-max",
    "0",
    // YouTube HLS segments are short (~1-4s), so the default 3x-targetduration
    // deadline (streamlink 8.1+; formerly --hls-segment-queue-threshold) trips
    // after roughly 6-15s of missing segments and aborts the stream even
    // though YouTube's own live DVR buffer can often cover much longer gaps.
    // Raising the factor lets a transient server-side hiccup (the routine
    // cause of "Stream ended" restarts seen in production) resolve itself
    // without streamlink exiting at all, at the cost of a slower reaction if
    // the stream has genuinely ended for good.
    "--stream-segmented-queue-deadline",
    "12",
    // Backstop for non-HLS-specific stalls (used if the deadline above
    // doesn't apply): comfortably longer than the deadline's own worst-case
    // coverage above, instead of the 60s default's razor-thin margin.
    "--stream-timeout",
    "120",
    "--progress",
    "no",
  ];
  if (recording.cookiePath) args.push("--http-cookies-file", "/run/rec-live-tronic/streamlink-cookie");
  args.push("--stdout", safeUrl(recording.url), recording.quality);
  return args;
}

export function buildTransientProperties(recording: Recording, config: Config, runtimeMaxSeconds: number): string[] {
  if (!Number.isSafeInteger(runtimeMaxSeconds) || runtimeMaxSeconds < 1) throw new TypeError("Invalid runtime maximum");
  const properties = [
    `RuntimeMaxSec=${runtimeMaxSeconds}`,
    "KillMode=control-group",
    `TimeoutStopSec=${config.stopTimeoutSeconds}`,
    "Restart=no",
    "UMask=0007",
    `StandardOutput=append:${recording.tsPath}`,
    `StandardError=append:${config.recordingsDir}/${recording.id}.log`,
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "Environment=HOME=/tmp",
    `ReadWritePaths=${config.recordingsDir}`,
    `InaccessiblePaths=${config.dataDir}`,
  ];
  if (recording.cookiePath) properties.push(`BindReadOnlyPaths=${recording.cookiePath}:/run/rec-live-tronic/streamlink-cookie`);
  return properties;
}

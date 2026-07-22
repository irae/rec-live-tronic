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
  const args = ["--hls-live-restart", "--retry-streams", "5", "--retry-max", "0", "--progress", "no"];
  if (recording.cookiePath) args.push("--http-cookie-file", "/run/rec-live-tronic/streamlink-cookie");
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
    "UMask=0027",
    `StandardOutput=append:${recording.tsPath}`,
    "StandardError=journal",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "ReadWritePaths=/dev/null",
    `InaccessiblePaths=${config.dataDir} ${config.recordingsDir}`,
  ];
  if (recording.cookiePath) properties.push(`BindReadOnlyPaths=${recording.cookiePath}:/run/rec-live-tronic/streamlink-cookie`);
  return properties;
}

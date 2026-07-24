import { isAbsolute, resolve } from "node:path";

const NODE_MAJOR = 24;

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  cookiesDir: string;
  recordingsDir: string;
  privateSocketPath: string;
  streamlinkBin: string;
  oembedEndpoint: string;
  reconcileIntervalSeconds: number;
  runtimeSafetySeconds: number;
  stopTimeoutSeconds: number;
}

type Environment = NodeJS.ProcessEnv;

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
  if (major !== NODE_MAJOR) {
    throw new Error(`rec-live-tronic requires Node.js ${NODE_MAJOR}.x; found ${version}`);
  }
}

function requiredAbsolutePath(value: string, name: string): string {
  if (!value || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return resolve(value);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function portNumber(value: string | undefined): number {
  if (value === undefined || value === "") return 8787;
  if (!/^\d+$/.test(value)) throw new Error("REC_LIVE_PORT must be an integer between 0 and 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("REC_LIVE_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function loadConfig(env: Environment = process.env): Config {
  const dataDir = requiredAbsolutePath(env.REC_LIVE_DATA_DIR ?? "/var/lib/rec-live-tronic", "REC_LIVE_DATA_DIR");
  const host = env.REC_LIVE_HOST ?? "0.0.0.0";
  if (!host.trim() || /[\u0000\r\n]/.test(host)) {
    throw new Error("REC_LIVE_HOST must be a non-empty listen address");
  }

  return {
    host,
    port: portNumber(env.REC_LIVE_PORT),
    dataDir,
    databasePath: requiredAbsolutePath(env.REC_LIVE_DATABASE_PATH ?? `${dataDir}/rec-live-tronic.sqlite`, "REC_LIVE_DATABASE_PATH"),
    cookiesDir: requiredAbsolutePath(env.REC_LIVE_COOKIES_DIR ?? `${dataDir}/cookies`, "REC_LIVE_COOKIES_DIR"),
    recordingsDir: requiredAbsolutePath(env.REC_LIVE_RECORDINGS_DIR ?? "/srv/rec-live-tronic/recordings", "REC_LIVE_RECORDINGS_DIR"),
    privateSocketPath: requiredAbsolutePath(env.REC_LIVE_PRIVATE_SOCKET ?? "/run/rec-live-tronic/api.sock", "REC_LIVE_PRIVATE_SOCKET"),
    streamlinkBin: requiredAbsolutePath(env.REC_LIVE_STREAMLINK_BIN ?? "/usr/local/bin/streamlink", "REC_LIVE_STREAMLINK_BIN"),
    oembedEndpoint: env.REC_LIVE_OEMBED_ENDPOINT ?? "https://www.youtube.com/oembed",
    reconcileIntervalSeconds: positiveInteger(env.REC_LIVE_RECONCILE_INTERVAL_SECONDS, 10, "REC_LIVE_RECONCILE_INTERVAL_SECONDS"),
    runtimeSafetySeconds: positiveInteger(env.REC_LIVE_RUNTIME_SAFETY_SECONDS, 120, "REC_LIVE_RUNTIME_SAFETY_SECONDS"),
    stopTimeoutSeconds: positiveInteger(env.REC_LIVE_STOP_TIMEOUT_SECONDS, 30, "REC_LIVE_STOP_TIMEOUT_SECONDS"),
  };
}

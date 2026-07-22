import { constants, realpathSync } from "node:fs";
import { access, chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createApp, type HealthReport } from "./app.js";
import { RecorderService } from "./api/service.js";
import { CookieRepository } from "./cookies/repository.js";
import { assertSupportedNodeVersion, loadConfig, type Config } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { migrateDatabase } from "./db/migrate.js";
import { RecordingRepository } from "./recordings/repository.js";
import { UserSystemdClient } from "./systemd/client.js";

export interface RunningServer {
  close(): Promise<void>;
  publicServer: Server;
  privateServer: Server;
}

function listen(server: Server, options: Parameters<Server["listen"]>[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export async function startServer(config: Config = loadConfig(), nodeVersion = process.versions.node): Promise<RunningServer> {
  assertSupportedNodeVersion(nodeVersion);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.cookiesDir, { recursive: true, mode: 0o700 });
  await mkdir(config.recordingsDir, { recursive: true, mode: 0o750 });
  await mkdir(dirname(config.privateSocketPath), { recursive: true, mode: 0o750 });

  const database = openDatabase(config.databasePath);
  migrateDatabase(database);
  const health = async (): Promise<HealthReport> => {
    let sqlite: HealthReport["sqlite"] = "ok";
    let recordings: HealthReport["recordings"] = "ok";
    try {
      database.prepare("SELECT 1").get();
    } catch {
      sqlite = "error";
    }
    try {
      await access(config.recordingsDir);
    } catch {
      recordings = "error";
    }
    let dependencies: HealthReport["dependencies"] = "ok";
    try {
      await access(config.streamlinkBin, constants.X_OK);
    } catch {
      dependencies = "error";
    }
    return { process: "ok", sqlite, recordings, dependencies };
  };

  const recorder = new RecorderService(new RecordingRepository(database), new CookieRepository(database), config, new UserSystemdClient());
  const publicServer = createServer(createApp({ health, recorder }));
  const privateServer = createServer(createApp({ health, recorder, privateApi: true }));
  try {
    await rm(config.privateSocketPath, { force: true });
    await listen(publicServer, { host: config.host, port: config.port });
    await listen(privateServer, config.privateSocketPath);
    await chmod(config.privateSocketPath, 0o600);
  } catch (error) {
    publicServer.close();
    privateServer.close();
    database.close();
    throw error;
  }

  return {
    publicServer,
    privateServer,
    async close(): Promise<void> {
      await Promise.all([close(publicServer), close(privateServer)]);
      database.close();
      await rm(config.privateSocketPath, { force: true });
    },
  };
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  startServer().then(
    () => undefined,
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

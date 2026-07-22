import { readFile } from "node:fs/promises";
import { assertSupportedNodeVersion, loadConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { RecordingRepository } from "../recordings/repository.js";
import { UserSystemdClient } from "../systemd/client.js";
import { createPrivateTransitionClient, reconcileOnce } from "./reconcile-once.js";

export async function runOnce(): Promise<void> {
  assertSupportedNodeVersion();
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  try {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const summary = await reconcileOnce(new Date(), bootId, {
      config,
      recordings: new RecordingRepository(database),
      systemd: new UserSystemdClient(),
      transition: await createPrivateTransitionClient(config.privateSocketPath),
    });
    console.log(JSON.stringify({ event: "reconcile_complete", ...summary }));
  } finally { database.close(); }
}

function isMainModule(): boolean { return process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href; }
if (isMainModule()) runOnce().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

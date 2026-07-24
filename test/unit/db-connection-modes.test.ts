import t from "tap";
import { mkdtemp, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";

t.test("openDatabase preserves a pre-existing setgid bit on the data directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-conn-"));
  const dataDir = join(root, "state");
  const databasePath = join(dataDir, "rec-live-tronic.sqlite");
  try {
    // Simulate install-root.sh's `install -d -m 2770` provisioning the
    // directory with the setgid bit before the app ever opens the DB.
    await chmod(root, 0o755);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dataDir, { recursive: true });
    await chmod(dataDir, 0o2770);

    const before = (await stat(dataDir)).mode & 0o7777;
    t.equal(before, 0o2770, "precondition: directory starts setgid 2770");

    const database = openDatabase(databasePath);
    database.close();

    const after = (await stat(dataDir)).mode & 0o7777;
    t.equal(after, 0o2770, "openDatabase must not strip the setgid bit from an already-provisioned data directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

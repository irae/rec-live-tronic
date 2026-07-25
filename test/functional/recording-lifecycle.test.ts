import t from "tap";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server.js";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { RecordingRepository, type Recording } from "../../src/recordings/repository.js";
import { CutDraftRepository } from "../../src/recordings/cut-draft-repository.js";
import { CookieRepository } from "../../src/cookies/repository.js";
import { RecorderService } from "../../src/api/service.js";
import type { SystemdClient } from "../../src/systemd/client.js";
import { createPrivateTransitionClient, reconcileOnce } from "../../src/reconciler/reconcile-once.js";
import { buildTransientProperties } from "../../src/reconciler/streamlink-command.js";

const execFileAsync = promisify(execFile);

class SystemdStub implements SystemdClient {
  readonly live = new Set<string>();
  readonly loaded = new Set<string>();
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  readonly caps = new Map<string, number>();
  confirmStops = true;
  supportsRuntimeUpdate = true;
  async listRecordingUnits(): Promise<Set<string>> { return new Set(this.live); }
  async startRecording(recording: Recording, _config: Config, runtime: number): Promise<void> { this.starts.push(recording.unitName); this.live.add(recording.unitName); this.loaded.add(recording.unitName); this.caps.set(recording.unitName, runtime); }
  async stopRecording(unitName: string): Promise<{ confirmed: boolean }> { this.stops.push(unitName); if (this.confirmStops) this.live.delete(unitName); return { confirmed: this.confirmStops }; }
  async inspectRecordingUnit(unitName: string): Promise<{ active: boolean }> { return { active: this.live.has(unitName) }; }
  async updateRuntimeMax(unitName: string, seconds: number): Promise<boolean> { if (this.supportsRuntimeUpdate) this.caps.set(unitName, seconds); return this.supportsRuntimeUpdate; }
}

let root = "";
let running: RunningServer;
let config: Config;
let recordings: RecordingRepository;
let systemd: SystemdStub;

async function createRecording(startAt: string, stopAt: string): Promise<{ id: string; version: number }> {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") throw new Error("No public listener");
  const response = await fetch(`http://127.0.0.1:${address.port}/recordings`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=lifecycle", title: "Lifecycle", start_at: startAt, stop_at: stopAt }),
  });
  if (response.status !== 201) throw new Error(`Could not schedule recording: ${await response.text()}`);
  return (await response.json() as { recording: { id: string; version: number } }).recording;
}

async function tick(now: string): Promise<void> {
  await reconcileOnce(new Date(now), "boot-a", { config, recordings, systemd, transition: await createPrivateTransitionClient(config.privateSocketPath) });
}

t.before(async () => {
  root = await mkdtemp(join(tmpdir(), "rec-live-tronic-lifecycle-"));
  const streamlink = join(root, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  config = loadConfig({ REC_LIVE_HOST: "127.0.0.1", REC_LIVE_PORT: "0", REC_LIVE_DATA_DIR: join(root, "state"), REC_LIVE_RECORDINGS_DIR: join(root, "recordings"), REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"), REC_LIVE_STREAMLINK_BIN: streamlink, REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed" });
  running = await startServer(config, "24.0.0");
  recordings = new RecordingRepository(openDatabase(config.databasePath));
  systemd = new SystemdStub();
});

t.teardown(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });

t.test("records a scheduled window and stops it at the durable deadline", async (t) => {
  const created = await createRecording("2030-01-01T00:00:00Z", "2030-01-01T00:10:00Z");
  const scheduled = recordings.getById(created.id);
  if (!scheduled) throw new Error("missing scheduled recording");
  const properties = buildTransientProperties(scheduled, config, 60);
  t.ok(properties.includes("Environment=HOME=/tmp"));
  t.ok(properties.includes(`ReadWritePaths=${config.recordingsDir}`));
  t.ok(properties.includes(`InaccessiblePaths=${config.dataDir}`));
  t.notMatch(properties.join("\n"), new RegExp(`InaccessiblePaths=.*${config.recordingsDir}`));
  await tick("2030-01-01T00:01:00Z");
  t.same(systemd.starts, [`${created.id}.service`]);
  t.equal(systemd.caps.get(`${created.id}.service`), 660);
  t.equal(recordings.getById(created.id)?.status, "recording");
  const live = recordings.getById(created.id);
  if (!live) throw new Error("missing recording");
  recordings.updateScheduledDetails(created.id, live.version, { stopAt: "2030-01-01T00:20:00Z" });
  await tick("2030-01-01T00:02:00Z");
  t.equal(systemd.caps.get(`${created.id}.service`), 1_200);
  const extended = recordings.getById(created.id);
  if (!extended) throw new Error("missing extended recording");
  recordings.updateScheduledDetails(created.id, extended.version, { stopAt: "2030-01-01T00:05:00Z" });
  await tick("2030-01-01T00:03:00Z");
  t.equal(systemd.caps.get(`${created.id}.service`), 240);
  await writeFile(join(config.recordingsDir, `${created.id}.ts`), "capture");
  await tick("2030-01-01T00:10:01Z");
  t.match(systemd.stops, [`${created.id}.service`]);
  t.equal(recordings.getById(created.id)?.status, "recorded");
});

t.test("converges cancelled, missed, early-exit, and reboot recovery state", async (t) => {
  const missed = await createRecording("2030-01-02T00:00:00Z", "2030-01-02T00:01:00Z");
  await tick("2030-01-02T00:02:00Z");
  t.equal(recordings.getById(missed.id)?.status, "missed");

  const early = await createRecording("2030-01-03T00:00:00Z", "2030-01-03T00:10:00Z");
  await tick("2030-01-03T00:01:00Z");
  systemd.live.delete(`${early.id}.service`);
  await tick("2030-01-03T00:02:00Z");
  const earlyRow = recordings.getById(early.id);
  t.equal(earlyRow?.status, "failed");
  // The stream ended early (unit gone before the scheduled 00:10 stop), so
  // stop_at is corrected to the reconcile tick time (00:02) rather than the
  // original schedule.
  t.equal(earlyRow?.stopAt, "2030-01-03T00:02:00.000Z", "stop_at reflects the early-stop time, not the schedule");

  const cancelled = await createRecording("2030-01-03T01:00:00Z", "2030-01-03T01:10:00Z");
  await tick("2030-01-03T01:01:00Z");
  const cancelledRow = recordings.getById(cancelled.id);
  if (!cancelledRow) throw new Error("missing cancelled recording");
  await (await createPrivateTransitionClient(config.privateSocketPath))(cancelledRow, "cancelled");
  await tick("2030-01-03T01:02:00Z");
  t.ok(systemd.stops.includes(`${cancelled.id}.service`));

  const reboot = await createRecording("2030-01-04T00:00:00Z", "2030-01-04T00:10:00Z");
  const row = recordings.getById(reboot.id);
  if (!row) throw new Error("missing reboot recording");
  await (await createPrivateTransitionClient(config.privateSocketPath))(row, "recording", "old-boot");
  await tick("2030-01-04T00:02:00Z");
  t.ok(systemd.starts.includes(`${reboot.id}.service`));
  t.equal(recordings.getById(reboot.id)?.status, "recording");
  systemd.live.delete(`${reboot.id}.service`);
  await tick("2030-01-04T00:03:00Z");
  t.equal(recordings.getById(reboot.id)?.status, "failed");
});

t.test("adopts a scheduled live unit with a fresh backstop without refreshing active units", async (t) => {
  const adopted = await createRecording("2030-01-04T01:00:00Z", "2030-01-04T01:10:00Z");
  const unitName = `${adopted.id}.service`;
  systemd.live.add(unitName);
  systemd.loaded.add(unitName);
  systemd.caps.set(unitName, 1);
  await tick("2030-01-04T01:01:00Z");
  t.equal(systemd.caps.get(unitName), 660);
  t.equal(recordings.getById(adopted.id)?.status, "recording");
  const before = systemd.starts.filter((name) => name === unitName).length;
  await tick("2030-01-04T01:02:00Z");
  t.equal(systemd.starts.filter((name) => name === unitName).length, before);
});

t.test("fails visibly when an elapsed or cancelled unit does not become inactive", async (t) => {
  const elapsed = await createRecording("2030-01-05T00:00:00Z", "2030-01-05T00:01:00Z");
  await tick("2030-01-05T00:00:30Z");
  systemd.confirmStops = false;
  await t.rejects(tick("2030-01-05T00:01:01Z"), /Timed out stopping/);
  t.equal(recordings.getById(elapsed.id)?.status, "recording");
  systemd.confirmStops = true;
  const cancelled = await createRecording("2030-01-05T01:00:00Z", "2030-01-05T01:10:00Z");
  await tick("2030-01-05T01:01:00Z");
  const row = recordings.getById(cancelled.id);
  if (!row) throw new Error("missing cancellation");
  await (await createPrivateTransitionClient(config.privateSocketPath))(row, "cancelled");
  systemd.confirmStops = false;
  await t.rejects(tick("2030-01-05T01:02:00Z"), /Timed out stopping/);
  systemd.confirmStops = true;
});

t.test("live stop-time updates relaunch only after a confirmed stop", async (t) => {
  const start = new Date(Date.now() + 60_000).toISOString();
  const initialStop = new Date(Date.now() + 120_000).toISOString();
  const created = await createRecording(start, initialStop);
  const row = recordings.getById(created.id);
  if (!row) throw new Error("missing live patch recording");
  await (await createPrivateTransitionClient(config.privateSocketPath))(row, "recording", "boot-a");
  const beforeStops = systemd.stops.length;
  const beforeStarts = systemd.starts.length;
  const newStop = new Date(Date.now() + 600_000).toISOString();
  const apiDatabase = openDatabase(config.databasePath);
  try {
    const service = new RecorderService(recordings, new CookieRepository(apiDatabase), config, systemd, new CutDraftRepository(apiDatabase));
    const result = await service.patchRecording(created.id, { stop_at: newStop });
    t.same(result.stop, { attempted: true, confirmed: true });
    t.equal(result.relaunched, true);
    t.equal(systemd.stops.length, beforeStops + 1);
    t.equal(systemd.starts.length, beforeStarts + 1);
    t.type(systemd.caps.get(`${created.id}.service`), "number");
    t.ok((systemd.caps.get(`${created.id}.service`) ?? 0) >= 719);
    t.equal(recordings.getById(created.id)?.lastStartedStopAt, newStop);

    systemd.confirmStops = false;
    const blockedStop = new Date(Date.now() + 900_000).toISOString();
    const blocked = await service.patchRecording(created.id, { stop_at: blockedStop });
    t.same(blocked.stop, { attempted: true, confirmed: false });
    t.equal(blocked.relaunched, false);
    t.equal(systemd.starts.length, beforeStarts + 1);
    t.equal(recordings.getById(created.id)?.lastStartedStopAt, newStop);
    systemd.confirmStops = true;
    await tick(new Date(Date.now() + 120_000).toISOString());
    t.equal(systemd.starts.length, beforeStarts + 2);
    t.equal(recordings.getById(created.id)?.lastStartedStopAt, blockedStop);
  } finally { apiDatabase.close(); }
});

t.test("reconciler ignores a trashed recording even if its window is still active", async (t) => {
  const start = new Date(Date.now() + 60_000).toISOString();
  const stop = new Date(Date.now() + 120_000).toISOString();
  const created = await createRecording(start, stop);
  const row = recordings.getById(created.id);
  if (!row) throw new Error("missing trashed recording");
  const beforeStarts = systemd.starts.length;
  const beforeStops = systemd.stops.length;
  const beforeTransitions = 0;
  const apiDatabase = openDatabase(config.databasePath);
  try {
    apiDatabase.prepare("UPDATE recordings SET trashed_at = ? WHERE id = ?").run(Date.now(), created.id);
    const trashedRow = recordings.getById(created.id);
    if (!trashedRow) throw new Error("trashed recording not found");
    t.ok(trashedRow.trashedAt !== null, "recording should be marked as trashed");
    await tick(new Date(Date.now() + 70_000).toISOString());
    t.equal(systemd.starts.length, beforeStarts, "no start should be called for trashed recording");
    t.equal(systemd.stops.length, beforeStops, "no stop should be called for trashed recording");
    t.equal(recordings.getById(created.id)?.status, "scheduled", "status should remain unchanged");
  } finally { apiDatabase.close(); }
});

t.test("a purge racing an in-flight remux does not leave an orphaned .mp4 on disk", async (t) => {
  const orphanRoot = await mkdtemp(join(tmpdir(), "rec-live-tronic-orphan-"));
  try {
    const recordingsDir = join(orphanRoot, "recordings");
    await mkdir(recordingsDir, { recursive: true });
    const databasePath = join(orphanRoot, "state", "rec-live-tronic.sqlite3");
    const database = openDatabase(databasePath);
    migrateDatabase(database);

    const ffmpegBin = process.env.REC_LIVE_TEST_FFMPEG_BIN ?? "ffmpeg";
    const ffprobeBin = process.env.REC_LIVE_TEST_FFPROBE_BIN ?? "ffprobe";
    const orphanConfig: Config = {
      host: "127.0.0.1", port: 0, dataDir: join(orphanRoot, "state"), databasePath,
      cookiesDir: join(orphanRoot, "cookies"), recordingsDir,
      privateSocketPath: join(orphanRoot, "run", "api.sock"),
      streamlinkBin: "streamlink", ffmpegBin, ffprobeBin,
      oembedEndpoint: "http://127.0.0.1:1/oembed",
      reconcileIntervalSeconds: 30, runtimeSafetySeconds: 60, stopTimeoutSeconds: 30,
    };

    const testRecordings = new RecordingRepository(database);
    const service = new RecorderService(testRecordings, new CookieRepository(database), orphanConfig, new SystemdStub(), new CutDraftRepository(database));

    const id = "rec-orphantest";
    const tsPath = join(recordingsDir, `${id}.ts`);
    // A tiny real MPEG-TS source so remuxToMp4 exercises real ffmpeg/ffprobe.
    await execFileAsync(ffmpegBin, [
      "-y", "-f", "lavfi", "-i", "testsrc2=duration=1:size=64x64:rate=10",
      "-f", "lavfi", "-i", "anullsrc=duration=1",
      "-c:v", "libx264", "-c:a", "aac", "-f", "mpegts", tsPath,
    ]);
    testRecordings.create({
      id, url: "https://www.youtube.com/watch?v=orphan", title: "Orphan",
      quality: "best", startAt: "2030-01-01T00:00:00Z", stopAt: "2030-01-01T00:10:00Z",
      status: "recorded", unitName: `${id}.service`, tsPath,
    });

    // Simulates the exact race: purgeOne deletes the row and unlinks the .ts
    // WHILE remuxToMp4 is still running; by the time remuxRecording calls
    // updateTsPath, the row is already gone. Patching updateTsPath to delete
    // the row immediately before running its real SQL reproduces that
    // ordering without needing a slow/blocking ffmpeg stub.
    const originalUpdateTsPath = testRecordings.updateTsPath.bind(testRecordings);
    testRecordings.updateTsPath = (recordingId, newTsPath, now) => {
      database.prepare("DELETE FROM recordings WHERE id = ?").run(recordingId);
      return originalUpdateTsPath(recordingId, newTsPath, now);
    };

    const result = await service.remuxRecording(id);
    t.equal(result, "skipped", "remux reports skipped when the row disappeared mid-flight");

    const outputPath = join(recordingsDir, `${id}.mp4`);
    t.equal(existsSync(outputPath), false, "the orphaned .mp4 must not survive on disk");
    t.equal(testRecordings.getById(id), undefined, "row stays gone");

    database.close();
  } finally {
    await rm(orphanRoot, { recursive: true, force: true });
  }
});

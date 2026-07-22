import t from "tap";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server.js";
import { openDatabase } from "../../src/db/connection.js";
import { RecordingRepository, type Recording } from "../../src/recordings/repository.js";
import { CookieRepository } from "../../src/cookies/repository.js";
import { RecorderService } from "../../src/api/service.js";
import type { SystemdClient } from "../../src/systemd/client.js";
import { createPrivateTransitionClient, reconcileOnce } from "../../src/reconciler/reconcile-once.js";

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
  config = loadConfig({ REC_LIVE_HOST: "127.0.0.1", REC_LIVE_PORT: "0", REC_LIVE_DATA_DIR: join(root, "state"), REC_LIVE_RECORDINGS_DIR: join(root, "recordings"), REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"), REC_LIVE_STREAMLINK_BIN: streamlink });
  running = await startServer(config, "24.0.0");
  recordings = new RecordingRepository(openDatabase(config.databasePath));
  systemd = new SystemdStub();
});

t.teardown(async () => { await running.close(); await rm(root, { recursive: true, force: true }); });

t.test("records a scheduled window and stops it at the durable deadline", async (t) => {
  const created = await createRecording("2030-01-01T00:00:00Z", "2030-01-01T00:10:00Z");
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
  t.equal(recordings.getById(early.id)?.status, "failed");

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
    const service = new RecorderService(recordings, new CookieRepository(apiDatabase), config, systemd);
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

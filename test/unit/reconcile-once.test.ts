import t from "tap";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileOnce, type ReconcileDependencies } from "../../src/reconciler/reconcile-once.js";
import type { Recording, RecordingStatus } from "../../src/recordings/repository.js";
import type { Config } from "../../src/config.js";
import type { SystemdClient } from "../../src/systemd/client.js";

// A tsPath that never exists on disk, so hasOutput() resolves ENOENT -> false
// and every complete() lands on "failed" -- keeps these cases about which
// transition arguments fire, not about file I/O.
const missingTsPath = join(tmpdir(), "rec-live-tronic-nonexistent-unit-test.ts");

const baseConfig = { runtimeSafetySeconds: 60 } as unknown as Config;

function makeRecording(overrides: Partial<Recording>): Recording {
  return {
    id: "rec-unit",
    url: "https://www.youtube.com/watch?v=unit",
    title: "Unit",
    stage: null, artist: null, venue: null, event: null,
    trashedAt: null, cookieId: null, cookiePath: null, cutFromId: null,
    quality: "best",
    startAt: "2030-01-01T00:00:00.000Z",
    stopAt: "2030-01-01T01:00:00.000Z",
    status: "recording",
    unitName: "rec-unit.service",
    tsPath: missingTsPath,
    lastStartedBootId: "boot-a",
    lastStartedStopAt: "2030-01-01T01:00:00.000Z",
    version: 1,
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface TransitionCall { id: string; status: RecordingStatus; bootId?: string; startedStopAt?: string; correctedStopAt?: string }

function makeDeps(recording: Recording, liveUnits: string[]): { deps: ReconcileDependencies; calls: TransitionCall[]; starts: string[] } {
  const calls: TransitionCall[] = [];
  const starts: string[] = [];
  const systemd: SystemdClient = {
    async listRecordingUnits() { return new Set(liveUnits); },
    async startRecording(rec) { starts.push(rec.unitName); },
    async stopRecording(unitName) { return { confirmed: true }; },
    async inspectRecordingUnit() { return { active: false }; },
    async updateRuntimeMax() { return true; },
  };
  const deps: ReconcileDependencies = {
    config: baseConfig,
    recordings: { list: () => [recording] },
    systemd,
    async transition(rec, status, bootId, startedStopAt, correctedStopAt) {
      calls.push({ id: rec.id, status, bootId, startedStopAt, correctedStopAt });
      return "updated";
    },
  };
  return { deps, calls, starts };
}

t.test("corrects stop_at to now when a live unit exits early on the same boot", async (t) => {
  // status "recording", now < stop_at (active, not elapsed), unit NOT live,
  // lastStartedBootId === bootId, lastStartedStopAt === stopAt -> the sole
  // early-unforced-stop branch.
  const recording = makeRecording({});
  const { deps, calls, starts } = makeDeps(recording, []);
  const now = new Date("2030-01-01T00:30:00.000Z");
  await reconcileOnce(now, "boot-a", deps);
  t.equal(calls.length, 1);
  t.equal(calls[0]?.status, "failed");
  t.equal(calls[0]?.correctedStopAt, now.toISOString(), "stop_at is corrected to now");
  t.same(starts, [], "no relaunch for a same-boot early exit");
  t.end();
});

t.test("does not correct stop_at when the reconciler force-stops at/after the schedule", async (t) => {
  // now >= stop_at (elapsed), unit not live -> complete() via the elapsed
  // gate, which must not carry a corrected stop_at.
  const recording = makeRecording({ stopAt: "2030-01-01T00:10:00.000Z" });
  const { deps, calls } = makeDeps(recording, []);
  await reconcileOnce(new Date("2030-01-01T00:20:00.000Z"), "boot-a", deps);
  t.equal(calls.length, 1);
  t.equal(calls[0]?.status, "failed");
  t.equal(calls[0]?.correctedStopAt, undefined, "elapsed force-stop leaves stop_at unchanged");
  t.end();
});

t.test("does not correct stop_at when adopting after a reboot", async (t) => {
  // active, not live, lastStartedBootId !== bootId -> relaunch + a
  // status "recording" transition, never a stop-time correction.
  const recording = makeRecording({ lastStartedBootId: "old-boot" });
  const { deps, calls, starts } = makeDeps(recording, []);
  await reconcileOnce(new Date("2030-01-01T00:30:00.000Z"), "boot-a", deps);
  t.same(starts, ["rec-unit.service"], "reboot adoption relaunches the unit");
  t.equal(calls.length, 1);
  t.equal(calls[0]?.status, "recording");
  t.equal(calls[0]?.correctedStopAt, undefined, "reboot adoption leaves stop_at unchanged");
  t.end();
});

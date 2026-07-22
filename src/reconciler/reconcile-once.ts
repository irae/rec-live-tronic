import { request } from "node:http";
import { stat } from "node:fs/promises";
import type { Config } from "../config.js";
import type { Recording, RecordingStatus } from "../recordings/repository.js";
import type { SystemdClient } from "../systemd/client.js";

export interface ReconcileSummary {
  started: number;
  stopped: number;
  transitioned: number;
  adopted: number;
}

export interface ReconcileDependencies {
  config: Config;
  recordings: { list(): Recording[] };
  systemd: SystemdClient;
  transition(recording: Recording, status: RecordingStatus, bootId?: string, startedStopAt?: string): Promise<"updated" | "conflict" | "not_found">;
}

export async function createPrivateTransitionClient(socketPath: string): Promise<ReconcileDependencies["transition"]> {
  return async (recording, status, bootId, startedStopAt) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ expected_status: recording.status, expected_version: recording.version, status, ...(bootId === undefined ? {} : { last_started_boot_id: bootId }), ...(startedStopAt === undefined ? {} : { last_started_stop_at: startedStopAt }) });
    const req = request({ socketPath, path: `/internal/recordings/${encodeURIComponent(recording.id)}/transition`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode === 200) resolve("updated");
        else if (response.statusCode === 404) resolve("not_found");
        else if (response.statusCode === 409) resolve("conflict");
        else reject(new Error(`private transition API returned ${response.statusCode}`));
      });
    });
    req.once("error", reject);
    req.end(body);
  });
}

async function hasOutput(recording: Recording): Promise<boolean> {
  try { const result = await stat(recording.tsPath); return result.isFile() && result.size > 0; } catch { return false; }
}

async function complete(recording: Recording, deps: ReconcileDependencies, summary: ReconcileSummary): Promise<void> {
  const outcome = await deps.transition(recording, (await hasOutput(recording)) ? "recorded" : "failed");
  if (outcome === "updated") summary.transitioned += 1;
}

function runtimeCap(stop: number, now: number, safety: number): number {
  return Math.max(1, Math.ceil((stop - now) / 1000) + safety);
}

async function relaunchWithFreshCap(recording: Recording, cap: number, deps: ReconcileDependencies, summary: ReconcileSummary): Promise<void> {
  const stopped = await deps.systemd.stopRecording(recording.unitName);
  if (!stopped.confirmed) throw new Error(`Could not safely relaunch ${recording.unitName}`);
  await deps.systemd.startRecording(recording, deps.config, cap);
  summary.stopped += 1;
  summary.started += 1;
}

export async function reconcileOnce(now: Date, bootId: string, deps: ReconcileDependencies): Promise<ReconcileSummary> {
  if (!Number.isFinite(now.getTime()) || !bootId.trim()) throw new TypeError("A valid time and boot ID are required");
  const summary: ReconcileSummary = { started: 0, stopped: 0, transitioned: 0, adopted: 0 };
  const units = await deps.systemd.listRecordingUnits();
  const recordings = deps.recordings.list();
  const nowMs = now.getTime();
  for (const recording of recordings) {
    const start = Date.parse(recording.startAt);
    const stop = Date.parse(recording.stopAt);
    const live = units.has(recording.unitName);
    const active = start <= nowMs && nowMs < stop;
    const elapsed = nowMs >= stop;
    if (recording.status === "cancelled") {
      if (live) {
        const stopped = await deps.systemd.stopRecording(recording.unitName);
        if (!stopped.confirmed) throw new Error(`Timed out stopping ${recording.unitName}`);
        summary.stopped += 1;
      }
      continue;
    }
    if (recording.status === "scheduled") {
      if (active && !live) {
        await deps.systemd.startRecording(recording, deps.config, runtimeCap(stop, nowMs, deps.config.runtimeSafetySeconds));
        summary.started += 1;
        const outcome = await deps.transition(recording, "recording", bootId, recording.stopAt);
        if (outcome === "updated") summary.transitioned += 1;
        continue;
      }
      if (active && live) {
        await relaunchWithFreshCap(recording, runtimeCap(stop, nowMs, deps.config.runtimeSafetySeconds), deps, summary);
        const outcome = await deps.transition(recording, "recording", bootId, recording.stopAt);
        if (outcome === "updated") { summary.transitioned += 1; summary.adopted += 1; }
        continue;
      }
      if (elapsed) {
        if (live) {
          const stopped = await deps.systemd.stopRecording(recording.unitName);
          if (!stopped.confirmed) throw new Error(`Timed out stopping ${recording.unitName}`);
          summary.stopped += 1;
          await complete(recording, deps, summary);
        }
        else {
          const outcome = await deps.transition(recording, (await hasOutput(recording)) ? "recorded" : "missed");
          if (outcome === "updated") summary.transitioned += 1;
        }
      }
      continue;
    }
    if (recording.status !== "recording") continue;
    if (elapsed) {
      if (live) { const result = await deps.systemd.stopRecording(recording.unitName); if (!result.confirmed) throw new Error(`Timed out stopping ${recording.unitName}`); summary.stopped += 1; }
      await complete(recording, deps, summary);
      continue;
    }
    if (!active) continue;
    if (live && recording.lastStartedStopAt !== recording.stopAt) {
      await relaunchWithFreshCap(recording, runtimeCap(stop, nowMs, deps.config.runtimeSafetySeconds), deps, summary);
      const outcome = await deps.transition(recording, "recording", bootId, recording.stopAt);
      if (outcome === "updated") summary.transitioned += 1;
      continue;
    }
    if (live) {
      continue;
    } else if (recording.lastStartedBootId !== bootId) {
      await deps.systemd.startRecording(recording, deps.config, runtimeCap(stop, nowMs, deps.config.runtimeSafetySeconds));
      summary.started += 1;
      const outcome = await deps.transition(recording, "recording", bootId, recording.stopAt);
      if (outcome === "updated") summary.transitioned += 1;
    } else {
      await complete(recording, deps, summary);
    }
  }
  return summary;
}

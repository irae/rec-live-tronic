import { spawn } from "node:child_process";
import type { Recording } from "../recordings/repository.js";
import type { Config } from "../config.js";
import { buildStreamlinkArgs, buildTransientProperties } from "../reconciler/streamlink-command.js";

export interface StopResult { confirmed: boolean; }

export interface SystemdClient {
  listRecordingUnits(): Promise<Set<string>>;
  startRecording(recording: Recording, config: Config, runtimeMaxSeconds: number): Promise<void>;
  stopRecording(unitName: string): Promise<StopResult>;
  inspectRecordingUnit(unitName: string): Promise<{ active: boolean }>;
  updateRuntimeMax(unitName: string, seconds: number): Promise<boolean>;
}

export function assertRecordingUnitName(unitName: string): void {
  if (!/^rec-[a-f0-9]{32}\.service$/.test(unitName)) throw new TypeError("Invalid recording unit name");
}

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_096); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export class UserSystemdClient implements SystemdClient {
  async listRecordingUnits(): Promise<Set<string>> {
    const result = await run("systemctl", ["--user", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager", "rec-*.service"]);
    if (result.code !== 0) throw new Error(`systemctl could not list recording units: ${result.stderr}`);
    const candidates: string[] = [];
    for (const line of result.stdout.split("\n")) {
      const name = line.trim().split(/\s+/, 1)[0];
      if (name && /^rec-[a-f0-9]{32}\.service$/.test(name)) candidates.push(name);
    }
    const units = new Set<string>();
    for (const name of candidates) if ((await this.inspectRecordingUnit(name)).active) units.add(name);
    return units;
  }

  async startRecording(recording: Recording, config: Config, runtimeMaxSeconds: number): Promise<void> {
    assertRecordingUnitName(recording.unitName);
    const properties = buildTransientProperties(recording, config, runtimeMaxSeconds);
    const result = await run("systemd-run", ["--user", `--unit=${recording.unitName.slice(0, -".service".length)}`, "--collect", ...properties.map((property) => `--property=${property}`), "--", config.streamlinkBin, ...buildStreamlinkArgs(recording)]);
    if (result.code !== 0) throw new Error(`systemd-run failed to start ${recording.unitName}: ${result.stderr}`);
  }

  async inspectRecordingUnit(unitName: string): Promise<{ active: boolean }> {
    assertRecordingUnitName(unitName);
    const result = await run("systemctl", ["--user", "is-active", "--quiet", unitName]);
    if (result.code === 0) return { active: true };
    if (result.code === 3 || result.code === 4) return { active: false };
    throw new Error(`systemctl could not inspect ${unitName}: ${result.stderr}`);
  }

  async stopRecording(unitName: string): Promise<StopResult> {
    assertRecordingUnitName(unitName);
    const result = await run("systemctl", ["--user", "stop", unitName]);
    if (result.code !== 0) return { confirmed: false };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!(await this.inspectRecordingUnit(unitName)).active) return { confirmed: true };
      await delay(1_000);
    }
    return { confirmed: false };
  }

  async updateRuntimeMax(unitName: string, seconds: number): Promise<boolean> {
    assertRecordingUnitName(unitName);
    if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TypeError("Runtime maximum must be positive");
    return (await run("systemctl", ["--user", "set-property", "--runtime", unitName, `RuntimeMaxSec=${seconds}`])).code === 0;
  }
}

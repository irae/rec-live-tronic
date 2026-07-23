import t from "tap";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server.js";

let root = "";
let running: RunningServer;

t.before(async () => {
  root = await mkdtemp(join(tmpdir(), "rec-live-tronic-server-"));
  const streamlink = join(root, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  running = await startServer(loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(root, "state"),
    REC_LIVE_RECORDINGS_DIR: join(root, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
  }), "24.0.0");
});

t.test("rejects unsupported Node.js versions before opening resources", async (t) => {
  const config = loadConfig({
    REC_LIVE_DATA_DIR: join(root, "unsupported-state"),
    REC_LIVE_RECORDINGS_DIR: join(root, "unsupported-recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(root, "unsupported-run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: join(root, "streamlink"),
  });
  await t.rejects(startServer(config, "22.0.0"), /requires Node\.js 24\.x/);
});

t.teardown(async () => {
  await running.close();
  await rm(root, { recursive: true, force: true });
});

t.test("serves health with independent bootstrap checks", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  t.equal(response.status, 200);
  t.same(await response.json(), {
    status: "ok",
    checks: { process: "ok", sqlite: "ok", recordings: "ok", dependencies: "ok" },
  });
});

function privateRequest(socketPath: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const client = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(responseBody) }));
    });
    client.once("error", reject);
    client.end(payload);
  });
}

t.test("keeps reconciler transitions off TCP while accepting them on the private socket", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "private socket test",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { id: string; version: number } };
  const transitionPath = `/internal/recordings/${createdBody.recording.id}/transition`;
  const tcp = await fetch(`${base}${transitionPath}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  t.equal(tcp.status, 404);
  const privateResponse = await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "scheduled",
    expected_version: createdBody.recording.version,
    status: "recording",
  });
  t.equal(privateResponse.status, 200);
  t.match(privateResponse.body, { recording: { id: createdBody.recording.id, status: "recording", version: 1 } });
});

t.test("serves a finished recording's file", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "file serve test",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string; version: number } };
  const id = createdBody.recording.id;
  const transitionPath = `/internal/recordings/${id}/transition`;
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "scheduled",
    expected_version: createdBody.recording.version,
    status: "recording",
  });
  const recording = await fetch(`${base}/recordings/${id}`);
  const recordingBody = await recording.json() as { recording: { version: number } };
  const testContent = "test video content";
  await writeFile(join(root, "recordings", `${id}.ts`), testContent);
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  const fileResponse = await fetch(`${base}/recordings/${id}/file`);
  t.equal(fileResponse.status, 200);
  t.equal(fileResponse.headers.get("Content-Type"), "video/mp2t");
  const body = await fileResponse.text();
  t.equal(body, testContent);
});

t.test("404s a recording that does not exist", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const fileResponse = await fetch(`${base}/recordings/rec-nonexistent/file`);
  t.equal(fileResponse.status, 404);
  const body = await fileResponse.json() as { error: { code: string } };
  t.equal(body.error.code, "NOT_FOUND");
});

t.test("derives stage from a three-part title and leaves it null otherwise", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  async function schedule(title: string): Promise<string | null> {
    const created = await fetch(`${base}/recordings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.youtube.com/watch?v=phase03", title, start_at: "2099-01-01T00:00:00Z", stop_at: "2099-01-01T01:00:00Z" }),
    });
    t.equal(created.status, 201);
    return (await created.json() as { recording: { stage: string | null } }).recording.stage;
  }
  // Middle segment of the "Artist - Stage - Festival" convention.
  t.equal(await schedule("Artist - Main Stage - Festival"), "Main Stage");
  // No convention match and the oEmbed endpoint is unreachable in tests.
  t.equal(await schedule("just a freeform title"), null);
});

t.test("returns 409 for a recording that is still scheduled", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "scheduled test",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string } };
  const fileResponse = await fetch(`${base}/recordings/${createdBody.recording.id}/file`);
  t.equal(fileResponse.status, 409);
  const body = await fileResponse.json() as { error: { code: string } };
  t.equal(body.error.code, "STATUS_CONFLICT");
});

import t from "tap";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import { startServer, type RunningServer } from "../../src/server.js";
import { openDatabase } from "../../src/db/connection.js";

let root = "";
let running: RunningServer;
let config: Config;

t.before(async () => {
  root = await mkdtemp(join(tmpdir(), "rec-live-tronic-server-"));
  const streamlink = join(root, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  config = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(root, "state"),
    REC_LIVE_RECORDINGS_DIR: join(root, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
  });
  running = await startServer(config, "24.0.0");
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

t.test("moves a finished recording to trash instead of purging it", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=delete-test-1",
      title: "delete test 1",
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
  const testContent = "test video content for delete";
  const filePath = join(root, "recordings", `${id}.ts`);
  await writeFile(filePath, testContent);
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  const trashResponse = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(trashResponse.status, 204);
  const getAfterTrash = await fetch(`${base}/recordings/${id}`);
  t.equal(getAfterTrash.status, 200);
  const afterTrashBody = await getAfterTrash.json() as { recording: { trashedAt: string | null } };
  t.ok(afterTrashBody.recording.trashedAt !== null);
  const { existsSync } = await import("node:fs");
  t.equal(existsSync(filePath), true);
});

t.test("rejects deleting a recording that is not finished", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=delete-test-2",
      title: "delete test 2",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string } };
  const id = createdBody.recording.id;
  const deleteResponse = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(deleteResponse.status, 409);
  const deleteBody = await deleteResponse.json() as { error: { code: string } };
  t.equal(deleteBody.error.code, "STATUS_CONFLICT");
  const getAfterDelete = await fetch(`${base}/recordings/${id}`);
  t.equal(getAfterDelete.status, 200);
});

t.test("leaves no dangling row and no orphaned file after a permanent delete", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=delete-test-3",
      title: "delete test 3",
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
  const filePath = join(root, "recordings", `${id}.ts`);
  await writeFile(filePath, "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  const deleteResponse = await fetch(`${base}/recordings/${id}/trash`, { method: "DELETE" });
  t.equal(deleteResponse.status, 204);
  const getAfterDelete = await fetch(`${base}/recordings/${id}`);
  t.equal(getAfterDelete.status, 404);
  const { existsSync } = await import("node:fs");
  t.equal(existsSync(filePath), false);
});

t.test("excludes trashed recordings from the default and status-filtered listings", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=trash-filter-1",
      title: "trash filter 1",
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
  await writeFile(join(root, "recordings", `${id}.ts`), "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  const defaultList = await fetch(`${base}/recordings`);
  const defaultBody = await defaultList.json() as { recordings: { id: string }[] };
  const idsInDefault = defaultBody.recordings.map((r) => r.id);
  t.notOk(idsInDefault.includes(id));
  const statusList = await fetch(`${base}/recordings?status=recorded`);
  const statusBody = await statusList.json() as { recordings: { id: string }[] };
  const idsInStatus = statusBody.recordings.map((r) => r.id);
  t.notOk(idsInStatus.includes(id));
});

t.test("lists only trashed recordings via ?trashed=true", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=trash-list-1",
      title: "trash list 1",
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
  await writeFile(join(root, "recordings", `${id}.ts`), "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  const trashedList = await fetch(`${base}/recordings?trashed=true`);
  const trashedBody = await trashedList.json() as { recordings: { id: string }[] };
  const idsInTrash = trashedBody.recordings.map((r) => r.id);
  t.ok(idsInTrash.includes(id));
});

t.test("restores a trashed recording back into the archive listing", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=restore-1",
      title: "restore 1",
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
  await writeFile(join(root, "recordings", `${id}.ts`), "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  const restoreResponse = await fetch(`${base}/recordings/${id}/restore`, { method: "POST" });
  t.equal(restoreResponse.status, 200);
  const restoreBody = await restoreResponse.json() as { recording: { trashedAt: string | null } };
  t.equal(restoreBody.recording.trashedAt, null);
  const defaultList = await fetch(`${base}/recordings`);
  const defaultBody = await defaultList.json() as { recordings: { id: string }[] };
  const idsInDefault = defaultBody.recordings.map((r) => r.id);
  t.ok(idsInDefault.includes(id));
});

t.test("rejects restoring a recording that is not in trash", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=restore-reject-1",
      title: "restore reject 1",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string } };
  const id = createdBody.recording.id;
  const restoreResponse = await fetch(`${base}/recordings/${id}/restore`, { method: "POST" });
  t.equal(restoreResponse.status, 409);
});

t.test("permanently deletes a trashed recording's file and row", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=perm-delete-1",
      title: "perm delete 1",
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
  const filePath = join(root, "recordings", `${id}.ts`);
  await writeFile(filePath, "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  const permanentResponse = await fetch(`${base}/recordings/${id}/trash`, { method: "DELETE" });
  t.equal(permanentResponse.status, 204);
  const getAfterPermanent = await fetch(`${base}/recordings/${id}`);
  t.equal(getAfterPermanent.status, 404);
  const { existsSync } = await import("node:fs");
  t.equal(existsSync(filePath), false);
});

t.test("rejects permanent delete of a recording that is not in trash", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=perm-delete-reject-1",
      title: "perm delete reject 1",
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
  await writeFile(join(root, "recordings", `${id}.ts`), "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  const permanentResponse = await fetch(`${base}/recordings/${id}/trash`, { method: "DELETE" });
  t.equal(permanentResponse.status, 409);
});

t.test("rejects trashing a recording that is not finished", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=trash-reject-1",
      title: "trash reject 1",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string } };
  const id = createdBody.recording.id;
  const trashResponse = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(trashResponse.status, 409);
});

t.test("re-trashing an already-trashed recording is a no-op that does not reset its purge clock", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=re-trash-1",
      title: "re-trash 1",
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
  await writeFile(join(root, "recordings", `${id}.ts`), "test content");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });
  const firstTrash = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(firstTrash.status, 204);

  // Back-date trashed_at so a reset would be observable against "now".
  const backdated = Date.now() - 5 * 24 * 60 * 60 * 1000;
  const apiDatabase = openDatabase(config.databasePath);
  try {
    apiDatabase.prepare("UPDATE recordings SET trashed_at = ? WHERE id = ?").run(backdated, id);
  } finally {
    apiDatabase.close();
  }

  const secondTrash = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(secondTrash.status, 204);

  const afterSecondTrash = await fetch(`${base}/recordings/${id}`);
  const afterSecondTrashBody = await afterSecondTrash.json() as { recording: { trashedAt: string | null } };
  t.equal(afterSecondTrashBody.recording.trashedAt, new Date(backdated).toISOString());
});

t.test("purges only trash older than thirty days on the startup sweep", async (t) => {
  const sweepRoot = await mkdtemp(join(tmpdir(), "rec-live-tronic-sweep-"));
  const streamlink = join(sweepRoot, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const sweepConfig = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(sweepRoot, "state"),
    REC_LIVE_RECORDINGS_DIR: join(sweepRoot, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(sweepRoot, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
  });
  let sweepServer = await startServer(sweepConfig, "24.0.0");
  try {
    function base(server: RunningServer): string {
      const address = server.publicServer.address();
      if (!address || typeof address === "string") throw new Error("No public listener");
      return `http://127.0.0.1:${address.port}`;
    }

    async function createTrashedRecording(urlSuffix: string): Promise<string> {
      const created = await fetch(`${base(sweepServer)}/recordings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `https://www.youtube.com/watch?v=${urlSuffix}`,
          title: urlSuffix,
          start_at: "2099-01-01T00:00:00Z",
          stop_at: "2099-01-01T01:00:00Z",
        }),
      });
      const createdBody = await created.json() as { recording: { id: string; version: number } };
      const id = createdBody.recording.id;
      const transitionPath = `/internal/recordings/${id}/transition`;
      await privateRequest(join(sweepRoot, "run", "api.sock"), transitionPath, {
        expected_status: "scheduled",
        expected_version: createdBody.recording.version,
        status: "recording",
      });
      const recording = await fetch(`${base(sweepServer)}/recordings/${id}`);
      const recordingBody = await recording.json() as { recording: { version: number } };
      await writeFile(join(sweepRoot, "recordings", `${id}.ts`), "test content");
      await privateRequest(join(sweepRoot, "run", "api.sock"), transitionPath, {
        expected_status: "recording",
        expected_version: recordingBody.recording.version,
        status: "recorded",
      });
      await fetch(`${base(sweepServer)}/recordings/${id}/file`, { method: "DELETE" });
      return id;
    }

    const oldId = await createTrashedRecording("sweep-old");
    const youngId = await createTrashedRecording("sweep-young");

    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;
    const sweepDatabase = openDatabase(sweepConfig.databasePath);
    try {
      sweepDatabase.prepare("UPDATE recordings SET trashed_at = ? WHERE id = ?").run(thirtyOneDaysAgo, oldId);
      sweepDatabase.prepare("UPDATE recordings SET trashed_at = ? WHERE id = ?").run(oneDayAgo, youngId);
    } finally {
      sweepDatabase.close();
    }

    await sweepServer.close();
    sweepServer = await startServer(sweepConfig, "24.0.0");

    const trashedList = await fetch(`${base(sweepServer)}/recordings?trashed=true`);
    const trashedBody = await trashedList.json() as { recordings: { id: string }[] };
    const idsInTrash = trashedBody.recordings.map((r) => r.id);
    t.notOk(idsInTrash.includes(oldId), "recording trashed over thirty days ago is purged");
    t.ok(idsInTrash.includes(youngId), "recording trashed under thirty days ago survives the sweep");

    const { existsSync } = await import("node:fs");
    t.equal(existsSync(join(sweepRoot, "recordings", `${oldId}.ts`)), false);
    t.equal(existsSync(join(sweepRoot, "recordings", `${youngId}.ts`)), true);
  } finally {
    await sweepServer.close();
    await rm(sweepRoot, { recursive: true, force: true });
  }
});

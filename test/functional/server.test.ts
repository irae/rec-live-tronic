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

// Stands in for a real ffmpeg -c copy extraction: since test fixtures are
// plain-text stand-ins for .ts media (not real transport streams), the stub
// just copies the argv-provided input (after -i) to the argv-provided output
// (the final argument) rather than actually transcoding anything.
const ffmpegStubScript = `#!/bin/sh
input=""
prev=""
output=""
for arg in "$@"; do
  if [ "$prev" = "-i" ]; then input="$arg"; fi
  prev="$arg"
  output="$arg"
done
cp "$input" "$output"
`;

t.before(async () => {
  root = await mkdtemp(join(tmpdir(), "rec-live-tronic-server-"));
  const streamlink = join(root, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const ffmpeg = join(root, "ffmpeg");
  await writeFile(ffmpeg, ffmpegStubScript, { mode: 0o755 });
  await chmod(ffmpeg, 0o755);
  // Fixtures are plain-text stand-ins, not real MPEG-TS, so a real ffprobe
  // would fail to parse them anyway -- this stub handles remux verification
  // calls (format=duration, stream=codec_type) for the remux flow, and fails
  // fast for other calls (like keyframe-snap's format=start_time), exercising
  // extractSegment's graceful fallback behavior.
  const ffprobe = join(root, "ffprobe");
  const ffprobeScript = `#!/bin/sh
case "$*" in
  *format=duration*)
    echo "120.0"
    exit 0
    ;;
  *stream=codec_type*)
    echo "video"
    echo "audio"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`;
  await writeFile(ffprobe, ffprobeScript, { mode: 0o755 });
  await chmod(ffprobe, 0o755);
  // UserSystemdClient spawns "systemctl"/"systemd-run" by bare name (resolved
  // via PATH, not a config-provided path like streamlink/ffmpeg above), so a
  // dev machine or CI runner with no real systemd (e.g. macOS) would hit
  // `spawn systemctl ENOENT` the moment a test stops/relaunches a running
  // recording's unit. Stub both onto PATH the same way.
  const systemctl = join(root, "systemctl");
  await writeFile(systemctl, "#!/bin/sh\ncase \"$2\" in\n  is-active) exit 3 ;;\nesac\nexit 0\n", { mode: 0o755 });
  await chmod(systemctl, 0o755);
  const systemdRun = join(root, "systemd-run");
  await writeFile(systemdRun, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(systemdRun, 0o755);
  process.env.PATH = `${root}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
  config = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(root, "state"),
    REC_LIVE_RECORDINGS_DIR: join(root, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_FFMPEG_BIN: ffmpeg,
    REC_LIVE_FFPROBE_BIN: ffprobe,
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

t.test("persists artist, venue, and event through create and GET", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "metadata persistence test",
      artist: "The Artist",
      venue: "The Venue",
      event: "The Event",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { id: string; artist: string | null; venue: string | null; event: string | null } };
  t.equal(createdBody.recording.artist, "The Artist");
  t.equal(createdBody.recording.venue, "The Venue");
  t.equal(createdBody.recording.event, "The Event");
  const fetched = await (await fetch(`${base}/recordings/${createdBody.recording.id}`)).json() as { recording: { artist: string | null; venue: string | null; event: string | null } };
  t.equal(fetched.recording.artist, "The Artist");
  t.equal(fetched.recording.venue, "The Venue");
  t.equal(fetched.recording.event, "The Event");
});

t.test("composes the title from artist/venue/event/stage when no title is given", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      artist: "Artist",
      venue: "Venue",
      event: "Event",
      stage: "Stage",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { title: string } };
  t.equal(createdBody.recording.title, "Artist - Venue - Event - Stage");
});

t.test("omits empty segments (no doubled dashes) when composing a title", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      artist: "Artist",
      stage: "Stage",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { title: string } };
  t.equal(createdBody.recording.title, "Artist - Stage");
});

t.test("uses an explicit title verbatim instead of composing from segments", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "Explicit Title",
      artist: "Artist",
      venue: "Venue",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { title: string } };
  t.equal(createdBody.recording.title, "Explicit Title");
});

t.test("uses a directly-typed stage field over the oembed-derived stage", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=phase03",
      title: "Artist - Title Stage - Festival",
      stage: "Explicit Stage",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  t.equal(created.status, 201);
  const createdBody = await created.json() as { recording: { stage: string | null } };
  t.equal(createdBody.recording.stage, "Explicit Stage");
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

t.test("returns oembed author and title for a valid youtube url", async (t) => {
  const { createServer } = await import("node:http");
  const testDouble = createServer((req, res) => {
    if (req.url?.includes("url=https")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ author_name: "Test Channel", title: "Test Stream Title" }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => {
    testDouble.listen(0, "127.0.0.1", () => resolve());
  });

  const testDoubleAddress = testDouble.address();
  if (!testDoubleAddress || typeof testDoubleAddress === "string") {
    testDouble.close();
    throw new Error("Test double failed to bind a port");
  }

  const oembedRoot = await mkdtemp(join(tmpdir(), "rec-live-tronic-oembed-"));
  const streamlink = join(oembedRoot, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const oembedConfig = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(oembedRoot, "state"),
    REC_LIVE_RECORDINGS_DIR: join(oembedRoot, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(oembedRoot, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_OEMBED_ENDPOINT: `http://127.0.0.1:${testDoubleAddress.port}/oembed`,
  });
  const oembedServer = await startServer(oembedConfig, "24.0.0");

  try {
    const address = oembedServer.publicServer.address();
    t.ok(address && typeof address !== "string");
    if (!address || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(
      `${base}/recordings/oembed?url=https://www.youtube.com/watch?v=test`
    );

    t.equal(response.status, 200);
    const body = await response.json() as { author_name: string | null; title: string | null };
    t.equal(body.author_name, "Test Channel");
    t.equal(body.title, "Test Stream Title");
  } finally {
    await oembedServer.close();
    await rm(oembedRoot, { recursive: true, force: true });
    testDouble.close();
  }
});

t.test("returns null oembed fields instead of erroring when the lookup fails", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  // Use a URL that will trigger a timeout on the unreachable port 1
  const response = await fetch(
    `${base}/recordings/oembed?url=https://www.youtube.com/watch?v=timeout-test`
  );

  t.equal(response.status, 200, "should return 200 even on oEmbed failure");
  const body = await response.json() as { author_name: unknown; title: unknown };
  t.equal(body.author_name, null, "author_name should be null on failure");
  t.equal(body.title, null, "title should be null on failure");
});

t.test("rejects an oembed prefill lookup for a non-youtube url", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(
    `${base}/recordings/oembed?url=https://example.com/video`
  );

  t.equal(response.status, 400, "should reject non-YouTube URLs");
  const body = await response.json() as { error: { code: string } };
  t.equal(body.error.code, "VALIDATION_ERROR");
});

async function startWithStreamlinkStub(prefix: string, script: string): Promise<{ server: RunningServer; root: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const streamlink = join(root, "streamlink");
  await writeFile(streamlink, script, { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const stubConfig = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(root, "state"),
    REC_LIVE_RECORDINGS_DIR: join(root, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(root, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
  });
  const server = await startServer(stubConfig, "24.0.0");
  return { server, root };
}

t.test("returns available quality formats for a url streamlink can probe", async (t) => {
  const streamsJson = JSON.stringify({
    streams: {
      worst: { type: "hls", url: "https://example.invalid/144p.m3u8" },
      "144p": { type: "hls", url: "https://example.invalid/144p.m3u8" },
      "360p": { type: "hls", url: "https://example.invalid/360p.m3u8" },
      "720p": { type: "hls", url: "https://example.invalid/720p.m3u8" },
      "1080p": { type: "hls", url: "https://example.invalid/1080p.m3u8" },
      best: { type: "hls", url: "https://example.invalid/1080p.m3u8" },
    },
  });
  const { server, root } = await startWithStreamlinkStub(
    "rec-live-tronic-formats-",
    `#!/bin/sh\nif [ "$1" = "--json" ]; then echo '${streamsJson}'; else exit 0; fi\n`,
  );

  try {
    const address = server.publicServer.address();
    t.ok(address && typeof address !== "string");
    if (!address || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/recordings/formats?url=https://www.youtube.com/watch?v=live-test`);

    t.equal(response.status, 200);
    const body = await response.json() as { available: boolean; qualities: string[]; best_matches: string | null };
    t.equal(body.available, true);
    t.same(body.qualities, ["1080p", "720p", "360p", "144p"]);
    t.equal(body.best_matches, "1080p");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

t.test("returns unavailable instead of erroring when streamlink finds no live stream", async (t) => {
  const { server, root } = await startWithStreamlinkStub(
    "rec-live-tronic-formats-unavailable-",
    `#!/bin/sh\nif [ "$1" = "--json" ]; then echo '{"error": "No playable streams found on this URL"}'; else exit 0; fi\n`,
  );

  try {
    const address = server.publicServer.address();
    t.ok(address && typeof address !== "string");
    if (!address || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/recordings/formats?url=https://www.youtube.com/watch?v=not-live`);

    t.equal(response.status, 200, "should return 200 even when streamlink finds no stream");
    const body = await response.json() as { available: boolean; qualities: string[]; best_matches: string | null };
    t.equal(body.available, false);
    t.same(body.qualities, []);
    t.equal(body.best_matches, null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

t.test("rejects a formats lookup for a non-youtube url", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/recordings/formats?url=https://example.com/video`);

  t.equal(response.status, 400, "should reject non-YouTube URLs");
  const body = await response.json() as { error: { code: string } };
  t.equal(body.error.code, "VALIDATION_ERROR");
});

t.test("serves a finished recording file as an attachment when download=1", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=download-test-1",
      title: "My Cool Recording",
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
  const testContent = "test video content for download";
  await writeFile(join(root, "recordings", `${id}.ts`), testContent);

  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });

  const fileResponse = await fetch(`${base}/recordings/${id}/file?download=1`);
  t.equal(fileResponse.status, 200);
  t.match(
    fileResponse.headers.get("Content-Disposition"),
    /^attachment; filename="My Cool Recording\.ts"$/,
    "should set Content-Disposition attachment header with sanitized filename"
  );
  const body = await fileResponse.text();
  t.equal(body, testContent);
});

t.test("serves a finished recording's file with a friendly filename in the URL path", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "friendly url path test");

  const response = await fetch(`${base}/recordings/${id}/file/${encodeURIComponent("friendly url path test.ts")}`);
  t.equal(response.status, 200);
  t.equal(response.headers.get("Content-Type"), "video/mp2t");
  t.equal(await response.text(), `source content for ${id}`);
});

t.test("sets an inline Content-Disposition with the recording's title on the plain file route", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "inline disposition test");

  const response = await fetch(`${base}/recordings/${id}/file`);
  t.equal(response.status, 200);
  t.match(
    response.headers.get("Content-Disposition"),
    /^inline; filename="inline disposition test\.ts"$/,
  );
});

t.test("serves a .ts recording with video/mp2t Content-Type and .ts filename", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "ts file serving test");

  const inlineResponse = await fetch(`${base}/recordings/${id}/file`);
  t.equal(inlineResponse.status, 200);
  t.equal(inlineResponse.headers.get("Content-Type"), "video/mp2t", "inline request should have video/mp2t Content-Type");
  t.match(
    inlineResponse.headers.get("Content-Disposition"),
    /^inline; filename="ts file serving test\.ts"$/,
    "inline request should have .ts filename"
  );

  const downloadResponse = await fetch(`${base}/recordings/${id}/file?download=1`);
  t.equal(downloadResponse.status, 200);
  t.equal(downloadResponse.headers.get("Content-Type"), "video/mp2t", "download request should have video/mp2t Content-Type");
  t.match(
    downloadResponse.headers.get("Content-Disposition"),
    /^attachment; filename="ts file serving test\.ts"$/,
    "download request should have .ts filename"
  );
});

t.test("serves a trashed recording's file for download", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=download-trash-test",
      title: "Trashed Recording",
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
  const testContent = "test video content for trashed download";
  await writeFile(join(root, "recordings", `${id}.ts`), testContent);

  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recordingBody.recording.version,
    status: "recorded",
  });

  // Trash the recording
  await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });

  // Download with the download=1 param should still work
  const fileResponse = await fetch(`${base}/recordings/${id}/file?download=1`);
  t.equal(fileResponse.status, 200);
  t.match(
    fileResponse.headers.get("Content-Disposition"),
    /^attachment; filename="Trashed Recording\.ts"$/,
    "should serve trashed recording for download with Content-Disposition"
  );
  const body = await fileResponse.text();
  t.equal(body, testContent);
});

t.test("creates a now-mode recording that starts at the current time", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;

  const beforeMs = Date.now();
  const startAt = new Date().toISOString();
  const stopAt = new Date(Date.now() + 70 * 60_000).toISOString();

  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=now-mode-test",
      title: "Now mode test",
      start_at: startAt,
      stop_at: stopAt,
    }),
  });
  const afterMs = Date.now();
  t.equal(created.status, 201);
  const createdBody = await created.json() as {
    recording: { id: string; status: string; startAt: string; stopAt: string };
  };
  t.equal(createdBody.recording.status, "scheduled");
  const createdStartMs = new Date(createdBody.recording.startAt).getTime();
  t.ok(
    createdStartMs >= beforeMs - 1000 && createdStartMs <= afterMs + 1000,
    "start_at should be close to the moment of submission"
  );

  const fetched = await fetch(`${base}/recordings/${createdBody.recording.id}`);
  const fetchedBody = await fetched.json() as { recording: { status: string } };
  t.equal(fetchedBody.recording.status, "scheduled");
});

// Drives a fresh recording all the way to `recorded` via the private
// transition socket (mirrors the "serves a finished recording's file" setup)
// so the finished-recording edit tests have a real terminal-status row.
async function seedRecordedRecording(base: string, title: string): Promise<string> {
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=phase04a", title, start_at: "2099-01-01T00:00:00Z", stop_at: "2099-01-01T01:00:00Z" }),
  });
  const createdBody = await created.json() as { recording: { id: string; version: number } };
  const id = createdBody.recording.id;
  const transitionPath = `/internal/recordings/${id}/transition`;
  await privateRequest(join(root, "run", "api.sock"), transitionPath, { expected_status: "scheduled", expected_version: createdBody.recording.version, status: "recording" });
  const mid = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { version: number } };
  await writeFile(join(root, "recordings", `${id}.ts`), "capture");
  await privateRequest(join(root, "run", "api.sock"), transitionPath, { expected_status: "recording", expected_version: mid.recording.version, status: "recorded" });
  return id;
}

t.test("allows editing metadata and stop_at, but not quality or start_at, on a running recording", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://www.youtube.com/watch?v=running-metadata-edit", title: "before edit", start_at: "2099-01-01T00:00:00Z", stop_at: "2099-01-01T01:00:00Z" }),
  });
  const createdBody = await created.json() as { recording: { id: string; version: number } };
  const id = createdBody.recording.id;
  await privateRequest(join(root, "run", "api.sock"), `/internal/recordings/${id}/transition`, {
    expected_status: "scheduled",
    expected_version: createdBody.recording.version,
    status: "recording",
  });

  const metadataResponse = await fetch(`${base}/recordings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "renamed mid-capture", stage: "Main Stage", artist: "Live Artist", venue: "Live Venue", event: "Live Event", stop_at: "2099-01-01T02:00:00Z" }),
  });
  t.equal(metadataResponse.status, 200);
  const fetched = await (await fetch(`${base}/recordings/${id}`)).json() as {
    recording: { title: string; stage: string | null; artist: string | null; venue: string | null; event: string | null; stopAt: string; status: string };
  };
  t.equal(fetched.recording.title, "renamed mid-capture");
  t.equal(fetched.recording.stage, "Main Stage");
  t.equal(fetched.recording.artist, "Live Artist");
  t.equal(fetched.recording.venue, "Live Venue");
  t.equal(fetched.recording.event, "Live Event");
  t.equal(fetched.recording.stopAt, "2099-01-01T02:00:00.000Z");
  t.equal(fetched.recording.status, "recording");

  const qualityResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ quality: "480p" }) });
  t.equal(qualityResponse.status, 409);
  const startResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ start_at: "2099-01-01T00:30:00Z" }) });
  t.equal(startResponse.status, 409);
});

t.test("edits title and stage on a finished recording via PATCH", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "original finished title");
  const patched = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "renamed after capture", stage: "Second Stage" }) });
  t.equal(patched.status, 200);
  const fetched = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { title: string; stage: string | null; status: string } };
  t.equal(fetched.recording.title, "renamed after capture");
  t.equal(fetched.recording.stage, "Second Stage");
  t.equal(fetched.recording.status, "recorded");
});

t.test("allows editing start/stop but rejects quality on a finished recording", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "editable-window recording");
  const startResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ start_at: "2099-01-01T00:30:00Z" }) });
  t.equal(startResponse.status, 200);
  const stopResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stop_at: "2099-01-01T02:00:00Z" }) });
  t.equal(stopResponse.status, 200);
  const fetched = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { startAt: string; stopAt: string } };
  t.equal(fetched.recording.startAt, "2099-01-01T00:30:00.000Z");
  t.equal(fetched.recording.stopAt, "2099-01-01T02:00:00.000Z");

  const qualityResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ quality: "480p" }) });
  t.equal(qualityResponse.status, 409);
  const body = await qualityResponse.json() as { error: { code: string } };
  t.equal(body.error.code, "STATUS_CONFLICT");
});

t.test("clears stage when PATCHed with an empty stage on a finished recording", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "Artist - Main Stage - Fest");
  const before = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { stage: string | null } };
  t.equal(before.recording.stage, "Main Stage");
  const patched = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "" }) });
  t.equal(patched.status, 200);
  const after = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { stage: string | null } };
  t.equal(after.recording.stage, null);
});

t.test("edits artist, venue, and event on a finished recording via PATCH", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "metadata edit target");
  const patched = await fetch(`${base}/recordings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artist: "New Artist", venue: "New Venue", event: "New Event" }),
  });
  t.equal(patched.status, 200);
  const fetched = await (await fetch(`${base}/recordings/${id}`)).json() as {
    recording: { artist: string | null; venue: string | null; event: string | null };
  };
  t.equal(fetched.recording.artist, "New Artist");
  t.equal(fetched.recording.venue, "New Venue");
  t.equal(fetched.recording.event, "New Event");
});

t.test("leaves the title unchanged when editing metadata fields on a finished recording", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "title should stay put");
  const patched = await fetch(`${base}/recordings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artist: "Recomposed?", venue: "Nope", event: "Still nope", stage: "Still nope too" }),
  });
  t.equal(patched.status, 200);
  const fetched = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { title: string } };
  t.equal(fetched.recording.title, "title should stay put");
});

t.test("still allows editing start/stop but rejects quality on a finished recording", async (t) => {
  const address = running.publicServer.address();
  t.ok(address && typeof address !== "string");
  if (!address || typeof address === "string") return;
  const base = `http://127.0.0.1:${address.port}`;
  const id = await seedRecordedRecording(base, "editable-window metadata recording");
  for (const patch of [{ start_at: "2099-01-01T00:30:00Z" }, { stop_at: "2099-01-01T02:00:00Z" }]) {
    const response = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    t.equal(response.status, 200);
  }
  const qualityResponse = await fetch(`${base}/recordings/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ quality: "480p" }) });
  t.equal(qualityResponse.status, 409);
  const body = await qualityResponse.json() as { error: { code: string } };
  t.equal(body.error.code, "STATUS_CONFLICT");
});

t.test("reports is_recording true only while a recording is active", async (t) => {
  // Runs against its own isolated server (rather than the shared `running`
  // instance) because earlier tests in this suite leave lingering rows in
  // "recording" status on the shared server, which would make a "no
  // recording active" baseline unreliable.
  const flagRoot = await mkdtemp(join(tmpdir(), "rec-live-tronic-flag-"));
  const streamlink = join(flagRoot, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const flagConfig = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(flagRoot, "state"),
    REC_LIVE_RECORDINGS_DIR: join(flagRoot, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(flagRoot, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
  });
  const flagServer = await startServer(flagConfig, "24.0.0");
  try {
    const address = flagServer.publicServer.address();
    t.ok(address && typeof address !== "string");
    if (!address || typeof address === "string") return;
    const base = `http://127.0.0.1:${address.port}`;
    const before = await (await fetch(`${base}/recordings`)).json() as { is_recording: boolean };
    t.equal(before.is_recording, false);
    const created = await fetch(`${base}/recordings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=phase4bc",
        title: "is_recording flag test",
        start_at: "2099-01-01T00:00:00Z",
        stop_at: "2099-01-01T01:00:00Z",
      }),
    });
    const createdBody = await created.json() as { recording: { id: string; version: number } };
    const id = createdBody.recording.id;
    const transitionPath = `/internal/recordings/${id}/transition`;
    await privateRequest(join(flagRoot, "run", "api.sock"), transitionPath, {
      expected_status: "scheduled",
      expected_version: createdBody.recording.version,
      status: "recording",
    });
    const during = await (await fetch(`${base}/recordings`)).json() as { is_recording: boolean };
    t.equal(during.is_recording, true);
    const recording = await fetch(`${base}/recordings/${id}`);
    const recordingBody = await recording.json() as { recording: { version: number } };
    await writeFile(join(flagRoot, "recordings", `${id}.ts`), "content");
    await privateRequest(join(flagRoot, "run", "api.sock"), transitionPath, {
      expected_status: "recording",
      expected_version: recordingBody.recording.version,
      status: "recorded",
    });
    const after = await (await fetch(`${base}/recordings`)).json() as { is_recording: boolean };
    t.equal(after.is_recording, false);
  } finally {
    await flagServer.close();
    await rm(flagRoot, { recursive: true, force: true });
  }
});

// -- Phase 5: the Cut workflow (trim & split) --------------------------------

async function createFinishedRecording(base: string, title: string): Promise<string> {
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=cut-workflow",
      title,
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  if (created.status !== 201) throw new Error(`Failed to create fixture recording: ${created.status}`);
  const createdBody = await created.json() as { recording: { id: string; version: number } };
  const id = createdBody.recording.id;
  const transitionPath = `/internal/recordings/${id}/transition`;
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "scheduled",
    expected_version: createdBody.recording.version,
    status: "recording",
  });
  const recording = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { version: number } };
  await writeFile(join(root, "recordings", `${id}.ts`), `source content for ${id}`);
  await privateRequest(join(root, "run", "api.sock"), transitionPath, {
    expected_status: "recording",
    expected_version: recording.recording.version,
    status: "recorded",
  });
  return id;
}

t.test("creates a trim cut draft with one preview piece from a finished recording", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "trim draft test");
  const response = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "5:00", end: "10:00" }),
  });
  t.equal(response.status, 200);
  const body = await response.json() as { draft: { id: string; mode: string; status: string; pieces: { index: number; start: string; end: string; duration: string; file_url: string }[] } };
  t.equal(body.draft.mode, "trim");
  t.equal(body.draft.status, "previewing");
  t.equal(body.draft.pieces.length, 1);
  t.match(body.draft.pieces[0], { index: 0, start: "0:05:00", end: "0:10:00", duration: "0:05:00" });
  const { existsSync } = await import("node:fs");
  t.ok(existsSync(join(root, "recordings", id, "piece-0.ts")));
  t.equal(existsSync(join(root, "recordings", `${id}.ts`)), true);
});

t.test("creates a split cut draft with N+1 preview pieces", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "split draft test");
  const response = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "split", cuts: ["20:00", "40:00"] }),
  });
  t.equal(response.status, 200);
  const body = await response.json() as { draft: { mode: string; pieces: { index: number }[] } };
  t.equal(body.draft.mode, "split");
  t.equal(body.draft.pieces.length, 3);
  const { existsSync } = await import("node:fs");
  for (let index = 0; index < 3; index += 1) {
    t.ok(existsSync(join(root, "recordings", id, `piece-${index}.ts`)));
  }
});

t.test("rejects a cut of a source that is not recorded (409)", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=cut-not-recorded",
      title: "not recorded cut test",
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });
  const createdBody = await created.json() as { recording: { id: string } };
  const response = await fetch(`${base}/recordings/${createdBody.recording.id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "0:05" }),
  });
  t.equal(response.status, 409);
});

t.test("404s a cut of a source that does not exist", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/recordings/rec-nonexistent/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "0:05" }),
  });
  t.equal(response.status, 404);
});

t.test("rejects out-of-order or out-of-range offsets (400)", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "malformed offsets test");
  const outOfRange = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "2:00:00" }),
  });
  t.equal(outOfRange.status, 400);
  const outOfOrder = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "split", cuts: ["40:00", "20:00"] }),
  });
  t.equal(outOfOrder.status, 400);
  const malformed = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "not-a-time" }),
  });
  t.equal(malformed.status, 400);
});

t.test("regenerating a cut for a source reuses its single active draft (no second draft, no orphan folder)", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "regenerate draft test");
  const first = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "5:00", end: "10:00" }),
  });
  const firstBody = await first.json() as { draft: { id: string; pieces: { index: number }[] } };
  const second = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "split", cuts: ["10:00", "20:00"] }),
  });
  const secondBody = await second.json() as { draft: { id: string; mode: string; pieces: { index: number }[] } };
  t.equal(secondBody.draft.id, firstBody.draft.id);
  t.equal(secondBody.draft.mode, "split");
  t.equal(secondBody.draft.pieces.length, 3);
  const { existsSync, readdirSync } = await import("node:fs");
  t.equal(existsSync(join(root, "recordings", id, "piece-0.ts")), true);
  t.same(readdirSync(join(root, "recordings", id)).sort(), ["piece-0.ts", "piece-1.ts", "piece-2.ts"]);
});

t.test("range-serves a preview piece for playback", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "piece file route test");
  const response = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "5:00", end: "10:00" }),
  });
  const body = await response.json() as { draft: { id: string; pieces: { file_url: string }[] } };
  const pieceResponse = await fetch(`${base}${body.draft.pieces[0]!.file_url}`);
  t.equal(pieceResponse.status, 200);
  t.equal(pieceResponse.headers.get("Content-Type"), "video/mp2t");
  t.equal(await pieceResponse.text(), `source content for ${id}`);
  const missingPiece = await fetch(`${base}/recordings/${id}/cut/${body.draft.id}/pieces/99/file`);
  t.equal(missingPiece.status, 404);
  const missingDraft = await fetch(`${base}/recordings/${id}/cut/cut-nonexistent/pieces/0/file`);
  t.equal(missingDraft.status, 404);
});

async function createTrimDraft(base: string, id: string, start: string, end?: string): Promise<{ id: string; mode: string; pieces: { index: number; start: string; end: string; file_url: string }[] }> {
  const response = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(end === undefined ? { mode: "trim", start } : { mode: "trim", start, end }),
  });
  const body = await response.json() as { draft: { id: string; mode: string; pieces: { index: number; start: string; end: string; file_url: string }[] } };
  return body.draft;
}

async function createSplitDraft(base: string, id: string, cuts: string[]): Promise<{ id: string; mode: string; pieces: { index: number; start: string; end: string; file_url: string }[] }> {
  const response = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "split", cuts }),
  });
  const body = await response.json() as { draft: { id: string; mode: string; pieces: { index: number; start: string; end: string; file_url: string }[] } };
  return body.draft;
}

t.test("keep promotes selected pieces to recorded recordings with cut_from_id set", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep trim source");
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  t.equal(response.status, 200);
  const body = await response.json() as { recordings: { id: string; status: string; cutFromId: string; url: string; quality: string; stage: string | null; title: string }[] };
  t.equal(body.recordings.length, 1);
  const derived = body.recordings[0]!;
  t.equal(derived.status, "recorded");
  t.equal(derived.cutFromId, id);
  t.equal(derived.title, "keep trim source");
  const source = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { url: string; quality: string } };
  t.equal(derived.url, source.recording.url);
  t.equal(derived.quality, source.recording.quality);
  const { existsSync } = await import("node:fs");
  t.equal(existsSync(join(root, "recordings", `${derived.id}.ts`)), true);
  t.equal(existsSync(join(root, "recordings", id)), false);
});

t.test("keep defaults derived start_at/stop_at to real clock times from the source's start plus trim offsets, editable per piece", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep wall-clock source");
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await response.json() as { recordings: { startAt: string; stopAt: string }[] };
  // A cut is the same event as its source (same URL/title/etc by default),
  // but its own calendar window is the source's start plus this piece's trim
  // offsets -- not the source's full start/stop -- so Duration reflects the
  // piece's real trimmed length (the fixture source starts at 00:00:00Z; a
  // 5:00-10:00 trim is offsets 300s-600s from that).
  t.equal(body.recordings[0]!.startAt, "2099-01-01T00:05:00.000Z");
  t.equal(body.recordings[0]!.stopAt, "2099-01-01T00:10:00.000Z");

  const editId2 = await createFinishedRecording(base, "keep wall-clock override source");
  const draft2 = await createTrimDraft(base, editId2, "5:00", "10:00");
  const editedResponse = await fetch(`${base}/recordings/${editId2}/cut/${draft2.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ overrides: { "0": { start_at: "2099-01-02T00:00:00Z", stop_at: "2099-01-02T01:00:00Z" } } }),
  });
  const editedBody = await editedResponse.json() as { recordings: { startAt: string; stopAt: string }[] };
  t.equal(editedBody.recordings[0]!.startAt, "2099-01-02T00:00:00.000Z");
  t.equal(editedBody.recordings[0]!.stopAt, "2099-01-02T01:00:00.000Z");
});

t.test("keep on a trim defaults to keeping the single piece; split keeps only checked indices", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;

  const trimId = await createFinishedRecording(base, "keep trim default source");
  const trimDraft = await createTrimDraft(base, trimId, "5:00", "10:00");
  const trimResponse = await fetch(`${base}/recordings/${trimId}/cut/${trimDraft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const trimBody = await trimResponse.json() as { recordings: unknown[] };
  t.equal(trimBody.recordings.length, 1);

  const splitId = await createFinishedRecording(base, "keep split selected source");
  const splitDraft = await createSplitDraft(base, splitId, ["20:00", "40:00"]);
  const splitResponse = await fetch(`${base}/recordings/${splitId}/cut/${splitDraft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keep: [0, 2], overrides: { "0": { title: "Opening set" }, "2": { title: "Closing set" } } }),
  });
  t.equal(splitResponse.status, 200);
  const splitBody = await splitResponse.json() as { recordings: { title: string }[] };
  t.equal(splitBody.recordings.length, 2);
  t.same(splitBody.recordings.map((r) => r.title).sort(), ["Closing set", "Opening set"]);
});

t.test("keep applies per-piece artist/venue/event/stage overrides", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;

  const id = await createFinishedRecording(base, "keep field overrides source");
  await fetch(`${base}/recordings/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ artist: "Source Artist", venue: "Source Venue", event: "Source Event", stage: "Source Stage" }),
  });
  const draft = await createSplitDraft(base, id, ["20:00", "40:00"]);
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      keep: [0, 1],
      overrides: {
        "0": { title: "Overridden title", artist: "Piece Artist", venue: "Piece Venue", event: "Piece Event", stage: "Piece Stage" },
      },
    }),
  });
  t.equal(response.status, 200);
  const body = await response.json() as { recordings: { title: string; artist: string | null; venue: string | null; event: string | null; stage: string | null }[] };
  t.equal(body.recordings.length, 2);
  const overridden = body.recordings.find((r) => r.title === "Overridden title")!;
  t.ok(overridden);
  t.equal(overridden.artist, "Piece Artist");
  t.equal(overridden.venue, "Piece Venue");
  t.equal(overridden.event, "Piece Event");
  t.equal(overridden.stage, "Piece Stage");

  const inherited = body.recordings.find((r) => r.title !== "Overridden title")!;
  t.ok(inherited);
  t.equal(inherited.artist, "Source Artist");
  t.equal(inherited.venue, "Source Venue");
  t.equal(inherited.event, "Source Event");
  t.equal(inherited.stage, "Source Stage");
});

t.test("promoted recordings are listed, served, and re-cuttable like any other recording", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep re-cuttable source");
  const draft = await createTrimDraft(base, id, "5:00", "20:00");
  const keepResponse = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const keepBody = await keepResponse.json() as { recordings: { id: string }[] };
  const derivedId = keepBody.recordings[0]!.id;

  const listed = await (await fetch(`${base}/recordings?status=recorded`)).json() as { recordings: { id: string }[] };
  t.ok(listed.recordings.some((r) => r.id === derivedId));

  const fileResponse = await fetch(`${base}/recordings/${derivedId}/file`);
  t.equal(fileResponse.status, 200);
  t.equal(await fileResponse.text(), `source content for ${id}`);

  const recutResponse = await fetch(`${base}/recordings/${derivedId}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "0:01" }),
  });
  t.equal(recutResponse.status, 200);
});

t.test("GET /recordings?cut_from=<id> returns the source's derived recordings", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "cut_from filter source");
  const other = await createFinishedRecording(base, "cut_from filter unrelated");
  const draft = await createSplitDraft(base, id, ["20:00", "40:00"]);
  await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const filtered = await (await fetch(`${base}/recordings?cut_from=${id}`)).json() as { recordings: { id: string; cutFromId: string }[] };
  t.equal(filtered.recordings.length, 3);
  t.ok(filtered.recordings.every((r) => r.cutFromId === id));
  const otherFiltered = await (await fetch(`${base}/recordings?cut_from=${other}`)).json() as { recordings: unknown[] };
  t.equal(otherFiltered.recordings.length, 0);
});

t.test("leaves the source .ts untouched after cut, and renames+trashes the source row after keep", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "source untouched test");
  const before = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { title: string; tsPath?: string; trashedAt: string | null } };
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const afterCut = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: unknown };
  t.same(afterCut.recording, before.recording);
  await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const afterKeep = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { id: string; title: string; trashedAt: string | null } };
  t.equal(afterKeep.recording.id, id);
  t.equal(afterKeep.recording.title, "source untouched test (original recording)");
  t.ok(afterKeep.recording.trashedAt !== null);
  const { readFileSync } = await import("node:fs");
  t.equal(readFileSync(join(root, "recordings", `${id}.ts`), "utf8"), `source content for ${id}`);
});

t.test("keep renames the source with an \"(original recording)\" suffix and moves it to trash", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep rename trash source");
  const before = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { trashedAt: string | null } };
  t.equal(before.recording.trashedAt, null);
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  t.equal(response.status, 200);
  const after = await (await fetch(`${base}/recordings/${id}`)).json() as { recording: { title: string; trashedAt: string | null } };
  t.equal(after.recording.title, "keep rename trash source (original recording)");
  t.ok(after.recording.trashedAt !== null);
  const listedTrashed = await (await fetch(`${base}/recordings?trashed=true`)).json() as { recordings: { id: string }[] };
  t.ok(listedTrashed.recordings.some((r) => r.id === id));
});

t.test("rejects an invalid title override without orphaning renamed piece files", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep bad title override source");
  const draft = await createSplitDraft(base, id, ["20:00", "40:00"]);
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keep: [0, 1], overrides: { "0": { title: 123 } } }),
  });
  t.equal(response.status, 400);
  const { existsSync } = await import("node:fs");
  // Every kept piece file must still be present under its original name --
  // a validation failure must not have renamed any of them out from under
  // the still-previewing draft.
  t.equal(existsSync(join(root, "recordings", id, "piece-0.ts")), true);
  t.equal(existsSync(join(root, "recordings", id, "piece-1.ts")), true);
  const stillPreviewing = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keep: [0, 1] }),
  });
  t.equal(stillPreviewing.status, 200);
});

t.test("rejects cutting a trashed recording", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "trashed source cut test");
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const trashResponse = await fetch(`${base}/recordings/${id}/file`, { method: "DELETE" });
  t.equal(trashResponse.status, 204);

  const cutAfterTrash = await fetch(`${base}/recordings/${id}/cut`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trim", start: "0:01" }),
  });
  t.equal(cutAfterTrash.status, 409);

  const keepAfterTrash = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  t.equal(keepAfterTrash.status, 409);
});

t.test("keep 404s when the draft or source is missing, and 409s when not previewing", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "keep error cases source");
  const missingSource = await fetch(`${base}/recordings/rec-nonexistent/cut/cut-nonexistent/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  t.equal(missingSource.status, 404);
  const missingDraft = await fetch(`${base}/recordings/${id}/cut/cut-nonexistent/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  t.equal(missingDraft.status, 404);
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const secondKeep = await fetch(`${base}/recordings/${id}/cut/${draft.id}/keep`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  t.equal(secondKeep.status, 409);
});

t.test("abandoning a draft removes its working folder and row", async (t) => {
  const address = running.publicServer.address();
  if (!address || typeof address === "string") return t.fail("no public listener");
  const base = `http://127.0.0.1:${address.port}`;
  const id = await createFinishedRecording(base, "abandon draft source");
  const draft = await createTrimDraft(base, id, "5:00", "10:00");
  const { existsSync } = await import("node:fs");
  t.equal(existsSync(join(root, "recordings", id)), true);
  const response = await fetch(`${base}/recordings/${id}/cut/${draft.id}`, { method: "DELETE" });
  t.equal(response.status, 204);
  t.equal(existsSync(join(root, "recordings", id)), false);
  const pieceAfterAbandon = await fetch(`${base}/recordings/${id}/cut/${draft.id}/pieces/0/file`);
  t.equal(pieceAfterAbandon.status, 404);
  const missingDraft = await fetch(`${base}/recordings/${id}/cut/${draft.id}`, { method: "DELETE" });
  t.equal(missingDraft.status, 404);
  const missingSource = await fetch(`${base}/recordings/rec-nonexistent/cut/${draft.id}`, { method: "DELETE" });
  t.equal(missingSource.status, 404);
});

t.test("sweepStaleCutDrafts removes previewing drafts (and folders) older than the cutoff", async (t) => {
  const sweepRoot = await mkdtemp(join(tmpdir(), "rec-live-tronic-cut-sweep-"));
  const streamlink = join(sweepRoot, "streamlink");
  await writeFile(streamlink, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(streamlink, 0o755);
  const ffmpeg = join(sweepRoot, "ffmpeg");
  await writeFile(ffmpeg, ffmpegStubScript, { mode: 0o755 });
  await chmod(ffmpeg, 0o755);
  const ffprobe = join(sweepRoot, "ffprobe");
  await writeFile(ffprobe, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await chmod(ffprobe, 0o755);
  const sweepConfig = loadConfig({
    REC_LIVE_HOST: "127.0.0.1",
    REC_LIVE_PORT: "0",
    REC_LIVE_DATA_DIR: join(sweepRoot, "state"),
    REC_LIVE_RECORDINGS_DIR: join(sweepRoot, "recordings"),
    REC_LIVE_PRIVATE_SOCKET: join(sweepRoot, "run", "api.sock"),
    REC_LIVE_STREAMLINK_BIN: streamlink,
    REC_LIVE_FFMPEG_BIN: ffmpeg,
    REC_LIVE_FFPROBE_BIN: ffprobe,
    REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
  });
  let sweepServer = await startServer(sweepConfig, "24.0.0");
  try {
    function base(server: RunningServer): string {
      const address = server.publicServer.address();
      if (!address || typeof address === "string") throw new Error("No public listener");
      return `http://127.0.0.1:${address.port}`;
    }

    async function createFinished(urlSuffix: string): Promise<string> {
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
      await privateRequest(join(sweepRoot, "run", "api.sock"), transitionPath, { expected_status: "scheduled", expected_version: createdBody.recording.version, status: "recording" });
      const recording = await fetch(`${base(sweepServer)}/recordings/${id}`);
      const recordingBody = await recording.json() as { recording: { version: number } };
      await writeFile(join(sweepRoot, "recordings", `${id}.ts`), `source content for ${id}`);
      await privateRequest(join(sweepRoot, "run", "api.sock"), transitionPath, { expected_status: "recording", expected_version: recordingBody.recording.version, status: "recorded" });
      return id;
    }

    const staleId = await createFinished("cut-sweep-stale");
    const staleDraftResponse = await fetch(`${base(sweepServer)}/recordings/${staleId}/cut`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "trim", start: "5:00", end: "10:00" }) });
    const staleDraftBody = await staleDraftResponse.json() as { draft: { id: string } };

    const freshId = await createFinished("cut-sweep-fresh");
    const freshDraftResponse = await fetch(`${base(sweepServer)}/recordings/${freshId}/cut`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "trim", start: "5:00", end: "10:00" }) });
    const freshDraftBody = await freshDraftResponse.json() as { draft: { id: string } };

    const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
    const sweepDatabase = openDatabase(sweepConfig.databasePath);
    try {
      sweepDatabase.prepare("UPDATE cut_drafts SET updated_at = ? WHERE id = ?").run(twentyFiveHoursAgo, staleDraftBody.draft.id);
    } finally {
      sweepDatabase.close();
    }

    await sweepServer.close();
    sweepServer = await startServer(sweepConfig, "24.0.0");

    const { existsSync } = await import("node:fs");
    t.equal(existsSync(join(sweepRoot, "recordings", staleId)), false);
    t.equal(existsSync(join(sweepRoot, "recordings", freshId)), true);
    const staleFile = await fetch(`${base(sweepServer)}/recordings/${staleId}/cut/${staleDraftBody.draft.id}/pieces/0/file`);
    t.equal(staleFile.status, 404);
    const freshFile = await fetch(`${base(sweepServer)}/recordings/${freshId}/cut/${freshDraftBody.draft.id}/pieces/0/file`);
    t.equal(freshFile.status, 200);
  } finally {
    await sweepServer.close();
    await rm(sweepRoot, { recursive: true, force: true });
  }
});

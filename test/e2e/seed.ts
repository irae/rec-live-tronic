import { mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const recordingsDirPath = resolve(projectRoot, ".local/e2e/recordings");
const privateSocketPath = resolve(projectRoot, ".local/e2e/run/api.sock");

function privateRequest(
  socketPath: string,
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const client = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(responseBody),
          })
        );
      }
    );
    client.once("error", reject);
    client.end(payload);
  });
}

export async function seedRecordedRecording(
  title: string
): Promise<{ id: string }> {
  const baseURL = "http://127.0.0.1:8799";
  const recordingsDir = process.env.REC_LIVE_RECORDINGS_DIR || recordingsDirPath;
  const privateSocket = process.env.REC_LIVE_PRIVATE_SOCKET || privateSocketPath;

  // Create a recording
  const createdResponse = await fetch(`${baseURL}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=test",
      title,
      start_at: "2099-01-01T00:00:00Z",
      stop_at: "2099-01-01T01:00:00Z",
    }),
  });

  if (createdResponse.status !== 201) {
    throw new Error(
      `Failed to create recording: ${createdResponse.status} ${await createdResponse.text()}`
    );
  }

  const { recording } = (await createdResponse.json()) as {
    recording: { id: string; version: number };
  };
  const id = recording.id;

  // Transition: scheduled -> recording
  const recordingTransition = await privateRequest(privateSocket, `/internal/recordings/${id}/transition`, {
    expected_status: "scheduled",
    expected_version: recording.version,
    status: "recording",
  });

  if (recordingTransition.status !== 200) {
    throw new Error(
      `Failed to transition to recording: ${recordingTransition.status}`
    );
  }

  const { recording: recordingAfterTransition } = recordingTransition.body as {
    recording: { version: number };
  };

  // Write dummy file
  const filePath = join(recordingsDir, `${id}.ts`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, "dummy video content");

  // Transition: recording -> recorded
  const recordedTransition = await privateRequest(privateSocket, `/internal/recordings/${id}/transition`, {
    expected_status: "recording",
    expected_version: recordingAfterTransition.version,
    status: "recorded",
  });

  if (recordedTransition.status !== 200) {
    throw new Error(
      `Failed to transition to recorded: ${recordedTransition.status}`
    );
  }

  return { id };
}

export async function seedScheduledRecording(
  title: string
): Promise<{ id: string }> {
  const baseURL = "http://127.0.0.1:8799";

  // Create a recording with future times
  const createdResponse = await fetch(`${baseURL}/recordings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://www.youtube.com/watch?v=test",
      title,
      start_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      stop_at: new Date(Date.now() + 65 * 60 * 1000).toISOString(),
    }),
  });

  if (createdResponse.status !== 201) {
    throw new Error(
      `Failed to create recording: ${createdResponse.status} ${await createdResponse.text()}`
    );
  }

  const { recording } = (await createdResponse.json()) as {
    recording: { id: string };
  };

  return { id: recording.id };
}

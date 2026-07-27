import t from "tap";
import { buildStreamlinkArgs } from "../../src/reconciler/streamlink-command.js";
import type { Recording } from "../../src/recordings/repository.js";

function makeRecording(overrides: Partial<Recording> = {}): Recording {
  return {
    id: "rec-3888b705b2f64a0ea49a059edb941198",
    url: "https://www.youtube.com/watch?v=example",
    title: "Live show",
    stage: null,
    artist: null,
    venue: null,
    event: null,
    trashedAt: null,
    cookieId: null,
    cookiePath: null,
    cutFromId: null,
    quality: "720p",
    startAt: "2026-07-21T20:00:00Z",
    stopAt: "2026-07-21T22:00:00Z",
    status: "recording",
    unitName: "rec-3888b705b2f64a0ea49a059edb941198.service",
    tsPath: "/tmp/rec-3888b705b2f64a0ea49a059edb941198.ts",
    lastStartedBootId: null,
    lastStartedStopAt: null,
    version: 1,
    createdAt: "2026-07-21T19:00:00Z",
    updatedAt: "2026-07-21T19:00:00Z",
    ...overrides,
  };
}

t.test("buildStreamlinkArgs includes a generous HLS segment-queue deadline and stream timeout to survive transient hiccups", (t) => {
  const args = buildStreamlinkArgs(makeRecording());
  const deadlineIndex = args.indexOf("--stream-segmented-queue-deadline");
  t.ok(deadlineIndex >= 0, "passes --stream-segmented-queue-deadline");
  t.equal(args[deadlineIndex + 1], "12");
  const timeoutIndex = args.indexOf("--stream-timeout");
  t.ok(timeoutIndex >= 0, "passes --stream-timeout");
  t.equal(args[timeoutIndex + 1], "120");
  t.end();
});

t.test("buildStreamlinkArgs still restarts from the live edge and retries indefinitely for the initial fetch", (t) => {
  const args = buildStreamlinkArgs(makeRecording());
  t.ok(args.includes("--hls-live-restart"));
  const retryStreamsIndex = args.indexOf("--retry-streams");
  t.equal(args[retryStreamsIndex + 1], "5");
  const retryMaxIndex = args.indexOf("--retry-max");
  t.equal(args[retryMaxIndex + 1], "0");
  t.end();
});

t.test("buildStreamlinkArgs still validates quality and appends cookie/url/quality args unchanged", (t) => {
  t.throws(() => buildStreamlinkArgs(makeRecording({ quality: "not-a-quality" })), TypeError);
  const withCookie = buildStreamlinkArgs(makeRecording({ cookiePath: "/some/cookie/path" }));
  t.ok(withCookie.includes("--http-cookies-file"));
  const args = buildStreamlinkArgs(makeRecording());
  t.same(args.slice(-3), ["--stdout", "https://www.youtube.com/watch?v=example", "720p"]);
  t.end();
});

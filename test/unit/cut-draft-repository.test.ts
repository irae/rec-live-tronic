import t from "tap";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.js";
import { migrateDatabase } from "../../src/db/migrate.js";
import { RecordingRepository } from "../../src/recordings/repository.js";
import { CutDraftRepository } from "../../src/recordings/cut-draft-repository.js";

async function makeSource(recordings: RecordingRepository, id: string) {
  return recordings.create({
    id,
    url: "https://www.youtube.com/watch?v=cut-repo-test",
    title: "cut repo test",
    quality: "best",
    startAt: "2099-01-01T00:00:00Z",
    stopAt: "2099-01-01T01:00:00Z",
    unitName: `${id}.service`,
    tsPath: `/dev/null/${id}.ts`,
  });
}

t.test("CutDraftRepository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rec-live-tronic-cut-draft-repo-"));
  const database = openDatabase(join(root, "state", "db.sqlite"));
  migrateDatabase(database);
  const recordings = new RecordingRepository(database);
  const drafts = new CutDraftRepository(database);

  t.teardown(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  await t.test("upsertPreviewing creates a new previewing draft for a source with none", async (t) => {
    await makeSource(recordings, "rec-a");
    const draft = drafts.upsertPreviewing({ id: "cut-a", sourceId: "rec-a", mode: "trim", params: "{}", workingDir: "/tmp/rec-a", pieceCount: 1 });
    t.equal(draft.id, "cut-a");
    t.equal(draft.sourceId, "rec-a");
    t.equal(draft.status, "previewing");
    t.equal(draft.pieceCount, 1);
  });

  await t.test("upsertPreviewing regenerates the same draft in place for a source with an active draft", async (t) => {
    await makeSource(recordings, "rec-b");
    const first = drafts.upsertPreviewing({ id: "cut-b1", sourceId: "rec-b", mode: "trim", params: "{}", workingDir: "/tmp/rec-b", pieceCount: 1 });
    const second = drafts.upsertPreviewing({ id: "cut-b2", sourceId: "rec-b", mode: "split", params: "{}", workingDir: "/tmp/rec-b", pieceCount: 3 });
    t.equal(second.id, first.id);
    t.equal(second.mode, "split");
    t.equal(second.pieceCount, 3);
    t.equal(drafts.getById("cut-b2"), undefined);
  });

  await t.test("getActiveBySource returns undefined once the draft is promoted", async (t) => {
    await makeSource(recordings, "rec-c");
    const draft = drafts.upsertPreviewing({ id: "cut-c", sourceId: "rec-c", mode: "trim", params: "{}", workingDir: "/tmp/rec-c", pieceCount: 1 });
    drafts.markPromoted(draft.id);
    t.equal(drafts.getActiveBySource("rec-c"), undefined);
    t.equal(drafts.getById(draft.id)?.status, "promoted");
  });

  await t.test("delete removes a draft row", async (t) => {
    await makeSource(recordings, "rec-d");
    const draft = drafts.upsertPreviewing({ id: "cut-d", sourceId: "rec-d", mode: "trim", params: "{}", workingDir: "/tmp/rec-d", pieceCount: 1 });
    drafts.delete(draft.id);
    t.equal(drafts.getById(draft.id), undefined);
  });

  await t.test("listStaleOlderThan returns only previewing drafts updated before the cutoff", async (t) => {
    await makeSource(recordings, "rec-e");
    await makeSource(recordings, "rec-f");
    const stale = drafts.upsertPreviewing({ id: "cut-e", sourceId: "rec-e", mode: "trim", params: "{}", workingDir: "/tmp/rec-e", pieceCount: 1, now: "2000-01-01T00:00:00Z" });
    drafts.upsertPreviewing({ id: "cut-f", sourceId: "rec-f", mode: "trim", params: "{}", workingDir: "/tmp/rec-f", pieceCount: 1, now: "2099-01-01T00:00:00Z" });
    const cutoff = new Date("2050-01-01T00:00:00Z").getTime();
    const staleIds = drafts.listStaleOlderThan(cutoff).map((d) => d.id);
    t.ok(staleIds.includes(stale.id));
    t.notOk(staleIds.includes("cut-f"));
  });

  t.end();
});

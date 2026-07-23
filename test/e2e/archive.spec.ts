import { test, expect } from "@playwright/test";
import { seedRecordedRecording } from "./seed.js";

const BASE_URL = "http://127.0.0.1:8799";

test("archive: list loads with seeded recorded recording", async ({
  page,
}) => {
  const { id } = await seedRecordedRecording("Test Archive List");
  await page.goto(`${BASE_URL}/`);
  // Verify the recording title appears in the archive list
  await expect(page.locator("body")).toContainText("Test Archive List");
  // Verify we see "Recorded sets" label indicating archive view
  await expect(page.locator("body")).toContainText("Recorded sets");
});

test("archive: click recording link opens detail with player", async ({
  page,
}) => {
  const { id } = await seedRecordedRecording("Test Video Player");

  // mpegts.js drives playback by attaching a MediaSource to the <video>
  // element and range-fetching the real file endpoint through it, rather
  // than handing the browser the raw .ts URL directly (which no current
  // browser plays natively). Watch for that real request so the test can't
  // pass on a player that merely renders without ever fetching real data.
  const fileRequestPromise = page.waitForRequest((request) =>
    request.url().includes(`/recordings/${id}/file`)
  );

  await page.goto(`${BASE_URL}/`);

  // Click on the recording row
  const recordingStub = page
    .locator(".stub")
    .filter({ hasText: "Test Video Player" })
    .first();
  await recordingStub.click();

  // Assert the video element is visible and mpegts.js actually attached a
  // MediaSource to it: the src is a blob: object URL, never the raw file
  // URL a plain <video src> would have used (and which no major browser
  // plays back natively for a standalone .ts file).
  const video = page.locator("video").first();
  await expect(video).toBeVisible({ timeout: 10000 });
  const src = await video.getAttribute("src");
  expect(src).toMatch(/^blob:/);

  // Assert mpegts.js actually issued a real request against the recording's
  // file endpoint (i.e. this is a live, working player, not just a decorative
  // <video> element with no data source).
  const fileRequest = await fileRequestPromise;
  expect(fileRequest.url()).toContain(`/recordings/${id}/file`);
});

test("archive: copy-url works", async ({ page, context, browserName }) => {
  const { id } = await seedRecordedRecording("Test Copy URL");
  // Grant clipboard permissions (chromium only; webkit handles it differently)
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }

  await page.goto(`${BASE_URL}/`);

  // Click on the recording row to navigate to detail view
  const recordingStub = page
    .locator(".stub")
    .filter({ hasText: "Test Copy URL" })
    .first();
  await recordingStub.click();

  // Wait for and click the copy button
  const copyButton = page.locator("button.copy").first();
  await copyButton.waitFor({ state: "visible", timeout: 10000 });
  await copyButton.click();

  // Assert button shows "Copied ✓" state
  await expect(copyButton).toContainText("Copied");

  // Assert clipboard contains the correct stream URL (chromium only; webkit has limited clipboard support)
  if (browserName === "chromium") {
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText()
    );
    expect(clipboardText).toContain(`/recordings/${id}/file`);
  }
});

test("archive: delete works", async ({ page }) => {
  const { id } = await seedRecordedRecording("Test Delete Recording");
  await page.goto(`${BASE_URL}/`);

  // Click on the recording row to navigate to detail view
  const recordingStub = page
    .locator(".stub")
    .filter({ hasText: "Test Delete Recording" })
    .first();
  await recordingStub.click();

  // Wait for detail view to load and click delete button
  const deleteButton = page.locator("button.btn--danger").first();
  await deleteButton.waitFor({ state: "visible", timeout: 10000 });
  await deleteButton.click();

  // Assert custom ConfirmDialog is visible with expected text (not a native browser dialog)
  const confirmDialog = page.locator(".dialog-panel").first();
  await expect(confirmDialog).toBeVisible({ timeout: 10000 });
  await expect(confirmDialog).toContainText("Delete recording");

  // Click the confirm button in the dialog
  const confirmButton = confirmDialog.locator("button.btn--danger").first();
  await confirmButton.click();

  // Wait for the view to return to archive (indicated by the back link disappearing)
  await page.locator(".back").waitFor({ state: "hidden", timeout: 10000 });

  // Assert we're back at the archive list and the deleted recording is gone.
  // Scoped to the visible archive list (not `body`) because the hidden (v-show)
  // detail view still holds the deleted recording's stale text in the DOM.
  const archiveList = page.locator(".lineup");
  await archiveList.waitFor({ state: "visible", timeout: 10000 });
  await expect(archiveList).not.toContainText("Test Delete Recording", {
    timeout: 10000,
  });
});

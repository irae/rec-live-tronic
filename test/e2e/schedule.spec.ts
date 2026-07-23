import { test, expect } from "@playwright/test";
import { seedScheduledRecording } from "./seed.js";

const BASE_URL = "http://127.0.0.1:8799";

test("schedule: create new recording", async ({ page }) => {
  await page.goto(`${BASE_URL}/`);

  // Click on Schedule link in navigation
  const scheduleLink = page.locator("a").filter({ hasText: "Schedule" });
  await scheduleLink.click();

  // Fill in the booking form
  const urlInput = page.locator("#url");
  const titleInput = page.locator("#title");
  const startInput = page.locator("#start");
  const stopInput = page.locator("#stop");
  const submitButton = page.locator("button[type=\"submit\"]");

  // Calculate future start/stop times
  const now = new Date();
  const startTime = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes from now
  const stopTime = new Date(now.getTime() + 65 * 60 * 1000); // 65 minutes from now

  // Format for datetime-local input (YYYY-MM-DDTHH:mm)
  const formatDatetimeLocal = (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  };

  await urlInput.fill("https://www.youtube.com/watch?v=test-schedule");
  await titleInput.fill("Test Schedule Create");
  await startInput.fill(formatDatetimeLocal(startTime));
  await stopInput.fill(formatDatetimeLocal(stopTime));

  // Click submit button
  await submitButton.click();

  // Wait for the new recording to appear in the queue/list
  await page.locator("text=Test Schedule Create").first().waitFor({ state: "visible", timeout: 10000 });
});

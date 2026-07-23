import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "iPhone 13",
      use: { ...devices["iPhone 13"] },
    },
    {
      name: "Desktop",
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
  ],

  webServer: {
    command:
      "npm run build && node dist/server.js",
    url: "http://127.0.0.1:8799/health",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      REC_LIVE_HOST: "127.0.0.1",
      REC_LIVE_PORT: "8799",
      REC_LIVE_DATA_DIR: resolve(projectRoot, ".local/e2e/state"),
      REC_LIVE_RECORDINGS_DIR: resolve(projectRoot, ".local/e2e/recordings"),
      REC_LIVE_PRIVATE_SOCKET: resolve(projectRoot, ".local/e2e/run/api.sock"),
      REC_LIVE_STREAMLINK_BIN: "/usr/bin/true",
      REC_LIVE_OEMBED_ENDPOINT: "http://127.0.0.1:1/oembed",
    },
  },

  baseURL: "http://127.0.0.1:8799",
});

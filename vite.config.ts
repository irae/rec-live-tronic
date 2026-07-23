import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webClientDir = resolve(__dirname, "web-client");

export default defineConfig({
  plugins: [vue()],
  root: webClientDir,
  build: {
    outDir: resolve(__dirname, "dist", "public"),
  },
  server: {
    proxy: {
      "/recordings": "http://localhost:8787",
      "/cookies": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { statfs } from "node:fs/promises";
import type { RecorderService } from "./api/service.js";
import type { Config } from "./config.js";

export class AppError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}

export type HealthState = "ok" | "error";

export interface HealthReport {
  process: HealthState;
  sqlite: HealthState;
  recordings: HealthState;
  dependencies: HealthState;
}

export interface AppDependencies {
  health: () => Promise<HealthReport>;
  recorder?: RecorderService;
  config?: Config;
  privateApi?: boolean;
}

type UploadedFile = { buffer: Buffer };
type MultipartRequest = Request & { file?: UploadedFile };
type MulterMiddleware = { single(field: string): RequestHandler };
type MulterFactory = ((options: { storage: unknown; limits: { fileSize: number; files: number } }) => MulterMiddleware) & { memoryStorage(): unknown };
const require = createRequire(import.meta.url);
const multer = require("multer") as MulterFactory;

function sanitizeFilename(title: string): string {
  // Replace unsafe characters and collapse whitespace
  const sanitized = title
    .replace(/[^a-zA-Z0-9._\- ]/g, "") // Remove non-ASCII-safe characters
    .replace(/\s+/g, " ") // Collapse multiple spaces
    .trim()
    .slice(0, 200); // Reasonable length cap
  // Append .ts extension
  return sanitized ? `${sanitized}.ts` : "";
}

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof AppError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof SyntaxError && (error as { status?: number }).status === 400) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request body must be valid JSON" } });
    return;
  }
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", async (_request, response, next) => {
    try {
      const health = await deps.health();
      const healthy = Object.values(health).every((state) => state === "ok");
      response.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks: health });
    } catch (error) {
      next(error);
    }
  });

  if (deps.recorder && !deps.privateApi) addPublicRoutes(app, deps.recorder, deps.config);
  if (deps.recorder && deps.privateApi) addPrivateRoutes(app, deps.recorder);

  if (!deps.privateApi) {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const publicPath = join(__dirname, "..", "dist", "public");
    app.use(express.static(publicPath));
    app.get("/*splat", (_request, response, next) => {
      response.sendFile(join(publicPath, "index.html"), (error) => {
        if (error) next(error);
      });
    });
  }

  app.use((_request, _response, next) => next(new AppError("NOT_FOUND", 404, "Route not found")));
  app.use(errorHandler as ErrorRequestHandler);
  return app;
}

function addPublicRoutes(app: express.Express, recorder: RecorderService, config?: Config): void {
  const json = express.json({ limit: "32kb" });
  app.post("/recordings", json, async (request, response, next) => {
    try { response.status(201).json({ recording: await recorder.createRecording(request.body) }); } catch (error) { next(error); }
  });
  app.get("/recordings", async (request, response, next) => {
    try {
      const trashed = request.query.trashed === "true" ? true : undefined;
      const recordings = trashed !== undefined
        ? recorder.listRecordings(undefined, { trashed })
        : recorder.listRecordings(request.query.status);
      const result: { recordings: unknown; is_recording: boolean; disk?: { actual_bytes: number; projected_bytes: number } } = {
        recordings,
        is_recording: recorder.listRecordings("recording").length > 0,
      };
      if (config) {
        try {
          const stats = await statfs(config.recordingsDir);
          const actualBytes = stats.bavail * stats.bsize;
          const remainingBytes = await recorder.getProjectedRemainingBytes();
          result.disk = { actual_bytes: actualBytes, projected_bytes: Math.max(0, actualBytes - remainingBytes) };
        } catch (error) {
          console.error("Failed to compute disk space:", error);
        }
      }
      response.json(result);
    } catch (error) { next(error); }
  });
  app.get("/recordings/oembed", async (request, response, next) => {
    try {
      const url = request.query.url;
      if (typeof url !== "string") throw new AppError("VALIDATION_ERROR", 400, "url is required");
      const metadata = await recorder.getOembedMetadata(url);
      response.json(metadata);
    } catch (error) { next(error); }
  });
  app.get("/recordings/formats", async (request, response, next) => {
    try {
      const url = request.query.url;
      if (typeof url !== "string") throw new AppError("VALIDATION_ERROR", 400, "url is required");
      const formats = await recorder.getAvailableFormats(url);
      response.json(formats);
    } catch (error) { next(error); }
  });
  app.get("/recordings/:id", (request, response, next) => {
    try { response.json({ recording: recorder.getRecording(request.params.id) }); } catch (error) { next(error); }
  });
  app.patch("/recordings/:id", json, async (request, response, next) => {
    try { response.json(await recorder.patchRecording(request.params.id, request.body)); } catch (error) { next(error); }
  });
  app.delete("/recordings/:id", async (request, response, next) => {
    try { response.json(await recorder.cancelRecording(request.params.id)); } catch (error) { next(error); }
  });
  app.get("/recordings/:id/file", (request, response, next) => {
    try {
      const { status, tsPath, title } = recorder.getRecordingFile(request.params.id);
      if (status !== "recorded") throw new AppError("STATUS_CONFLICT", 409, "Recording file is not ready to stream");
      // Without an explicit root, send's dotfile check inspects every segment
      // of the full absolute path (not just the part under recordingsDir), so
      // a dot-segment ancestor directory -- e.g. dev/test's .local/... -- gets
      // treated as a dotfile and 404s internally. Production's recordingsDir
      // (/srv/rec-live-tronic/recordings) has no dot segments, but allow them
      // explicitly since this path is server-constructed, not user input.
      const headers: { "Content-Type": string; "Content-Disposition"?: string } = { "Content-Type": "video/mp2t" };
      if (request.query.download === "1") {
        const sanitized = sanitizeFilename(title);
        const filename = sanitized || `${request.params.id}.ts`;
        headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      }
      response.sendFile(tsPath, { headers, dotfiles: "allow" }, (error) => {
        if (error) next(error);
      });
    } catch (error) { next(error); }
  });
  app.post("/recordings/:id/cut", json, async (request, response, next) => {
    try { response.status(200).json(await recorder.createCutDraft(request.params.id, request.body)); } catch (error) { next(error); }
  });
  app.get("/recordings/:id/cut/:draftId/pieces/:index/file", (request, response, next) => {
    try {
      const { filePath } = recorder.getCutPieceFile(request.params.id, request.params.draftId, request.params.index);
      response.sendFile(filePath, { headers: { "Content-Type": "video/mp2t" }, dotfiles: "allow" }, (error) => {
        if (error) next(error);
      });
    } catch (error) { next(error); }
  });
  app.delete("/recordings/:id/file", async (request, response, next) => {
    try { await recorder.trashRecording(request.params.id); response.status(204).end(); } catch (error) { next(error); }
  });
  app.post("/recordings/:id/restore", async (request, response, next) => {
    try { response.json({ recording: await recorder.restoreRecording(request.params.id) }); } catch (error) { next(error); }
  });
  app.delete("/recordings/:id/trash", async (request, response, next) => {
    try { await recorder.permanentDeleteRecording(request.params.id); response.status(204).end(); } catch (error) { next(error); }
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.post("/cookies", upload.single("file"), async (request, response, next) => {
    try {
      const file = (request as MultipartRequest).file;
      if (!file) throw new AppError("VALIDATION_ERROR", 400, "cookie file is required");
      response.status(201).json({ cookie: await recorder.createCookie(request.body.name, file.buffer) });
    } catch (error) { next(error); }
  });
  app.get("/cookies", (_request, response) => response.json({ cookies: recorder.listCookies() }));
  app.delete("/cookies/:id", async (request, response, next) => {
    try { await recorder.deleteCookie(request.params.id); response.status(204).end(); } catch (error) { next(error); }
  });
}

function addPrivateRoutes(app: express.Express, recorder: RecorderService): void {
  app.post("/internal/recordings/:id/transition", express.json({ limit: "16kb" }), (request, response, next) => {
    try { response.json({ recording: recorder.transition({ id: request.params.id, ...request.body }) }); } catch (error) { next(error); }
  });
}

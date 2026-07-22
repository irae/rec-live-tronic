import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import express from "express";
import { createRequire } from "node:module";
import type { RecorderService } from "./api/service.js";

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
  authenticate?: RequestHandler;
  health: () => Promise<HealthReport>;
  recorder?: RecorderService;
  privateApi?: boolean;
}

type UploadedFile = { buffer: Buffer };
type MultipartRequest = Request & { file?: UploadedFile };
type MulterMiddleware = { single(field: string): RequestHandler };
type MulterFactory = ((options: { storage: unknown; limits: { fileSize: number; files: number } }) => MulterMiddleware) & { memoryStorage(): unknown };
const require = createRequire(import.meta.url);
const multer = require("multer") as MulterFactory;

export const noOpAuthentication: RequestHandler = (_request, _response, next) => next();

function errorHandler(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  if (error instanceof AppError) {
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
}

export function createApp(deps: AppDependencies): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(deps.authenticate ?? noOpAuthentication);

  app.get("/health", async (_request, response, next) => {
    try {
      const health = await deps.health();
      const healthy = Object.values(health).every((state) => state === "ok");
      response.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", checks: health });
    } catch (error) {
      next(error);
    }
  });

  if (deps.recorder && !deps.privateApi) addPublicRoutes(app, deps.recorder);
  if (deps.recorder && deps.privateApi) addPrivateRoutes(app, deps.recorder);

  app.use((_request, _response, next) => next(new AppError("NOT_FOUND", 404, "Route not found")));
  app.use(errorHandler as ErrorRequestHandler);
  return app;
}

function addPublicRoutes(app: express.Express, recorder: RecorderService): void {
  const json = express.json({ limit: "32kb" });
  app.post("/recordings", json, async (request, response, next) => {
    try { response.status(201).json({ recording: recorder.createRecording(request.body) }); } catch (error) { next(error); }
  });
  app.get("/recordings", (request, response, next) => {
    try { response.json({ recordings: recorder.listRecordings(request.query.status) }); } catch (error) { next(error); }
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

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { sessionMiddleware } from "./lib/session";
import passport from "./lib/passport";
import { getAllowedOriginStrings } from "./lib/allowed-origins";
import { devBypassMiddleware, requireAuth, requireEditorForWrites } from "./middleware/auth";
import { csrfProtection } from "./middleware/csrf";
import authRouter from "./routes/auth";
import healthRouter from "./routes/health";
import router from "./routes";
import { publicFilesRouter } from "./routes/upload";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    const allowed = getAllowedOriginStrings();
    const isAllowed = allowed.some(a => a === origin) ||
      (process.env.NODE_ENV !== "production" && /^https?:\/\/localhost(:\d+)?$/.test(origin));
    callback(null, isAllowed);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

export { generationLimiter } from "./lib/rate-limit";

app.use(globalLimiter);

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());
app.use(csrfProtection);
app.use(devBypassMiddleware);

app.use((req, _res, next) => {
  if (req.path.startsWith("/api/v1/") || req.path === "/api/v1") {
    req.url = req.url.replace("/api/v1", "/api");
  }
  next();
});

app.use("/api", healthRouter);
app.use("/api", authRouter);

const fileServingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many file requests, please try again later." },
});

app.use("/api/files", fileServingLimiter);

// Public read of generated media — Instagram/TikTok pull it server-side with
// no session cookie. MUST be before requireAuth. Still rate-limited above.
app.use("/api", publicFilesRouter);

app.use("/api", requireAuth, requireEditorForWrites, router);

app.all("/api/{*path}", (_req: Request, res: Response) => {
  res.status(404).json({ error: "API endpoint not found" });
});

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode
    ?? 500;
  const message = err instanceof Error ? err.message : "Internal server error";
  logger.error({ err, path: req.path, method: req.method, status }, "Unhandled error");
  if (res.headersSent) return;
  const body = process.env.NODE_ENV === "production"
    ? { error: status >= 500 ? "Internal server error" : message }
    : { error: message };
  res.status(status).json(body);
});

export default app;

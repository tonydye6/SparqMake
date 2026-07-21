import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./seed";
import { cleanupDevBypassUser } from "./middleware/auth";
import {
  startTokenRefreshScheduler,
  stopTokenRefreshScheduler,
} from "./services/token-refresh";
import {
  startPublishScheduler,
  stopPublishScheduler,
} from "./services/publish-scheduler";
import {
  startMetricsScheduler,
  stopMetricsScheduler,
} from "./services/metrics-scheduler";
import { logStorageStartupStatus } from "./services/storage";
import { syncAdminEmails } from "./services/admin-sync";
import { db, sessionTurnsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

function startServer(seedFailed: boolean): Server {
  const server = app.listen(port, () => {
    logger.info(
      { port },
      seedFailed ? "Server listening (seed failed)" : "Server listening",
    );
    logStorageStartupStatus();
    try {
      startPublishScheduler();
    } catch (err) {
      logger.error(err, "Publish scheduler failed to start — scheduling disabled");
    }
    try {
      startTokenRefreshScheduler();
    } catch (err) {
      logger.error(err, "Token refresh scheduler failed to start — tokens will not auto-refresh");
    }
    try {
      startMetricsScheduler();
    } catch (err) {
      logger.error(err, "Metrics scheduler failed to start — post analytics ingestion disabled");
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logger.error(
        { port },
        `Port ${port} is already in use — another process may be serving stale code. Exiting.`,
      );
    } else {
      logger.error(err, "HTTP server error — exiting");
    }
    process.exit(1);
  });

  return server;
}

function registerShutdownHandlers(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, "Received shutdown signal — closing server");

    const forceExit = setTimeout(() => {
      logger.error("Graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    stopPublishScheduler();
    stopTokenRefreshScheduler();
    stopMetricsScheduler();

    server.close((err) => {
      if (err) {
        logger.error(err, "Error while closing HTTP server");
        clearTimeout(forceExit);
        process.exit(1);
        return;
      }
      logger.info("HTTP server closed — exiting cleanly");
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// C4: Mark any turns that were left in 'running' state (e.g. from a crashed
// process) as 'error' at startup.  Without this, they block the session
// turn-sequence check and can make the session appear permanently "busy".
// D4: Emit ONE prominent warning at startup when GEMINI_API_KEY is absent so
// admins can act before the first failed user session.  The actual 503 guard
// lives in the sessions/:id/turns route.
function warnMissingGeminiKey(): void {
  if (!process.env["GEMINI_API_KEY"]) {
    logger.warn(
      "GEMINI_API_KEY is not set — Co-pilot Studio (draft, edit, video, fan-out, " +
      "caption, compare) will return 503 for every turn. Set the secret and restart.",
    );
  }
}

async function sweepStaleTurns(): Promise<void> {
  try {
    const result = await db
      .update(sessionTurnsTable)
      .set({ status: "error", metadata: { error: "Turn interrupted by server restart" } })
      .where(eq(sessionTurnsTable.status, "running"))
      .returning({ id: sessionTurnsTable.id });
    if (result.length > 0) {
      logger.warn({ count: result.length }, "Marked stale 'running' turns as error on startup");
    }
  } catch (err) {
    logger.error({ err }, "Failed to sweep stale running turns — sessions may appear busy");
  }
}

seedDatabase()
  .then(async () => {
    warnMissingGeminiKey();
    await cleanupDevBypassUser();
    await syncAdminEmails();
    await sweepStaleTurns();
    const server = startServer(false);
    registerShutdownHandlers(server);
  })
  .catch(async (err) => {
    logger.error(err, "Failed to seed database");
    warnMissingGeminiKey();
    await cleanupDevBypassUser();
    await syncAdminEmails();
    await sweepStaleTurns();
    const server = startServer(true);
    registerShutdownHandlers(server);
  });

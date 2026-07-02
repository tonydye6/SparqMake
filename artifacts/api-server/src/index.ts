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

seedDatabase()
  .then(async () => {
    await cleanupDevBypassUser();
    const server = startServer(false);
    registerShutdownHandlers(server);
  })
  .catch(async (err) => {
    logger.error(err, "Failed to seed database");
    await cleanupDevBypassUser();
    const server = startServer(true);
    registerShutdownHandlers(server);
  });

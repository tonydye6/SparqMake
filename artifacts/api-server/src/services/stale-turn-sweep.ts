/**
 * C4: Startup sweep for stale 'running' session turns.
 *
 * A turn left in 'running' state (e.g. the process crashed mid-turn) blocks
 * the session's turn-sequence check and can make the session appear
 * permanently "busy".  This sweep marks all such turns as 'error' at startup.
 *
 * Extracted from index.ts so it can be exercised by integration tests without
 * booting the HTTP server.
 */

import { db, sessionTurnsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export async function sweepStaleTurns(): Promise<void> {
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

import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const PgSession = connectPgSimple(session);

const SESSION_SECRET = process.env.SESSION_SECRET || (
  process.env.NODE_ENV === "production"
    ? (() => { throw new Error("SESSION_SECRET is required in production"); })()
    : "sparqmake-dev-secret-change-in-production"
);

const SESSION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

async function ensureSessionTable() {
  try {
    await (pool as any).query(SESSION_TABLE_SQL);
  } catch (err) {
    logger.error("Failed to create session table:", err);
  }
}

ensureSessionTable();

export const sessionMiddleware = session({
  name: "sparqmake.sid",
  store: new PgSession({
    pool: pool as any,
    tableName: "session",
    createTableIfMissing: false,
  }),
  secret: SESSION_SECRET,
  resave: false,
  rolling: true,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: "lax",
  },
});

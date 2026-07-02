import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string | null;
      image: string | null;
      role: string;
    }
  }
}

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!user) {
      done(null, false);
      return;
    }
    done(null, {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
    });
  } catch (err) {
    done(err);
  }
});

const GOOGLE_CLIENT_ID = process.env.SparqMake_Google_Client_ID || process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.SparqMake_Google_Client_Secret || process.env.GOOGLE_CLIENT_SECRET;
function resolveGoogleCallbackUrl(): string {
  if (process.env.GOOGLE_CALLBACK_URL) return process.env.GOOGLE_CALLBACK_URL;
  const callbackPath = "/api/auth/google/callback";
  if (process.env.APP_URL) return `${process.env.APP_URL.replace(/\/$/, "")}${callbackPath}`;
  if (process.env.REPLIT_DEPLOYMENT) {
    const domains = process.env.REPLIT_DOMAINS;
    if (domains) {
      const first = domains.split(",")[0]?.trim();
      if (first) return `https://${first}${callbackPath}`;
    }
  }
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}${callbackPath}`;
  if (process.env.REPLIT_DOMAINS) {
    const first = process.env.REPLIT_DOMAINS.split(",")[0]?.trim();
    if (first) return `https://${first}${callbackPath}`;
  }
  return callbackPath;
}

const GOOGLE_CALLBACK_URL = resolveGoogleCallbackUrl();

if (!GOOGLE_CALLBACK_URL.startsWith("http")) {
  logger.warn("Google OAuth callback URL is relative — set APP_URL or GOOGLE_CALLBACK_URL for reliable behavior behind proxies");
}

/**
 * Env-var allow-list gate for emails that have NEVER signed in or been invited.
 *
 * There are two independent ways an email becomes able to sign in:
 *  1. An invite: an admin pre-creates the user row via the User Management tab
 *     (services/user-management.ts inviteUser). The existing DB row itself
 *     authorizes the email — this function is NOT consulted for it.
 *  2. The env allow-list below (ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS), which
 *     admits strangers with no pre-existing row (they are auto-created as
 *     viewer, or admin if in ADMIN_EMAILS).
 *
 * Keep this in mind when editing: tightening the env vars does not lock out
 * invited/existing users, and removing a user's row (via User Management)
 * revokes their access unless the env list still covers them.
 */
function isEmailAllowed(email: string): boolean {
  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const emails = (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0 && emails.length === 0) {
    logger.error("ALLOWED_EMAIL_DOMAINS and ALLOWED_EMAILS are both unset — rejecting all sign-ins for safety");
    return false;
  }
  const lower = email.toLowerCase();
  if (emails.includes(lower)) return true;
  const domain = lower.split("@")[1] ?? "";
  return domains.includes(domain);
}

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

function resolveInitialRole(email: string): "viewer" | "editor" | "admin" {
  return ADMIN_EMAILS.has(email.toLowerCase()) ? "admin" : "viewer";
}

/** The subset of a passport-google-oauth20 Profile that the verify logic reads. */
export interface GoogleProfileLike {
  displayName?: string;
  emails?: Array<{ value: string; verified?: boolean | string }>;
  photos?: Array<{ value: string }>;
}

type VerifyDone = (err: Error | null | undefined, user?: Express.User | false) => void;

/**
 * Verify callback for the Google OAuth strategy, exported for unit testing.
 *
 * Sign-in is authorized by EITHER of two independent gates:
 *  - an existing user row (previous sign-in OR an admin invite pre-created it
 *    via User Management) — matched case-insensitively by email; or
 *  - the env allow-list (ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS) for brand-new
 *    emails, which are auto-created with a default role.
 */
export async function verifyGoogleProfile(profile: GoogleProfileLike, done: VerifyDone): Promise<void> {
  try {
    const emailEntry = profile.emails?.[0];
    const email = emailEntry?.value;
    if (!email) {
      done(new Error("No email found in Google profile"));
      return;
    }

    const emailVerified = emailEntry?.verified;
    if (emailVerified === false || emailVerified === "false") {
      logger.warn({ email }, "Rejected login: email not verified by Google");
      done(null, false);
      return;
    }

    // An existing user row (created by a prior sign-in OR pre-created by
    // an admin invite in User Management) authorizes this email on its
    // own. The env allow-list below only gates brand-new emails with no
    // row — see the isEmailAllowed doc comment for the full contract.
    // Invites store emails lowercased, so match case-insensitively.
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email.toLowerCase()}`)
      .limit(1);

    if (!existing && !isEmailAllowed(email)) {
      logger.warn({ email }, "Rejected login: email not invited and not in allow-list");
      done(null, false);
      return;
    }

    if (existing) {
      const [updated] = await db
        .update(usersTable)
        .set({
          name: profile.displayName || existing.name,
          image: profile.photos?.[0]?.value || existing.image,
          updatedAt: new Date(),
        })
        .where(eq(usersTable.id, existing.id))
        .returning();

      done(null, {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        image: updated.image,
        role: updated.role,
      });
      return;
    }

    const [newUser] = await db
      .insert(usersTable)
      .values({
        email,
        name: profile.displayName || email,
        image: profile.photos?.[0]?.value || null,
        role: resolveInitialRole(email),
      })
      .returning();

    done(null, {
      id: newUser.id,
      email: newUser.email,
      name: newUser.name,
      image: newUser.image,
      role: newUser.role,
    });
  } catch (err) {
    done(err as Error);
  }
}

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      (_accessToken, _refreshToken, profile, done) => {
        void verifyGoogleProfile(profile as GoogleProfileLike, done);
      },
    ),
  );
  logger.info("Google OAuth strategy configured");
} else {
  logger.warn("Google OAuth not configured: missing SparqMake_Google_Client_ID / GOOGLE_CLIENT_ID or SparqMake_Google_Client_Secret / GOOGLE_CLIENT_SECRET");
}

export default passport;

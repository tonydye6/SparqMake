import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const emailEntry = profile.emails?.[0];
          const email = emailEntry?.value;
          if (!email) {
            done(new Error("No email found in Google profile"));
            return;
          }

          const emailVerified = (emailEntry as { verified?: boolean | string } | undefined)?.verified;
          if (emailVerified === false || emailVerified === "false") {
            logger.warn({ email }, "Rejected login: email not verified by Google");
            done(null, false);
            return;
          }

          if (!isEmailAllowed(email)) {
            logger.warn({ email }, "Rejected login: email not in allow-list");
            done(null, false);
            return;
          }

          const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));

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
      },
    ),
  );
  logger.info("Google OAuth strategy configured");
} else {
  logger.warn("Google OAuth not configured: missing SparqMake_Google_Client_ID / GOOGLE_CLIENT_ID or SparqMake_Google_Client_Secret / GOOGLE_CLIENT_SECRET");
}

export default passport;

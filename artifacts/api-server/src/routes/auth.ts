import { Router, type IRouter } from "express";
import passport from "../lib/passport";
import { isDevBypass, isGoogleConfigured } from "../middleware/auth";

const router: IRouter = Router();

function sanitizeReturnTo(returnTo: string | undefined): string {
  if (!returnTo) return "/";
  if (typeof returnTo !== "string") return "/";
  if (!returnTo.startsWith("/")) return "/";
  if (returnTo.startsWith("//")) return "/";
  if (returnTo.startsWith("/\\")) return "/";
  if (returnTo.includes("\\")) return "/";
  if (returnTo.includes("://")) return "/";
  return returnTo;
}

router.get("/auth/me", (req, res): void => {
  if (req.user) {
    res.json({
      authenticated: true,
      user: req.user,
    });
    return;
  }
  res.json({ authenticated: false, user: null });
});

router.get("/auth/google", (req, res, next) => {
  if (isDevBypass()) {
    res.redirect("/");
    return;
  }

  if (!isGoogleConfigured()) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  const returnTo = sanitizeReturnTo(req.query.returnTo as string);
  (req.session as any).returnTo = returnTo;

  passport.authenticate("google", {
    scope: ["profile", "email"],
    state: true as any,
  })(req, res, next);
});

router.get(
  "/auth/google/callback",
  (req, res, next) => {
    if (!isGoogleConfigured()) {
      res.status(503).json({ error: "Google OAuth is not configured" });
      return;
    }
    passport.authenticate("google", (err: Error | null, user: Express.User | false) => {
      if (err || !user) {
        console.error("Google OAuth callback error:", err?.message || "No user returned");
        res.redirect("/login?error=auth_failed");
        return;
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          console.error("Session login error:", loginErr.message);
          res.redirect("/login?error=auth_failed");
          return;
        }
        const returnTo = sanitizeReturnTo((req.session as any).returnTo);
        delete (req.session as any).returnTo;
        res.redirect(returnTo);
      });
    })(req, res, next);
  },
);

router.post("/auth/logout", (req, res): void => {
  req.logout((err) => {
    if (err) {
      res.status(500).json({ error: "Logout failed" });
      return;
    }
    req.session.destroy((sessionErr) => {
      if (sessionErr) {
        res.status(500).json({ error: "Session destruction failed" });
        return;
      }
      res.clearCookie("sparqmake.sid");
      res.json({ success: true });
    });
  });
});

export default router;

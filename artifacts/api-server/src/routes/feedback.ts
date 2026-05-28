import { Router } from "express";
import { logger } from "../lib/logger";

const router = Router();

router.post("/feedback", (req, res) => {
  const { type, message } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "Message is required" });
    return;
  }

  const user = req.user as { id?: string; email?: string } | undefined;
  const userId = user?.id || "anonymous";
  const userEmail = user?.email || null;

  logger.info({
    feedbackType: type || "other",
    message: message.trim(),
    userId,
    userEmail,
  }, "User feedback received");

  res.json({ success: true });
});

export default router;

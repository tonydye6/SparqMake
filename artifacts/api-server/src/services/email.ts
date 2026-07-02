import nodemailer from "nodemailer";
import { logger } from "../lib/logger";

/**
 * Minimal SMTP email sender. Configured entirely through environment
 * variables so the team can plug in any provider (Gmail, SES, Postmark,
 * Mailgun, etc.) that exposes SMTP:
 *
 *   SMTP_HOST   (required) e.g. smtp.postmarkapp.com
 *   SMTP_FROM   (required) e.g. "SparqMake Alerts <alerts@example.com>"
 *   SMTP_PORT   (optional, default 587)
 *   SMTP_SECURE (optional, "true" for implicit TLS/port 465)
 *   SMTP_USER   (optional)
 *   SMTP_PASS   (optional)
 *
 * When unconfigured, `isEmailConfigured()` is false and callers should skip
 * sending (never throw) — in-app visibility must keep working without SMTP.
 */

export interface SendEmailOptions {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export function isEmailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export async function sendEmail(options: SendEmailOptions): Promise<{ sent: boolean; error?: string }> {
  if (!isEmailConfigured()) {
    return { sent: false, error: "Email is not configured (SMTP_HOST / SMTP_FROM missing)" };
  }
  if (options.to.length === 0) {
    return { sent: false, error: "No recipients" };
  }

  const port = Number.parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = process.env.SMTP_SECURE === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number.isFinite(port) ? port : 587,
      secure,
      auth: user ? { user, pass } : undefined,
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: options.to.join(", "),
      subject: options.subject,
      text: options.text,
      html: options.html,
    });

    // Never log recipient addresses or message bodies — count only.
    logger.info({ recipientCount: options.to.length, subject: options.subject }, "Alert email sent");
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown email error";
    logger.error({ err, recipientCount: options.to.length }, "Alert email send failed");
    return { sent: false, error: message };
  }
}

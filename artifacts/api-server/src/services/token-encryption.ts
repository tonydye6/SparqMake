import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let warnedFallback = false;
function getEncryptionKey(): Buffer {
  const dedicated = process.env.TOKEN_ENCRYPTION_KEY;
  if (dedicated) {
    return crypto.createHash("sha256").update(dedicated).digest();
  }
  const fallback = process.env.NEXTAUTH_SECRET || process.env.SESSION_SECRET;
  if (!fallback) {
    throw new Error("TOKEN_ENCRYPTION_KEY (preferred) or NEXTAUTH_SECRET/SESSION_SECRET is required for token encryption");
  }
  if (!warnedFallback) {
    warnedFallback = true;
    console.warn("[token-encryption] TOKEN_ENCRYPTION_KEY not set; falling back to NEXTAUTH_SECRET/SESSION_SECRET. Set a dedicated TOKEN_ENCRYPTION_KEY in production to allow rotating session secrets independently.");
  }
  return crypto.createHash("sha256").update(fallback).digest();
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted token format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

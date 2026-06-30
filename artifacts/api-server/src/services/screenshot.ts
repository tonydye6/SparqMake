import * as path from "path";
import * as net from "net";
import { writeBuffer, contentTypeFor } from "./storage.js";

const BLOCKED_HOSTNAMES = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254",
];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false;
  if (parts[0] === 0) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

function parseIPv6MappedIPv4(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, "");

  const dottedMatch = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dottedMatch) return dottedMatch[1];

  const hexMatch = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return null;
}

function isBlockedIPv6(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if (bare === "::1" || bare === "::") return true;

  if (/^fe80:/i.test(bare)) return true;

  if (/^fc00:/i.test(bare) || /^fd[0-9a-f]{2}:/i.test(bare)) return true;

  return false;
}

export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.includes(hostname)) {
    throw new Error("This URL target is not allowed");
  }

  const mappedIPv4 = parseIPv6MappedIPv4(hostname);
  if (mappedIPv4) {
    if (isPrivateIPv4(mappedIPv4)) {
      throw new Error("IPv6-mapped private addresses are not allowed");
    }
  }

  if (isBlockedIPv6(hostname)) {
    throw new Error("Blocked IPv6 addresses are not allowed");
  }

  const bareHost = hostname.replace(/^\[|\]$/g, "");
  if (net.isIPv4(bareHost)) {
    if (isPrivateIPv4(bareHost)) {
      throw new Error("Private IP addresses are not allowed");
    }
  }
}

export interface ScreenshotResult {
  filename: string;
  url: string;
  viewport: string;
  buffer: Buffer;
  mimeType: string;
}

export async function captureScreenshots(
  targetUrl: string,
  creativeId: string,
): Promise<ScreenshotResult[]> {
  const apiKey = process.env.SparqMake_ScreenshotOne_API_Key;
  if (!apiKey) {
    throw new Error("ScreenshotOne API key not configured (SparqMake_ScreenshotOne_API_Key)");
  }

  const viewports = [
    { width: 1440, height: 900, label: "desktop" },
    { width: 375, height: 812, label: "mobile" },
  ];

  const results: ScreenshotResult[] = [];

  for (const vp of viewports) {
    const params = new URLSearchParams({
      access_key: apiKey,
      url: targetUrl,
      full_page: "true",
      viewport_width: String(vp.width),
      viewport_height: String(vp.height),
      format: "png",
      block_ads: "true",
      block_cookie_banners: "true",
      block_trackers: "true",
      delay: "3",
      timeout: "30",
    });

    const screenshotUrl = `https://api.screenshotone.com/take?${params.toString()}`;

    const response = await fetch(screenshotUrl);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`ScreenshotOne API error for ${vp.label} viewport: ${response.status} - ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const timestamp = Date.now();
    const filename = `ref-${creativeId}-${vp.label}-${timestamp}.png`;

    await writeBuffer("generated", filename, buffer);

    results.push({
      filename,
      url: `/api/files/generated/${filename}`,
      viewport: vp.label,
      buffer,
      mimeType: "image/png",
    });
  }

  return results;
}

export async function captureFromUpload(
  fileBuffer: Buffer,
  creativeId: string,
  originalName: string,
): Promise<ScreenshotResult> {
  const ext = path.extname(originalName) || ".png";
  const timestamp = Date.now();
  const filename = `ref-${creativeId}-upload-${timestamp}${ext}`;

  await writeBuffer("generated", filename, fileBuffer);

  return {
    filename,
    url: `/api/files/generated/${filename}`,
    viewport: "upload",
    buffer: fileBuffer,
    mimeType: contentTypeFor(filename),
  };
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function getAllowedOriginStrings(): string[] {
  const origins: string[] = [];

  // The app is served same-origin behind Replit's path-based proxy, which
  // forwards requests internally through localhost:80. Same-origin requests
  // from the app (dev preview and deployed) therefore arrive with an
  // `Origin: http://localhost` header, so it must always be allowed. This is
  // not a CSRF weakness: a browser only sends a localhost origin for pages
  // actually served from localhost, never for a genuine cross-origin attacker.
  origins.push("http://localhost");

  if (process.env.CORS_ORIGIN) {
    origins.push(...process.env.CORS_ORIGIN.split(",").map(normalizeOrigin));
  }

  if (process.env.APP_URL) {
    origins.push(normalizeOrigin(process.env.APP_URL));
  }

  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) {
    origins.push(`https://${devDomain}`);
  }

  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    for (const d of domains.split(",")) {
      const trimmed = d.trim();
      if (trimmed) origins.push(`https://${trimmed}`);
    }
  }

  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:3000", "http://localhost:5173", "http://localhost:19060");
  }

  return [...new Set(origins)];
}

/**
 * Central resolver for social platform (X/Twitter, Instagram, LinkedIn,
 * TikTok, YouTube) OAuth developer credentials.
 *
 * All credential reads MUST go through this module — never read
 * `process.env.SparqMake_*` / `SparqForge_*` directly. The SparqForge →
 * SparqMake rename left secrets stored under a mix of both prefixes, so each
 * credential has a canonical (SparqMake) env var name plus legacy aliases
 * that are accepted transparently.
 *
 * Values that are obvious placeholders (e.g. an Instagram App ID literally
 * set to "INSTAGRAM_APP_ID", or "your_client_id" / "changeme" patterns) are
 * treated as unconfigured so the UI status endpoint reflects reality.
 */

export type SocialPlatform = "twitter" | "instagram" | "linkedin" | "tiktok" | "youtube";
export type CredentialKey = "clientId" | "clientSecret";

interface CredentialSource {
  /** Human-readable name shown in the Settings UI when missing. */
  label: string;
  /** Canonical env var name (what admins should set going forward). */
  canonical: string;
  /** Legacy env var names still accepted (SparqForge era, generic names). */
  aliases: string[];
}

const CREDENTIAL_SOURCES: Record<SocialPlatform, Record<CredentialKey, CredentialSource>> = {
  twitter: {
    clientId: {
      label: "X (Twitter) API Key",
      canonical: "X_SparqMake_X_API_Key",
      aliases: ["X_SparqForge_X_API_Key"],
    },
    clientSecret: {
      label: "X (Twitter) API Secret",
      canonical: "X_SparqMake_X_API_Secret",
      aliases: ["X_SparqForge_X_API_Secret"],
    },
  },
  instagram: {
    clientId: {
      label: "Instagram App ID",
      canonical: "SparqMake_Instagram_App_ID",
      aliases: ["SparqForge_Instagram_App_ID"],
    },
    clientSecret: {
      label: "Instagram App Secret",
      canonical: "SparqMake_Instagram_App_Secret",
      aliases: ["SparqForge_Instagram_App_Secret"],
    },
  },
  linkedin: {
    clientId: {
      label: "LinkedIn Client ID",
      canonical: "SparqMake_LinkedIn_Client_ID",
      aliases: ["SparqForge_LinkedIn_Client_ID"],
    },
    clientSecret: {
      label: "LinkedIn Client Secret",
      canonical: "SparqMake_LinkedIn_Client_Secret",
      aliases: ["SparqForge_LinkedIn_Client_Secret"],
    },
  },
  tiktok: {
    clientId: {
      label: "TikTok Client Key",
      canonical: "SparqMake_TikTok_Client_ID",
      aliases: ["SparqForge_TikTok_Client_ID"],
    },
    clientSecret: {
      label: "TikTok Client Secret",
      canonical: "SparqMake_TikTok_Client_Secret",
      aliases: ["SparqForge_TikTok_Client_Secret"],
    },
  },
  youtube: {
    clientId: {
      label: "Google Client ID",
      canonical: "SparqMake_Google_Client_ID",
      aliases: ["SparqForge_Google_Client_ID", "GOOGLE_CLIENT_ID"],
    },
    clientSecret: {
      label: "Google Client Secret",
      canonical: "SparqMake_Google_Client_Secret",
      aliases: ["SparqForge_Google_Client_Secret", "GOOGLE_CLIENT_SECRET"],
    },
  },
};

/**
 * Which credential keys a platform needs before the "Connect" flow can work.
 * Twitter uses OAuth2 PKCE (public client) — the connect + callback flow only
 * needs the client id. The other platforms exchange the auth code with a
 * client secret.
 */
const REQUIRED_KEYS: Record<SocialPlatform, CredentialKey[]> = {
  twitter: ["clientId"],
  instagram: ["clientId", "clientSecret"],
  linkedin: ["clientId", "clientSecret"],
  tiktok: ["clientId", "clientSecret"],
  youtube: ["clientId", "clientSecret"],
};

/**
 * Detect values that are clearly placeholders rather than real credentials:
 *  - ALL_CAPS_WITH_UNDERSCORES (someone pasted the env var *name* as the value,
 *    e.g. "INSTAGRAM_APP_ID");
 *  - your_* / your-* prefixes, "changeme", "placeholder", "xxx"-style filler.
 */
function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed) && trimmed.includes("_")) return true;
  if (/^(your[_-]|changeme|change[_-]me|placeholder|todo[_-]?|xxx+$)/i.test(trimmed)) return true;
  return false;
}

function readEnv(source: CredentialSource): string | null {
  for (const name of [source.canonical, ...source.aliases]) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() && !isPlaceholder(value)) {
      return value.trim();
    }
  }
  return null;
}

/**
 * Resolve a platform credential, accepting canonical SparqMake names and
 * legacy SparqForge aliases. Returns null when unset or set to an obvious
 * placeholder value.
 */
export function getSocialCredential(platform: SocialPlatform, key: CredentialKey): string | null {
  return readEnv(CREDENTIAL_SOURCES[platform][key]);
}

export interface PlatformConfigStatus {
  platform: SocialPlatform;
  configured: boolean;
  /** Which required credentials are absent (names/labels only — never values). */
  missing: { key: CredentialKey; label: string; envVar: string }[];
}

/**
 * Configuration status for every supported platform, for the
 * GET /api/social-platforms/status endpoint. Exposes env var *names* and
 * labels only — never secret values.
 */
export function getPlatformConfigStatus(): PlatformConfigStatus[] {
  return (Object.keys(CREDENTIAL_SOURCES) as SocialPlatform[]).map((platform) => {
    const missing = REQUIRED_KEYS[platform]
      .filter((key) => getSocialCredential(platform, key) === null)
      .map((key) => ({
        key,
        label: CREDENTIAL_SOURCES[platform][key].label,
        envVar: CREDENTIAL_SOURCES[platform][key].canonical,
      }));
    return { platform, configured: missing.length === 0, missing };
  });
}

export interface TwitterOAuth1Credentials {
  consumerKey: string;
  consumerSecret: string;
  oauthToken: string;
  oauthTokenSecret: string;
}

const TWITTER_OAUTH1_SOURCES: Record<keyof TwitterOAuth1Credentials, CredentialSource> = {
  consumerKey: {
    label: "X (Twitter) API Key",
    canonical: "X_SparqMake_X_API_Key",
    aliases: ["X_SparqForge_X_API_Key"],
  },
  consumerSecret: {
    label: "X (Twitter) API Secret",
    canonical: "X_SparqMake_X_API_Secret",
    aliases: ["X_SparqForge_X_API_Secret"],
  },
  oauthToken: {
    label: "X (Twitter) Access Token",
    canonical: "X_SparqMake_X_Access_Token",
    aliases: ["X_SparqForge_X_Access_Token"],
  },
  oauthTokenSecret: {
    label: "X (Twitter) Access Token Secret",
    canonical: "X_SparqMake_X_Access_Token_Secret",
    aliases: ["X_SparqForge_X_Access_Token_Secret"],
  },
};

/**
 * OAuth 1.0a credentials for Twitter media upload (v1.1 media/upload.json
 * still requires OAuth 1.0a). Returns null unless all four values are
 * configured. These must belong to the same account whose OAuth2 Bearer
 * token is used for tweet creation.
 */
export function getTwitterOAuth1Credentials(): TwitterOAuth1Credentials | null {
  const consumerKey = readEnv(TWITTER_OAUTH1_SOURCES.consumerKey);
  const consumerSecret = readEnv(TWITTER_OAUTH1_SOURCES.consumerSecret);
  const oauthToken = readEnv(TWITTER_OAUTH1_SOURCES.oauthToken);
  const oauthTokenSecret = readEnv(TWITTER_OAUTH1_SOURCES.oauthTokenSecret);
  if (!consumerKey || !consumerSecret || !oauthToken || !oauthTokenSecret) return null;
  return { consumerKey, consumerSecret, oauthToken, oauthTokenSecret };
}

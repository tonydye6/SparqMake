import { Router } from "express";
import crypto from "crypto";
import { db, socialAccountsTable, brandsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { encryptToken } from "../services/token-encryption";
import { logger } from "../lib/logger";
import type {
  TwitterTokenResponse,
  TwitterUserResponse,
  FacebookTokenResponse,
  FacebookPagesResponse,
  FacebookPageIGResponse,
  InstagramUserResponse,
  LinkedInTokenResponse,
  LinkedInProfileResponse,
  TikTokTokenResponse,
  TikTokUserInfoResponse,
  GoogleTokenResponse,
  YouTubeChannelResponse,
} from "../types/oauth";
import { getSocialCredential } from "../services/social-credentials";

const router = Router();

function resolveBaseUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, "");
  }
  if (process.env.REPLIT_DEPLOYMENT) {
    const domains = process.env.REPLIT_DOMAINS;
    if (domains) {
      const firstDomain = domains.split(",")[0].trim();
      if (firstDomain) {
        return `https://${firstDomain}`;
      }
    }
  }
  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (devDomain) {
    return `https://${devDomain}`;
  }
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const firstDomain = domains.split(",")[0].trim();
    if (firstDomain) {
      return `https://${firstDomain}`;
    }
  }
  return "http://localhost:3000";
}

function getCallbackBaseUrl(): string {
  return resolveBaseUrl();
}

function getSettingsRedirectUrl(): string {
  return `${resolveBaseUrl()}/settings?tab=accounts`;
}

const STATE_TTL_MS = 10 * 60 * 1000;

const pkceStore = new Map<string, { verifier: string; userId: string; brandId: string; expiresAt: number }>();
const oauthStateStore = new Map<string, { userId: string; brandId: string; expiresAt: number }>();

// Periodic sweep so abandoned OAuth flows don't leak memory. Single-instance only
// (a Reserved VM runs exactly one process); defer a shared Redis store for multi-instance.
const stateSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pkceStore) if (val.expiresAt < now) pkceStore.delete(key);
  for (const [key, val] of oauthStateStore) if (val.expiresAt < now) oauthStateStore.delete(key);
}, 5 * 60 * 1000);
stateSweep.unref();

function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function createOAuthState(userId: string, brandId: string): string {
  const state = crypto.randomBytes(16).toString("hex");
  oauthStateStore.set(state, { userId, brandId, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

// Consumes the state (single-use) and returns the stored entry only when it is
// valid for this user, so callers can read the brandId captured at connect time.
function consumeOAuthState(
  state: string | undefined,
  userId: string | undefined,
): { userId: string; brandId: string } | null {
  if (!state || typeof state !== "string" || !userId) return null;
  const data = oauthStateStore.get(state);
  if (!data || data.expiresAt < Date.now()) {
    if (data) oauthStateStore.delete(state);
    return null;
  }
  oauthStateStore.delete(state);
  if (data.userId !== userId) return null;
  return { userId: data.userId, brandId: data.brandId };
}

// Resolve the brand a social account is being connected for. Social accounts are
// brand-scoped, so connect requests must carry a valid brandId query param.
async function resolveConnectBrandId(brandId: unknown): Promise<string | null> {
  if (typeof brandId !== "string" || !brandId) return null;
  const [brand] = await db
    .select({ id: brandsTable.id })
    .from(brandsTable)
    .where(eq(brandsTable.id, brandId));
  return brand ? brand.id : null;
}

// Re-connecting an already-linked account updates it in place rather than inserting
// a duplicate row. Atomic via the unique index on (platform, account_id) so two
// concurrent callbacks can't race into two rows. A null incoming refresh token keeps
// the existing one (some providers only return a refresh token on first consent);
// likewise a null profile image keeps the stored value.
async function upsertSocialAccount(values: typeof socialAccountsTable.$inferInsert): Promise<void> {
  await db
    .insert(socialAccountsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [socialAccountsTable.platform, socialAccountsTable.accountId],
      set: {
        accountName: sql`excluded.account_name`,
        accessToken: sql`excluded.access_token`,
        refreshToken: sql`coalesce(excluded.refresh_token, ${socialAccountsTable.refreshToken})`,
        tokenExpiry: sql`excluded.token_expiry`,
        profileImageUrl: sql`coalesce(excluded.profile_image_url, ${socialAccountsTable.profileImageUrl})`,
        avatarUrl: sql`coalesce(excluded.avatar_url, ${socialAccountsTable.avatarUrl})`,
        platformMetadata: sql`coalesce(excluded.platform_metadata, ${socialAccountsTable.platformMetadata})`,
        brandId: sql`excluded.brand_id`,
        status: sql`excluded.status`,
        // A fresh OAuth grant wipes any stale refresh-failure record.
        lastRefreshAt: new Date(),
        lastRefreshError: null,
        updatedAt: new Date(),
      },
    });
}

router.get("/auth/twitter", async (req, res) => {
  const clientId = getSocialCredential("twitter", "clientId");
  if (!clientId) {
    logger.error("Twitter connect attempted but API key is not configured");
    return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=twitter`);
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const brandId = await resolveConnectBrandId(req.query.brandId);
  if (!brandId) {
    return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_brand`);
  }

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  pkceStore.set(state, { verifier, userId, brandId, expiresAt: Date.now() + STATE_TTL_MS });

  const callbackUrl = `${getCallbackBaseUrl()}/api/auth/twitter/callback`;
  const scopes = ["tweet.read", "tweet.write", "users.read", "offline.access"].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params.toString()}`);
});

router.get("/auth/twitter/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      return res.redirect(`${getSettingsRedirectUrl()}&error=missing_params`);
    }

    const pkceData = pkceStore.get(state);
    if (!pkceData || pkceData.expiresAt < Date.now()) {
      pkceStore.delete(state as string);
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }
    pkceStore.delete(state);

    if (pkceData.userId !== req.user?.id) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }

    const clientId = getSocialCredential("twitter", "clientId");
    if (!clientId) {
      logger.error("Twitter OAuth callback but API key is not configured");
      return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=twitter`);
    }
    const callbackUrl = `${getCallbackBaseUrl()}/api/auth/twitter/callback`;

    const tokenResponse = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        code_verifier: pkceData.verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      logger.error({ status: tokenResponse.status, body: errBody }, "Twitter token exchange failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    const tokenData = (await tokenResponse.json()) as TwitterTokenResponse;

    const userResponse = await fetch("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=user_fetch_failed`);
    }

    const userData = (await userResponse.json()) as TwitterUserResponse;

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    await upsertSocialAccount({
      platform: "twitter",
      accountName: `@${userData.data.username}`,
      accountId: userData.data.id,
      accessToken: encryptToken(tokenData.access_token),
      refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      tokenExpiry: expiresAt,
      brandId: pkceData.brandId,
      status: "connected",
    });

    res.redirect(`${getSettingsRedirectUrl()}&success=twitter`);
  } catch (err) {
    logger.error(err, "Twitter callback error");
    res.redirect(`${getSettingsRedirectUrl()}&error=callback_error`);
  }
});

router.get("/auth/instagram", async (req, res) => {
  const appId = getSocialCredential("instagram", "clientId");
  if (!appId) {
    logger.error("Instagram connect attempted but App ID is not configured");
    return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=instagram`);
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const brandId = await resolveConnectBrandId(req.query.brandId);
  if (!brandId) {
    return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_brand`);
  }

  const state = createOAuthState(userId, brandId);
  const callbackUrl = `${getCallbackBaseUrl()}/api/auth/instagram/callback`;
  const scopes = ["instagram_basic", "instagram_content_publish", "pages_show_list"].join(",");

  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: callbackUrl,
    scope: scopes,
    response_type: "code",
    state,
  });

  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`);
});

router.get("/auth/instagram/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    const stateData = consumeOAuthState(state as string | undefined, req.user?.id);
    if (!stateData) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }

    if (!code || typeof code !== "string") {
      return res.redirect(`${getSettingsRedirectUrl()}&error=missing_code`);
    }

    const appId = getSocialCredential("instagram", "clientId");
    const appSecret = getSocialCredential("instagram", "clientSecret");
    if (!appId || !appSecret) {
      logger.error("Instagram OAuth callback but App ID/Secret is not configured");
      return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=instagram`);
    }
    const callbackUrl = `${getCallbackBaseUrl()}/api/auth/instagram/callback`;

    const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", appId);
    tokenUrl.searchParams.set("redirect_uri", callbackUrl);
    tokenUrl.searchParams.set("client_secret", appSecret);
    tokenUrl.searchParams.set("code", code);

    const tokenResp = await fetch(tokenUrl.toString());

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      logger.error({ status: tokenResp.status, body: errBody }, "Instagram token exchange failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    const tokenData = (await tokenResp.json()) as FacebookTokenResponse;

    // Facebook's token exchange API requires fb_exchange_token as a GET query parameter.
    // This is a Facebook API requirement and cannot be sent as a POST body.
    // We intentionally avoid logging the URL to prevent exposing the short-lived token.
    const longLivedUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", appId);
    longLivedUrl.searchParams.set("client_secret", appSecret);
    longLivedUrl.searchParams.set("fb_exchange_token", tokenData.access_token);

    const longLivedResp = await fetch(longLivedUrl.toString());
    const longLivedData = (await longLivedResp.json()) as FacebookTokenResponse;
    const accessToken = longLivedData.access_token || tokenData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000;

    const pagesResp = await fetch(
      "https://graph.facebook.com/v19.0/me/accounts",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const pagesData = (await pagesResp.json()) as FacebookPagesResponse;

    let igAccountName = "Instagram Business";
    let igAccountId = "";

    if (pagesData.data && pagesData.data.length > 0) {
      const page = pagesData.data[0];
      const igResp = await fetch(
        `https://graph.facebook.com/v19.0/${page.id}?fields=instagram_business_account`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const igData = (await igResp.json()) as FacebookPageIGResponse;

      if (igData.instagram_business_account) {
        igAccountId = igData.instagram_business_account.id;
        const igUserResp = await fetch(
          `https://graph.facebook.com/v19.0/${igAccountId}?fields=username`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        const igUserData = (await igUserResp.json()) as InstagramUserResponse;
        igAccountName = `@${igUserData.username || "instagram_user"}`;
      }
    }

    if (!igAccountId) {
      logger.error("Could not resolve Instagram Business Account from connected Facebook pages");
      return res.redirect(`${getSettingsRedirectUrl()}&error=no_ig_business_account`);
    }

    await upsertSocialAccount({
      platform: "instagram",
      accountName: igAccountName,
      accountId: igAccountId,
      accessToken: encryptToken(accessToken),
      refreshToken: null,
      tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      brandId: stateData.brandId,
      status: "connected",
    });

    res.redirect(`${getSettingsRedirectUrl()}&success=instagram`);
  } catch (err) {
    logger.error(err, "Instagram callback error");
    res.redirect(`${getSettingsRedirectUrl()}&error=callback_error`);
  }
});

router.get("/auth/linkedin", async (req, res) => {
  const clientId = getSocialCredential("linkedin", "clientId");
  if (!clientId) {
    logger.error("LinkedIn connect attempted but Client ID is not configured");
    return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=linkedin`);
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const brandId = await resolveConnectBrandId(req.query.brandId);
  if (!brandId) {
    return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_brand`);
  }

  const state = createOAuthState(userId, brandId);
  const callbackUrl = `${getCallbackBaseUrl()}/api/auth/linkedin/callback`;
  const scopes = ["openid", "profile", "w_member_social", "offline_access"].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: scopes,
    state,
  });

  res.redirect(`https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`);
});

router.get("/auth/linkedin/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    const stateData = consumeOAuthState(state as string | undefined, req.user?.id);
    if (!stateData) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }

    if (!code || typeof code !== "string") {
      return res.redirect(`${getSettingsRedirectUrl()}&error=missing_code`);
    }

    const clientId = getSocialCredential("linkedin", "clientId");
    const clientSecret = getSocialCredential("linkedin", "clientSecret");
    if (!clientId || !clientSecret) {
      logger.error("LinkedIn OAuth callback but Client ID/Secret is not configured");
      return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=linkedin`);
    }
    const callbackUrl = `${getCallbackBaseUrl()}/api/auth/linkedin/callback`;

    const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      logger.error({ status: tokenResponse.status, body: errBody }, "LinkedIn token exchange failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    const tokenData = (await tokenResponse.json()) as LinkedInTokenResponse;

    const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    let accountName = "LinkedIn User";
    let accountId = "";

    if (profileResponse.ok) {
      const profileData = (await profileResponse.json()) as LinkedInProfileResponse;
      accountName = profileData.name || `${profileData.given_name || ""} ${profileData.family_name || ""}`.trim() || "LinkedIn User";
      accountId = profileData.sub || "";
    }

    if (!accountId) {
      logger.error("Could not resolve LinkedIn user identity from profile response");
      return res.redirect(`${getSettingsRedirectUrl()}&error=profile_fetch_failed`);
    }

    const fullAccountId = `urn:li:person:${accountId}`;

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await upsertSocialAccount({
      platform: "linkedin",
      accountName,
      accountId: fullAccountId,
      accessToken: encryptToken(tokenData.access_token),
      refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      tokenExpiry: expiresAt,
      brandId: stateData.brandId,
      status: "connected",
    });

    res.redirect(`${getSettingsRedirectUrl()}&success=linkedin`);
  } catch (err) {
    logger.error(err, "LinkedIn callback error");
    res.redirect(`${getSettingsRedirectUrl()}&error=callback_error`);
  }
});

router.get("/auth/tiktok", async (req, res) => {
  const clientKey = getSocialCredential("tiktok", "clientId");
  if (!clientKey) {
    logger.error("TikTok connect attempted but Client Key is not configured");
    return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=tiktok`);
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const brandId = await resolveConnectBrandId(req.query.brandId);
  if (!brandId) {
    return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_brand`);
  }

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString("hex");

  pkceStore.set(state, { verifier, userId, brandId, expiresAt: Date.now() + STATE_TTL_MS });

  const callbackUrl = `${getCallbackBaseUrl()}/api/auth/tiktok/callback`;
  const scopes = ["user.info.basic", "video.publish", "video.upload"].join(",");

  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: "code",
    scope: scopes,
    redirect_uri: callbackUrl,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.redirect(`https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`);
});

router.get("/auth/tiktok/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      return res.redirect(`${getSettingsRedirectUrl()}&error=missing_params`);
    }

    const pkceData = pkceStore.get(state);
    if (!pkceData || pkceData.expiresAt < Date.now()) {
      pkceStore.delete(state as string);
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }
    pkceStore.delete(state);

    if (pkceData.userId !== req.user?.id) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }

    const clientKey = getSocialCredential("tiktok", "clientId");
    const clientSecret = getSocialCredential("tiktok", "clientSecret");

    if (!clientKey || !clientSecret) {
      logger.error("TikTok OAuth callback but Client Key/Secret is not configured");
      return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=tiktok`);
    }

    const callbackUrl = `${getCallbackBaseUrl()}/api/auth/tiktok/callback`;

    const tokenResponse = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl,
        code_verifier: pkceData.verifier,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      logger.error({ status: tokenResponse.status, body: errBody }, "TikTok token exchange failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    const tokenData = (await tokenResponse.json()) as TikTokTokenResponse;

    if (!tokenData.access_token) {
      logger.error({ tokenData }, "TikTok token response missing access_token");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    let accountName = "TikTok Creator";
    let accountId = tokenData.open_id || "";
    let profileImageUrl: string | null = null;

    const userResponse = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );

    if (userResponse.ok) {
      const userData = (await userResponse.json()) as TikTokUserInfoResponse;
      if (userData.data?.user) {
        accountName = userData.data.user.display_name || "TikTok Creator";
        accountId = userData.data.user.open_id || accountId;
        profileImageUrl = userData.data.user.avatar_url || null;
      }
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    await upsertSocialAccount({
      platform: "tiktok",
      accountName,
      accountId,
      accessToken: encryptToken(tokenData.access_token),
      refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      tokenExpiry: expiresAt,
      profileImageUrl,
      brandId: pkceData.brandId,
      status: "connected",
    });

    res.redirect(`${getSettingsRedirectUrl()}&success=tiktok`);
  } catch (err) {
    logger.error(err, "TikTok callback error");
    res.redirect(`${getSettingsRedirectUrl()}&error=callback_error`);
  }
});

router.get("/auth/youtube", async (req, res) => {
  const clientId = getSocialCredential("youtube", "clientId");
  if (!clientId) {
    logger.error("YouTube connect attempted but Google Client ID is not configured");
    return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=youtube`);
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const brandId = await resolveConnectBrandId(req.query.brandId);
  if (!brandId) {
    return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_brand`);
  }

  const state = createOAuthState(userId, brandId);
  const callbackUrl = `${getCallbackBaseUrl()}/api/auth/youtube/callback`;
  const scopes = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: scopes,
    state,
    access_type: "offline",
    prompt: "consent",
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get("/auth/youtube/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    const stateData = consumeOAuthState(state as string | undefined, req.user?.id);
    if (!stateData) {
      return res.redirect(`${getSettingsRedirectUrl()}&error=invalid_state`);
    }

    if (!code || typeof code !== "string") {
      return res.redirect(`${getSettingsRedirectUrl()}&error=missing_code`);
    }

    const clientId = getSocialCredential("youtube", "clientId");
    const clientSecret = getSocialCredential("youtube", "clientSecret");
    if (!clientId || !clientSecret) {
      logger.error("YouTube OAuth callback but Google Client ID/Secret is not configured");
      return res.redirect(`${getSettingsRedirectUrl()}&error=not_configured&platform=youtube`);
    }
    const callbackUrl = `${getCallbackBaseUrl()}/api/auth/youtube/callback`;

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text();
      logger.error({ status: tokenResponse.status, body: errBody }, "YouTube token exchange failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=token_exchange_failed`);
    }

    const tokenData = (await tokenResponse.json()) as GoogleTokenResponse;

    const channelResponse = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );

    if (!channelResponse.ok) {
      const errBody = await channelResponse.text();
      logger.error({ status: channelResponse.status, body: errBody }, "YouTube channel fetch failed");
      return res.redirect(`${getSettingsRedirectUrl()}&error=channel_fetch_failed`);
    }

    const channelData = (await channelResponse.json()) as YouTubeChannelResponse;

    if (!channelData.items || channelData.items.length === 0) {
      logger.error("No YouTube channel found for authenticated user");
      return res.redirect(`${getSettingsRedirectUrl()}&error=no_youtube_channel`);
    }

    const channel = channelData.items[0];
    const accountName = channel.snippet.title;
    const accountId = channel.id;
    const avatarUrl = channel.snippet.thumbnails?.default?.url || null;
    const subscriberCount = channel.statistics?.subscriberCount || null;

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : new Date(Date.now() + 3600 * 1000);

    await upsertSocialAccount({
      platform: "youtube",
      accountName,
      accountId,
      accessToken: encryptToken(tokenData.access_token),
      refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      tokenExpiry: expiresAt,
      avatarUrl,
      platformMetadata: subscriberCount ? { subscriberCount } : null,
      brandId: stateData.brandId,
      status: "connected",
    });

    res.redirect(`${getSettingsRedirectUrl()}&success=youtube`);
  } catch (err) {
    logger.error(err, "YouTube callback error");
    res.redirect(`${getSettingsRedirectUrl()}&error=callback_error`);
  }
});

export default router;

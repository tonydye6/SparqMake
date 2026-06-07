// Client feature flags. Vite only exposes VITE_-prefixed env vars to the browser.
// Read defensively so we don't depend on the ImportMetaEnv interface declaring each key.
const env = import.meta.env as unknown as Record<string, string | undefined>;

export const FEATURES = {
  /**
   * New generation-first Creative Studio (P1 spine: Home → Board → Finish),
   * served at /studio-next in parallel with the existing Studio at "/".
   * Enable with VITE_ENABLE_STUDIO_NEXT=true.
   */
  studioNext: env.VITE_ENABLE_STUDIO_NEXT === "true",
} as const;

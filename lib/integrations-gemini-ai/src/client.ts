import { GoogleGenAI } from "@google/genai";

// Prefer the user's own Google AI API key (direct Google API) when set.
// This unlocks models not available through the Replit-managed proxy
// (gemini-3-pro-image, gemini-omni-flash-preview, gemini-3.5-flash).
// Falls back to the Replit AI Integrations proxy when GEMINI_API_KEY is absent.
const directApiKey = process.env.GEMINI_API_KEY;

if (!directApiKey) {
  if (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL) {
    throw new Error(
      "Either GEMINI_API_KEY or AI_INTEGRATIONS_GEMINI_BASE_URL must be set. Did you forget to provision the Gemini AI integration?",
    );
  }
  if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
    throw new Error(
      "Either GEMINI_API_KEY or AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
    );
  }
}

export const ai = directApiKey
  ? new GoogleGenAI({ apiKey: directApiKey })
  : new GoogleGenAI({
      apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
      httpOptions: {
        apiVersion: "",
        baseUrl: process.env.AI_INTEGRATIONS_GEMINI_BASE_URL,
      },
    });

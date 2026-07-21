import { GoogleGenAI, Modality } from "@google/genai";

// Prefer the user's own Google AI API key (direct Google API) when set;
// fall back to the Replit AI Integrations proxy.
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

export async function generateImage(
  prompt: string
): Promise<{ b64_json: string; mimeType: string }> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const candidate = response.candidates?.[0];
  const imagePart = candidate?.content?.parts?.find(
    (part: { inlineData?: { data?: string; mimeType?: string } }) => part.inlineData
  );

  if (!imagePart?.inlineData?.data) {
    throw new Error("No image data in response");
  }

  return {
    b64_json: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

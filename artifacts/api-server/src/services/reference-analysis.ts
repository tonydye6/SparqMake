import { ai } from "@workspace/integrations-gemini-ai";
import { AI_MODELS } from "../lib/ai-config.js";

export interface ReferenceAnalysisResult {
  visual_mood: string;
  color_strategy: string;
  typography_feel: string;
  layout_patterns: string;
  composition_notes: string;
  relevance_to_sparq: string;
  content_tone: string;
  sparq_application: string;
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface ReferenceImageInput {
  buffer: Buffer;
  mimeType: string;
}

export async function analyzeReference(
  images: ReferenceImageInput[],
): Promise<ReferenceAnalysisResult> {
  const imageParts = images
    .filter((img) => {
      if (img.buffer.length > MAX_FILE_SIZE_BYTES) {
        console.warn(`Skipping reference image: size ${(img.buffer.length / 1024 / 1024).toFixed(1)}MB exceeds 10MB limit`);
        return false;
      }
      return true;
    })
    .map((img) => ({
      inlineData: {
        data: img.buffer.toString("base64"),
        mimeType: img.mimeType,
      },
    }));

  if (imageParts.length === 0) {
    throw new Error("No valid screenshot images found for analysis");
  }

  const prompt = `You are a visual design and brand strategy analyst for a sports marketing platform called Sparq.

Analyze the provided screenshot(s) of a reference webpage. Extract structured insights that will guide AI-generated social media content (both images and captions).

Return a JSON object with exactly these fields:

- "visual_mood": A concise description of the overall visual mood/atmosphere (e.g., "high-energy, bold, dark with neon accents")
- "color_strategy": Describe the color palette and how colors are used (e.g., "predominantly dark navy with electric blue highlights and white text for contrast")
- "typography_feel": Describe the typography style and its emotional impact (e.g., "condensed uppercase sans-serif headlines convey urgency and power")
- "layout_patterns": Describe the layout approach and visual hierarchy (e.g., "hero-centric with large imagery, minimal text overlay, card-based content sections")
- "composition_notes": Key compositional techniques observed (e.g., "strong diagonal lines, asymmetric balance, generous white space around CTAs")
- "relevance_to_sparq": How these design elements could apply to sports/athletic content marketing
- "content_tone": The overall tone and voice of any text content (e.g., "motivational, direct, action-oriented with short punchy sentences")
- "sparq_application": Specific suggestions for applying these insights to Sparq's social media campaigns

Return ONLY valid JSON, no markdown code blocks or extra text.`;

  const response = await ai.models.generateContent({
    model: AI_MODELS.GEMINI_FLASH_TEXT,
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...imageParts,
        ],
      },
    ],
  });

  const text = response.candidates?.[0]?.content?.parts
    ?.filter((part: { text?: string }) => part.text)
    .map((part: { text?: string }) => part.text)
    .join("") || "";

  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      visual_mood: parsed.visual_mood || "",
      color_strategy: parsed.color_strategy || "",
      typography_feel: parsed.typography_feel || "",
      layout_patterns: parsed.layout_patterns || "",
      composition_notes: parsed.composition_notes || "",
      relevance_to_sparq: parsed.relevance_to_sparq || "",
      content_tone: parsed.content_tone || "",
      sparq_application: parsed.sparq_application || "",
    };
  } catch {
    throw new Error(`Failed to parse Gemini analysis response: ${cleaned.slice(0, 200)}`);
  }
}

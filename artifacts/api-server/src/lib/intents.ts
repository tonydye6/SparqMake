// Goal-aware posting: the intent taxonomy and per-intent creative directives.
// Every post carries one of these strategic goals; the directives below shape
// image prompt tone/energy, caption structure/CTA, and headline framing.

export const INTENTS = [
  "awareness",
  "acquisition",
  "community_engagement",
  "recognition_reward",
  "announcement_launch",
  "education",
  "retention",
] as const;

export type Intent = (typeof INTENTS)[number];

export function isIntent(value: unknown): value is Intent {
  return typeof value === "string" && (INTENTS as readonly string[]).includes(value);
}

export const INTENT_LABELS: Record<Intent, string> = {
  awareness: "Awareness",
  acquisition: "Acquisition",
  community_engagement: "Community engagement",
  recognition_reward: "Recognition & reward",
  announcement_launch: "Announcement / launch",
  education: "Education",
  retention: "Retention",
};

// One-line description per intent, used in inference and concept prompts.
export const INTENT_DESCRIPTIONS: Record<Intent, string> = {
  awareness: "Grow reach and brand recall; make the brand memorable to new audiences.",
  acquisition: "Drive signups, downloads, installs, or purchases; convert interest into action.",
  community_engagement: "Spark conversation, replies, UGC, and participation from the existing community.",
  recognition_reward: "Celebrate and reward players, fans, creators, or community members.",
  announcement_launch: "Announce something new: a launch, feature, event, update, or partnership.",
  education: "Teach or explain: tips, how-tos, mechanics, behind-the-scenes knowledge.",
  retention: "Re-engage existing players/followers and give them reasons to come back.",
};

// How each intent shapes the generated IMAGE (tone/energy directive appended
// to the image prompt).
export const INTENT_IMAGE_DIRECTIVES: Record<Intent, string> = {
  awareness:
    "GOAL (AWARENESS): Make the image bold, iconic, and instantly memorable. High visual impact, strong silhouette or hero framing, thumb-stopping energy.",
  acquisition:
    "GOAL (ACQUISITION): Make the image aspirational and product-forward, showing the payoff of joining or playing. Polished, desirable, action-oriented energy.",
  community_engagement:
    "GOAL (COMMUNITY ENGAGEMENT): Make the image warm, playful, and inviting — a moment people want to react to or riff on. Candid, energetic, in-on-the-joke feel.",
  recognition_reward:
    "GOAL (RECOGNITION & REWARD): Make the image celebratory — spotlight, trophy, confetti, podium energy. Triumphant, congratulatory mood honoring the subject.",
  announcement_launch:
    "GOAL (ANNOUNCEMENT / LAUNCH): Make the image feel like a reveal — dramatic lighting, curtain-up moment, big-moment anticipation and spectacle.",
  education:
    "GOAL (EDUCATION): Make the image clear and focused with a single readable subject; clean composition that supports explanation over spectacle.",
  retention:
    "GOAL (RETENTION): Make the image nostalgic and welcoming — a 'come back, we missed you' mood. Familiar, comforting, rewarding energy for returning fans.",
};

// How each intent shapes captions (structure + CTA) and headline framing.
export const INTENT_COPY_DIRECTIVES: Record<Intent, string> = {
  awareness:
    "GOAL (AWARENESS): Lead with a bold hook that makes the brand memorable; keep copy punchy and shareable. CTA is soft (follow, remember the name) — do not hard-sell. Headlines: iconic, declarative statements.",
  acquisition:
    "GOAL (ACQUISITION): Structure the caption benefit-first, then a clear direct CTA (download, sign up, play now, get it today). Headlines: action-driven with a clear value promise.",
  community_engagement:
    "GOAL (COMMUNITY ENGAGEMENT): Write conversational copy that ends in a question or prompt inviting replies, tags, or UGC. CTA asks for participation (comment, tag, share yours). Headlines: playful, direct-address ('you'/'your').",
  recognition_reward:
    "GOAL (RECOGNITION & REWARD): Celebrate the honoree by name/role; copy is congratulatory and gracious. CTA invites the community to join the celebration. Headlines: triumphant shout-outs.",
  announcement_launch:
    "GOAL (ANNOUNCEMENT / LAUNCH): Lead with the news itself — what, when, where — with reveal energy. CTA points at the launch (check it out, mark the date). Headlines: big-reveal framing ('It's here', 'Introducing').",
  education:
    "GOAL (EDUCATION): Structure the caption as a clear takeaway or tip — hook, insight, payoff. CTA invites saving/sharing or trying the tip. Headlines: curiosity-driven how/why framing.",
  retention:
    "GOAL (RETENTION): Speak to existing fans/players with insider warmth; remind them what is waiting for them. CTA is a comeback nudge (jump back in, don't miss out). Headlines: welcome-back, 'still here for you' framing.",
};

// The angle each intent pushes concept suggestions toward.
export const INTENT_CONCEPT_ANGLES: Record<Intent, string> = {
  awareness: "a bold, memorable brand-recall angle that stops the scroll",
  acquisition: "a benefit-led angle that converts interest into a signup/download/play",
  community_engagement: "a participation angle that begs for replies, tags, or UGC",
  recognition_reward: "a celebration angle spotlighting players, fans, or creators",
  announcement_launch: "a reveal angle that makes news feel like an event",
  education: "a tips/how-to/behind-the-scenes angle that teaches something real",
  retention: "a welcome-back angle that re-engages lapsed players or followers",
};

export function intentPromptCatalog(): string {
  return INTENTS.map(i => `- ${i}: ${INTENT_DESCRIPTIONS[i]}`).join("\n");
}

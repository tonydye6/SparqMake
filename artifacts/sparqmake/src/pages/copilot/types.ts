/**
 * Shared types, constants, and state management for Co-pilot Studio.
 */

export const API_BASE = import.meta.env.VITE_API_URL || "";

// ---- Domain types ----------------------------------------------------------

export interface Concept {
  id: string;
  title: string;
  angle: string;
  intent?: string;
  intentLabel?: string;
}

export interface SessionSummary {
  id: string;
  sessionTitle: string | null;
  lastTurnSummary: string | null;
  status: string;
  thumbnailUrl: string | null;
  totalCostUsd: number;
  updatedAt: string;
  brandId: string;
}

export interface Turn {
  id: string;
  seq: number;
  role: "user" | "copilot";
  instruction: string | null;
  action: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  resultVariantIds: string[];
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  metadata: Record<string, unknown> | null;
  variantUrls?: string[];
  createdAt: string;
}

export interface Session {
  id: string;
  brandId: string;
  creativeId: string;
  status: string;
  activeVariantId: string | null;
  imageInteractionId: string | null;
  videoInteractionId: string | null;
  sessionTitle: string | null;
  lastTurnSummary: string | null;
  thumbnailUrl: string | null;
  totalCostUsd: number;
  createdAt: string;
  updatedAt: string;
}

export interface Variant {
  id: string;
  platform: string;
  compositedImageUrl: string | null;
  rawImageUrl: string | null;
  videoUrl?: string | null;
  caption: string;
  headlineText: string | null;
}

export interface FanOutPlatformCard {
  platform: string;
  variantId: string;
  imageUrl: string;
  caption: string;
  headline: string;
  suggestedAt: string;
  requiresVideo?: boolean;
}

export interface AssetItem {
  id: string;
  name: string;
  thumbnailUrl: string | null;
}

export interface BrandAsset {
  id: string;
  name: string;
  type: string;
  thumbnailUrl: string | null;
  fileUrl: string | null;
}

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TurnPayload {
  action: string;
  instruction: string;
  platform?: string;
  region?: Region | null;
  assetIds?: string[];
  sourceVariantId?: string;
}

// ---- Action labels / platform labels / CHIPS --------------------------------

export const ACTION_LABELS: Record<string, string> = {
  draft: "Draft",
  edit_image: "Targeted edit",
  edit_region: "Region edit",
  caption: "Caption rewrite",
  compare: "Compare takes",
  convert_video: "Convert to video",
  edit_video: "Edit video",
  fan_out: "Platform set",
  schedule: "Scheduled",
};

export const PLATFORM_LABELS: Record<string, string> = {
  instagram_feed: "IG Feed",
  instagram_story: "IG Story",
  twitter: "Twitter",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
};

// ---- Session view props -----------------------------------------------------

export interface SessionViewProps {
  sessionId: string;
  onBack: () => void;
  autoDraftBrief?: string | null;
}

// ---- Session state + reducer ------------------------------------------------

export interface SessionState {
  session: Session | null;
  turns: Turn[];
  activeVariant: Variant | null;
  allVariants: Variant[];
  historyVariants: Array<{ turnSeq: number; variantId: string; thumbnailUrl: string | null }>;
  loading: boolean;
  running: boolean;
  composerText: string;
  progressMessages: string[];
  error: string | null;
  captionAlternates: Array<{ caption: string; headline: string }> | null;
  captionPlatform: string | null;
  fanOutVideoVariants: Record<string, string>;
}

export type SessionAction =
  | { type: "loaded"; session: Session; turns: Turn[]; variants: Variant[] }
  | { type: "setComposer"; text: string }
  | { type: "setRunning"; running: boolean }
  | { type: "addProgress"; message: string }
  | { type: "clearProgress" }
  | { type: "setError"; error: string | null }
  | { type: "setActiveVariant"; variant: Variant }
  | { type: "addTurn"; turn: Turn }
  | { type: "setCaptionAlternates"; alternates: Array<{ caption: string; headline: string }> | null; platform: string | null }
  | { type: "setFanOutVideoVariant"; sourceId: string; videoId: string };

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "loaded": {
      const activeId = action.session.activeVariantId;
      const active = action.variants.find(v => v.id === activeId) || action.variants[0] || null;
      const historyVariants = buildHistory(action.turns, action.variants);
      return { ...state, session: action.session, turns: action.turns, allVariants: action.variants, activeVariant: active, historyVariants, loading: false };
    }
    case "setComposer": return { ...state, composerText: action.text };
    case "setRunning": return { ...state, running: action.running };
    case "addProgress": return { ...state, progressMessages: [...state.progressMessages.slice(-4), action.message] };
    case "clearProgress": return { ...state, progressMessages: [] };
    case "setError": return { ...state, error: action.error };
    case "setActiveVariant": return { ...state, activeVariant: action.variant };
    case "addTurn": return { ...state, turns: [...state.turns, action.turn] };
    case "setCaptionAlternates": return { ...state, captionAlternates: action.alternates, captionPlatform: action.platform };
    case "setFanOutVideoVariant": return {
      ...state,
      fanOutVideoVariants: { ...state.fanOutVideoVariants, [action.sourceId]: action.videoId },
    };
    default: return state;
  }
}

export function buildHistory(turns: Turn[], variants: Variant[]) {
  const variantMap = new Map(variants.map(v => [v.id, v]));
  return turns
    .filter(t => t.role === "copilot" && t.status === "done" && t.resultVariantIds?.length > 0)
    .map(t => {
      const vid = t.resultVariantIds[0];
      const v = variantMap.get(vid);
      return { turnSeq: t.seq, variantId: vid, thumbnailUrl: v?.compositedImageUrl || v?.rawImageUrl || null };
    });
}

// RunTurn function type
export type RunTurnFn = (
  action: string,
  instruction: string,
  platform?: string,
  region?: Region | null,
  schedules?: Array<{ variantId: string; platform: string; scheduledAt: string }>,
  sourceVariantId?: string,
  assetIds?: string[],
) => Promise<void>;

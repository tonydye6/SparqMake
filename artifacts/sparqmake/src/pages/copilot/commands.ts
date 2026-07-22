/**
 * Slash command registry for the Quiet Studio composer.
 * Spec §Phase B: commands.ts (command registry)
 */
import type { Session } from "./types";

export interface SlashCommandDef {
  cmd: string;
  label: string;
  action: string;
  /** Short note shown in the picker row. */
  note: (session: Session | null) => string;
  /** Whether the command requires an existing imageInteractionId. */
  requiresImage?: boolean;
  /** Whether the command requires a videoInteractionId (for /video). */
  requiresVideo?: boolean;
  /** Entering this command activates region-draw mode instead of firing a turn. */
  activatesRegion?: boolean;
  /** /schedule is NOT a turn — scrolls to newest fan_out card. */
  isNav?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  {
    cmd: "/draft",
    label: "Draft",
    action: "draft",
    note: () => "Generate a first draft from your brief",
  },
  {
    cmd: "/edit",
    label: "Edit image",
    action: "edit_image",
    requiresImage: true,
    note: () => "Edit the current image with your instruction",
  },
  {
    cmd: "/region",
    label: "Region edit",
    action: "edit_region",
    requiresImage: true,
    activatesRegion: true,
    note: () => "Select a region of the image to edit",
  },
  {
    cmd: "/caption",
    label: "Caption",
    action: "caption",
    requiresImage: true,
    note: () => "Rewrite captions (add platform: twitter, linkedin, etc.)",
  },
  {
    cmd: "/takes",
    label: "Compare takes",
    action: "compare",
    requiresImage: true,
    note: () => "Generate 3 comparison takes",
  },
  {
    cmd: "/video",
    label: "Video",
    action: "convert_video",
    requiresImage: true,
    note: (session) =>
      session?.videoInteractionId
        ? "Edit the existing video clip"
        : "Convert the current image into a short video clip",
  },
  {
    cmd: "/set",
    label: "Platform set",
    action: "fan_out",
    requiresImage: true,
    note: () => "Create platform-optimized versions for all channels",
  },
  {
    cmd: "/schedule",
    label: "Schedule",
    action: "schedule",
    isNav: true,
    note: () => "Scroll to the latest platform set to schedule posts",
  },
];

export interface CommandWithStatus extends SlashCommandDef {
  available: boolean;
  disabledReason?: string;
}

export function getCommandsWithStatus(
  session: Session | null,
  hasFanOutTurn: boolean,
): CommandWithStatus[] {
  const hasImage = Boolean(session?.imageInteractionId);

  return SLASH_COMMANDS.map((c): CommandWithStatus => {
    if (c.cmd === "/schedule") {
      if (!hasFanOutTurn) {
        return { ...c, available: false, disabledReason: "Run /set first" };
      }
      return { ...c, available: true };
    }
    if (c.requiresImage && !hasImage) {
      return { ...c, available: false, disabledReason: "Needs a draft first" };
    }
    return { ...c, available: true };
  });
}

/** Platform tokens accepted by /caption — supports both slash-style and API enum forms */
export const CAPTION_PLATFORMS: Record<string, string> = {
  all: "all",
  "ig-feed": "instagram_feed",
  "ig-story": "instagram_story",
  twitter: "twitter",
  linkedin: "linkedin",
  tiktok: "tiktok",
  youtube: "youtube",
  instagram_feed: "instagram_feed",
  instagram_story: "instagram_story",
};

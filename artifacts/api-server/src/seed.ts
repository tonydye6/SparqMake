import { db, brandsTable, templatesTable, creativesTable, calendarEntriesTable, creativeVariantsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const DEFAULT_BRANDS = [
  {
    name: "Crown U",
    slug: "crown-u",
    colorPrimary: "#00A3FF",
    colorSecondary: "#1E3A5F",
    colorAccent: "#60A5FA",
    colorBackground: "#0A0A0F",
    voiceDescription: "You are the social media manager for Crown U. Your tone is energetic, competitive, and highly engaged with the esports community. Use gaming terminology naturally but avoid cringe slang. Be hyped but professional.",
    bannedTerms: ["kill", "murder", "dead game", "toxic", "abuse"],
    trademarkRules: "Always capitalize the 'U' in Crown U. Never abbreviate to CU. Always use the full brand name in captions.",
    imagenPrefix: "Esports team photo, competitive gaming atmosphere, blue neon lighting, professional stadium background",
    negativePrompt: "ugly, deformed, poorly drawn, extra limbs, low resolution, watermark, text, blurry",
    platformRules: {
      twitter: { char_limit: 280, hashtag_limit: 5 },
      instagram_feed: { char_limit: 2200, hashtag_limit: 30 },
      instagram_story: { char_limit: 2200, hashtag_limit: 10 },
      linkedin: { char_limit: 3000, hashtag_limit: 5 },
      tiktok: { char_limit: 2200, hashtag_limit: 10 },
    },
    hashtagStrategy: {
      always_include: ["#CrownU", "#Esports"],
      school_specific: ["#CrownUGaming", "#CrownUEsports", "#GoRoyals"],
    },
  },
  {
    name: "Rumble U",
    slug: "rumble-u",
    colorPrimary: "#FF4D00",
    colorSecondary: "#4D1600",
    colorAccent: "#FF8A50",
    colorBackground: "#0A0A0F",
    voiceDescription: "You are the social media manager for Rumble U. Your tone is fierce, bold, and unapologetically competitive. Embrace the fighting spirit and underdog energy. Use powerful action verbs.",
    bannedTerms: ["violence", "fight IRL", "hurt", "injury"],
    trademarkRules: "Always capitalize the 'U' in Rumble U. The tagline is 'Ready to Rumble' — always capitalize it.",
    imagenPrefix: "Action-packed esports scene, orange and red energy effects, intense competitive atmosphere",
    negativePrompt: "ugly, deformed, poorly drawn, extra limbs, low resolution, watermark, text",
    platformRules: {
      twitter: { char_limit: 280, hashtag_limit: 5 },
      instagram_feed: { char_limit: 2200, hashtag_limit: 30 },
      instagram_story: { char_limit: 2200, hashtag_limit: 10 },
      linkedin: { char_limit: 3000, hashtag_limit: 5 },
      tiktok: { char_limit: 2200, hashtag_limit: 10 },
    },
    hashtagStrategy: {
      always_include: ["#RumbleU", "#ReadyToRumble"],
      school_specific: ["#RumbleUGaming", "#RumbleNation"],
    },
  },
  {
    name: "Mascot Mayhem",
    slug: "mascot-mayhem",
    colorPrimary: "#FFD700",
    colorSecondary: "#4D4000",
    colorAccent: "#FFF176",
    colorBackground: "#0A0A0F",
    voiceDescription: "You are the social media manager for Mascot Mayhem. Your tone is fun, chaotic, and entertaining. Lean into humor and mascot personality. Be playful and irreverent but never offensive.",
    bannedTerms: ["stupid", "dumb", "lame"],
    trademarkRules: "Always capitalize both words in Mascot Mayhem. Can abbreviate to MM in hashtags only.",
    imagenPrefix: "Colorful cartoon mascots in dynamic poses, fun energetic atmosphere, gold and yellow accents",
    negativePrompt: "ugly, deformed, poorly drawn, low resolution, watermark, realistic human faces",
    platformRules: {
      twitter: { char_limit: 280, hashtag_limit: 5 },
      instagram_feed: { char_limit: 2200, hashtag_limit: 30 },
      instagram_story: { char_limit: 2200, hashtag_limit: 10 },
      linkedin: { char_limit: 3000, hashtag_limit: 5 },
      tiktok: { char_limit: 2200, hashtag_limit: 10 },
    },
    hashtagStrategy: {
      always_include: ["#MascotMayhem", "#MascotMadness"],
      school_specific: ["#MMGaming", "#MascotSquad"],
    },
  },
  {
    name: "Corporate",
    slug: "corporate",
    colorPrimary: "#8B5CF6",
    colorSecondary: "#2E1F5E",
    colorAccent: "#A78BFA",
    colorBackground: "#0A0A0F",
    voiceDescription: "You are the social media manager for Sparq Games corporate brand. Your tone is professional, forward-thinking, and inspiring. Focus on company milestones, partnerships, and industry leadership.",
    bannedTerms: ["competitor names", "leaked", "rumor"],
    trademarkRules: "Always use 'Sparq Games' with proper capitalization. Never abbreviate to SG.",
    imagenPrefix: "Professional corporate setting, purple branding accents, modern tech office, clean design",
    negativePrompt: "ugly, deformed, poorly drawn, low resolution, watermark, text, casual, informal",
    platformRules: {
      twitter: { char_limit: 280, hashtag_limit: 3 },
      instagram_feed: { char_limit: 2200, hashtag_limit: 10 },
      instagram_story: { char_limit: 2200, hashtag_limit: 5 },
      linkedin: { char_limit: 3000, hashtag_limit: 5 },
      tiktok: { char_limit: 2200, hashtag_limit: 10 },
    },
    hashtagStrategy: {
      always_include: ["#SparqGames", "#GamingIndustry"],
      corporate: ["#Esports", "#GameDev", "#Innovation"],
    },
  },
];

const TEMPLATES_BY_BRAND: Record<string, Array<{
  name: string;
  description: string;
  imagenPromptAddition: string;
  imagenNegativeAddition: string;
  claudeCaptionInstruction: Record<string, unknown>;
  claudeHeadlineInstruction: string;
  recommendedAssetTypes: string[];
  targetAspectRatios: string[];
}>> = {
  "crown-u": [
    {
      name: "Match Day Announcement",
      description: "Pre-match hype post for upcoming Crown U competitions",
      imagenPromptAddition: "esports arena, dramatic lighting, team lineup, pre-match energy",
      imagenNegativeAddition: "empty, boring, static",
      claudeCaptionInstruction: { tone: "hype", include_time: true, include_opponent: true, cta: "tune_in" },
      claudeHeadlineInstruction: "Create a punchy 5-8 word headline that builds excitement for the upcoming match",
      recommendedAssetTypes: ["team_photo", "player_headshot", "arena_photo"],
      targetAspectRatios: ["1:1", "9:16", "16:9"],
    },
    {
      name: "Victory Celebration",
      description: "Post-match celebration when Crown U wins",
      imagenPromptAddition: "celebration, trophy, confetti, victory moment, blue glow",
      imagenNegativeAddition: "sad, defeated, dark mood",
      claudeCaptionInstruction: { tone: "triumphant", include_score: true, highlight_mvp: true },
      claudeHeadlineInstruction: "Create a triumphant headline celebrating the win",
      recommendedAssetTypes: ["team_photo", "trophy", "highlight_clip"],
      targetAspectRatios: ["1:1", "4:5", "16:9"],
    },
    {
      name: "Player Spotlight",
      description: "Individual player feature highlighting achievements",
      imagenPromptAddition: "individual portrait, focused, dramatic lighting, gaming setup",
      imagenNegativeAddition: "group photo, blurry, low quality",
      claudeCaptionInstruction: { tone: "respectful", include_stats: true, personal_story: true },
      claudeHeadlineInstruction: "Create a headline featuring the player's name and key achievement",
      recommendedAssetTypes: ["player_headshot", "action_shot"],
      targetAspectRatios: ["1:1", "4:5", "9:16"],
    },
  ],
  "rumble-u": [
    {
      name: "Challenge Issued",
      description: "Trash-talk style challenge post for upcoming matchups",
      imagenPromptAddition: "intense standoff, versus screen, orange fire effects, competitive tension",
      imagenNegativeAddition: "peaceful, calm, passive",
      claudeCaptionInstruction: { tone: "aggressive_hype", include_opponent: true, cta: "watch_live" },
      claudeHeadlineInstruction: "Create a bold challenge headline that fires up the audience",
      recommendedAssetTypes: ["versus_graphic", "team_photo"],
      targetAspectRatios: ["1:1", "16:9"],
    },
    {
      name: "Highlight Reel",
      description: "Best plays and moments compilation post",
      imagenPromptAddition: "action freeze frame, highlight moment, speed lines, dynamic composition",
      imagenNegativeAddition: "static, boring, slow",
      claudeCaptionInstruction: { tone: "excited", include_play_description: true, cta: "share_favorite" },
      claudeHeadlineInstruction: "Write an explosive headline about the top plays",
      recommendedAssetTypes: ["highlight_clip", "action_shot"],
      targetAspectRatios: ["16:9", "9:16"],
    },
  ],
  "mascot-mayhem": [
    {
      name: "Meme Monday",
      description: "Weekly fun mascot meme content",
      imagenPromptAddition: "cartoon mascot, funny expression, meme format, colorful background",
      imagenNegativeAddition: "realistic, dark, serious",
      claudeCaptionInstruction: { tone: "funny", include_emoji: true, meme_style: true },
      claudeHeadlineInstruction: "Create a funny, meme-worthy caption",
      recommendedAssetTypes: ["mascot_illustration", "meme_template"],
      targetAspectRatios: ["1:1", "4:5"],
    },
    {
      name: "Mascot Reveal",
      description: "New mascot character introduction",
      imagenPromptAddition: "character reveal, dramatic pose, spotlight, golden sparkles",
      imagenNegativeAddition: "boring, static, plain background",
      claudeCaptionInstruction: { tone: "exciting", build_suspense: true, include_character_name: true },
      claudeHeadlineInstruction: "Create a dramatic reveal headline for the new mascot",
      recommendedAssetTypes: ["mascot_illustration", "character_art"],
      targetAspectRatios: ["1:1", "9:16", "4:5"],
    },
  ],
  "corporate": [
    {
      name: "Company Milestone",
      description: "Major company achievement or announcement",
      imagenPromptAddition: "corporate celebration, milestone graphic, professional design, purple accents",
      imagenNegativeAddition: "casual, messy, unprofessional",
      claudeCaptionInstruction: { tone: "professional", include_metrics: true, forward_looking: true },
      claudeHeadlineInstruction: "Create a professional headline announcing the milestone",
      recommendedAssetTypes: ["infographic", "team_photo"],
      targetAspectRatios: ["1:1", "16:9", "1.91:1"],
    },
    {
      name: "Partnership Announcement",
      description: "New partner or sponsor reveal",
      imagenPromptAddition: "handshake, partnership graphic, both brand logos, clean design",
      imagenNegativeAddition: "cluttered, informal, messy",
      claudeCaptionInstruction: { tone: "professional", include_partner_name: true, mutual_benefits: true },
      claudeHeadlineInstruction: "Create a headline announcing the strategic partnership",
      recommendedAssetTypes: ["logo_lockup", "press_photo"],
      targetAspectRatios: ["1:1", "16:9", "1.91:1"],
    },
  ],
};

export async function seedDatabase() {
  if (process.env.SEED_DEMO_DATA !== "true") {
    console.log("SEED_DEMO_DATA not set; skipping demo seed.");
    return;
  }

  const existingBrands = await db.select({ id: brandsTable.id }).from(brandsTable);
  if (existingBrands.length > 0) {
    console.log(`Database already has ${existingBrands.length} brands, skipping seed.`);
    return;
  }

  console.log("Seeding database with default brands and templates...");

  for (const brandData of DEFAULT_BRANDS) {
    const [brand] = await db.insert(brandsTable).values(brandData).returning();
    console.log(`  Created brand: ${brand.name} (${brand.id})`);

    const brandTemplates = TEMPLATES_BY_BRAND[brandData.slug] || [];
    for (const tmpl of brandTemplates) {
      const [template] = await db.insert(templatesTable).values({
        brandId: brand.id,
        ...tmpl,
      }).returning();
      console.log(`    Created template: ${template.name}`);
    }

    if (brandData.slug === "crown-u") {
      const now = new Date();
      const [campaign] = await db.insert(creativesTable).values({
        brandId: brand.id,
        name: "Regional Finals Hype Campaign",
        status: "pending_review",
        briefText: "Create excitement for the upcoming Crown U regional finals matchup against rival team. Focus on team preparation and fan engagement.",
        selectedAssets: [],
        createdBy: "alex-hunter",
      }).returning();

      const platforms = [
        { platform: "instagram_feed", aspectRatio: "1:1", caption: "The stage is set. The team is ready. Are you? 🎮🔥\n\nCrown U takes on the regionals this weekend. Don't miss the action.\n\n#CrownU #Esports #RegionalFinals" },
        { platform: "instagram_story", aspectRatio: "9:16", caption: "GAME DAY INCOMING 🏆\n\nSwipe up to watch live!" },
        { platform: "twitter", aspectRatio: "16:9", caption: "👑 The Crown awaits. Regional Finals this Saturday at 5PM EST. Who's ready? #CrownU #Esports #MatchDay" },
        { platform: "linkedin", aspectRatio: "1.91:1", caption: "Crown U Esports is proud to announce our qualification for the Regional Finals Championship. Our student athletes have demonstrated exceptional skill and teamwork throughout the season." },
        { platform: "tiktok", aspectRatio: "9:16", caption: "POV: Your esports team just qualified for regionals 👑🎮\n\nThe grind was REAL but we're here. Crown U is coming for that trophy 🏆\n\n#CrownU #Esports #CollegeEsports #GamingTikTok" },
      ];

      for (const v of platforms) {
        const [variant] = await db.insert(creativeVariantsTable).values({
          creativeId: campaign.id,
          platform: v.platform,
          aspectRatio: v.aspectRatio,
          caption: v.caption,
          originalCaption: v.caption,
          status: "generated",
        }).returning();

        const scheduledDate = new Date(now);
        scheduledDate.setDate(scheduledDate.getDate() + Math.floor(Math.random() * 7) + 1);
        scheduledDate.setHours(17, 0, 0, 0);

        await db.insert(calendarEntriesTable).values({
          creativeId: campaign.id,
          variantId: variant.id,
          platform: v.platform,
          scheduledAt: scheduledDate,
          publishStatus: "scheduled",
        });
      }
      console.log(`    Created sample campaign with ${platforms.length} variants and calendar entries`);
    }

    if (brandData.slug === "rumble-u") {
      const [campaign] = await db.insert(creativesTable).values({
        brandId: brand.id,
        name: "Season Opener Highlights",
        status: "draft",
        briefText: "Highlight reel from the Rumble U season opener. Focus on best plays and team energy.",
        selectedAssets: [],
        createdBy: "alex-hunter",
      }).returning();
      console.log(`    Created draft campaign: ${campaign.name}`);
    }
  }

  console.log("Database seeding complete!");
}

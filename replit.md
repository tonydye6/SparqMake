# SparqMake

## Overview
SparqMake is an AI-powered social media content generation and management tool designed for Sparq Games. It streamlines content creation, scheduling, and publishing across multiple social media platforms, including Instagram, Twitter/X, and LinkedIn. The tool leverages advanced AI models for generating captions, headlines, images, videos, and audio, along with robust features for content refinement, scheduling, and performance tracking. Its core purpose is to enhance content velocity and brand consistency for Sparq Games' various brands.

## User Preferences
The user wants the agent to focus on high-level features and architectural decisions. Avoid granular implementation details. Consolidate redundant information and eliminate repetition. Prioritize architectural decisions over implementation specifics. The agent should remove all changelogs, update logs, and date-wise entries.

## System Architecture
SparqMake is built as a pnpm monorepo using Node.js 24 and TypeScript 5.9. The frontend is a React + Vite application, and the backend API is built with Express 5. PostgreSQL is used for data persistence with Drizzle ORM, and Zod handles validation. OpenAPI specifications are used for API codegen with Orval.

**UI/UX Decisions:**
The application features a dark mode only UI with a specific color palette:
- App background: `#0A0A0F`
- Surface: `#12121A`
- Input fields: `#1A1A28`
- Borders: `#1E1E2E`
- Primary text: `#F0F0F5`
- Secondary text: `#9CA3AF`
- Accent: `#3B82F6`

The frontend comprises several key pages:
- **Creative Studio**: A 3-panel workspace for AI generation, video generation, live variant display, inline caption editing, per-variant refinement, audio controls, and download options. Features platform-specific preview frames (IG Feed/Story, Twitter/X, LinkedIn, TikTok), inline AI rewrite toolbar for captions, clickable headline overlay editing with automatic re-compositing, progressive loading with skeleton shimmers and crossfade animations, and Smart Schedule button for AI-optimized posting time proposals.
- **Asset Library**: Manages visual assets, briefs, context, and hashtag libraries.
    - **Content Calendar**: Month/week views with drag-to-reschedule functionality (with conflict warnings for same-platform posts within 2 hours and cross-platform posts within 1 hour), publish status badges, publish/retry buttons, Edit Time dialog for scheduled entries, and sparkle badges for smart-scheduled posts (full sparkle for AI-optimized, half-sparkle for user-modified). Hovering smart-scheduled entries shows AI rationale in tooltip.
- **Review Queue**: A Kanban board with per-variant approve/reject (mandatory rejection comments feed refinement_logs). Supports bulk and individual variant review actions.
- **Content Plan**: A planning layer for organizing content series (e.g., 30-post launch calendars). Supports CSV import, filterable table view (by pillar, platform, status, week, brand layer), expandable row details, manual CRUD, plan-to-creative conversion, and batch Smart Schedule (select 2+ items with linked creatives to auto-schedule using AI-optimized time slots).
- **Cost Dashboard**: Displays total spend, daily spend charts, breakdowns by service/operation. Includes configurable daily budget threshold with pre-generation budget check and visual alerts. Analytics combine the live `cost_logs` table with archived monthly rollups so lifetime totals stay correct after retention/archival runs.
- **Settings**: Manages brand settings, connected social accounts, and Smart Schedule profiles. Includes a Schedule Profile Editor with per-platform 7×24 heat map grids, AI profile generation via Claude, and timezone configuration.

**Technical Implementations & Feature Specifications:**
- **AI Generation Pipeline**:
    1. **Context Assembly**: Gathers brand DNA, template config, assets, hashtag sets, and brief text into a structured prompt. Accepts role-aware generation packets.
    2. **Packet Assembly**: `buildGenerationPacket` classifies assets by role (subject_reference, style_reference, compositing, context), scores candidates, selects optimal 2-3 reference images, excludes compositing-only assets from Imagen calls, and logs decisions to `generation_packet_logs`.
    3. **Caption Generation**: Uses Claude to generate platform-specific captions and overlay headline text.
    4. **Image Generation**: Uses Gemini to generate images for various platform aspect ratios (1:1, 9:16, 16:9). Supports up to 3 reference images (base64 inlineData) injected alongside the text prompt. Subject references go first, then style references.
    5. **Compositing**: Overlays gradients, headline text, and brand logos onto raw images using Sharp. Auto-fetches the brand's primary logo asset for compositing when the layout spec includes logo_placement.
    6. **SSE Streaming**: Provides real-time progress updates during generation.
- **Video and Audio Generation**: Integrates Veo for video generation and ElevenLabs for text-to-music and SFX. ffmpeg handles audio/video merging.
- **Social Account OAuth**: Supports Twitter/X (OAuth 2.0 PKCE + OAuth 1.0a for media upload), Instagram (via Facebook Login), LinkedIn (OAuth 2.0), TikTok (OAuth 2.0 with PKCE), and YouTube (Google OAuth 2.0 with YouTube-specific scopes). Tokens are encrypted using AES-256-GCM and automatically refreshed.
- **Publishing Engine**: A database-backed scheduler polls for scheduled posts, and platform-specific services handle publishing to Twitter (OAuth 1.0a media upload signing), Instagram (Feed + Stories, Authorization header auth), LinkedIn (Community Management API v202401, `/rest/posts` + `/rest/images`), TikTok (Content Posting API with video upload + photo posts), and YouTube (Data API v3, resumable video upload). Includes retry logic with exponential backoff.
- **Template Refinement Loop**: Tracks user edits (refinement logs), maintains template version history with rollback capabilities, and uses Claude for AI-powered refinement analysis and recommendations.

**Authentication & Security:**
Google OAuth sign-in via Passport.js with cookie-based sessions stored in PostgreSQL (connect-pg-simple). Google OAuth env vars support `SparqMake_Google_Client_ID`/`SparqMake_Google_Client_Secret` (preferred) with fallback to `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. In development, `DEV_AUTH_BYPASS=true` auto-authenticates as a dev user without requiring login (explicitly blocked in production with `NODE_ENV=production`). API routes are protected by `requireAuth` middleware (returns 401 for unauthenticated requests in production). Auth routes (`/api/auth/me`, `/api/auth/google`, `/api/auth/google/callback`, `/api/auth/logout`) are mounted before the auth middleware. Health endpoint is also public. The frontend redirects unauthenticated users to `/login` in production. The sidebar displays the authenticated user's name and avatar from the session. Creative creation uses the authenticated user's ID for `createdBy`, and asset creation uses it for `uploadedBy`.

Security hardening includes: CORS restricted to allowed origins (CORS_ORIGIN env var, APP_URL, Replit domains, localhost in dev), CSRF protection via Origin/Referer header validation on state-changing methods, global rate limiting (200 req/min) with stricter limits on AI generation endpoints (5 req/min), API 404 JSON handler for unmatched routes, SSRF protection with IPv6-mapped private IP detection, and Instagram/Facebook API calls using Authorization headers instead of URL query params. A `.env.example` documents all required and optional environment variables.

Security hardening for downloads includes path traversal protection (resolved paths validated against base directory), ZIP archive size awareness, and SSE generation streams have a 5-minute timeout to prevent resource exhaustion. Server startup wraps scheduler and token refresh in try-catch to prevent process crashes from non-critical initialization failures. All frontend fetch calls use the `apiFetch()` wrapper (from `@/lib/utils`) which automatically includes `credentials: "include"` for cookie-based session authentication.

**Known Limitation — Authorization Gap (L5):** The API enforces authentication (who you are) but does not yet enforce resource-level authorization (what you own). Any authenticated user can read, update, or delete any brand, creative, template, or asset. Implementing role-based access control with resource ownership checks (e.g., users can only modify brands they created) is planned as future work.

**Database Schema:**
The database includes tables for `brands` (with `brandAssetConfig` JSON field, `timezone`), `templates`, `assets` (with four-class taxonomy: `assetClass` [compositing/subject_reference/style_reference/context], scoring fields, generation flags), `asset_pairings` (tracks which asset combinations produced good results), `generation_packet_logs` (records which assets were sent to each generation call), `hashtag_sets`, `creatives`, `creative_variants`, `calendar_entries` (with `schedule_method` [manual/smart_schedule/smart_schedule_modified] and `proposal_id`), `social_accounts` (with encrypted tokens), `refinement_logs`, `template_versions`, `template_recommendations`, `cost_logs`, `cost_log_monthly_summary` (monthly rollups of archived cost rows; raw `cost_logs` are retained for `COST_LOG_RETENTION_DAYS` days [default 90, whole-month aligned] and older months are rolled up by `pnpm --filter @workspace/scripts archive-cost-logs`), `users` (with roles), `session` (auto-created by connect-pg-simple), `app_settings` (key-value store for configurable thresholds like `dailyCostThreshold`), `social_content_plan_items` (content planning layer with CSV import support), `brand_schedule_profiles` (7×24 heat map grids per brand per platform), and `smart_schedule_proposals` (AI-generated scheduling proposals with rationale and slot scores). Schema files are in `lib/db/src/schema/` — the creatives/variants/calendar/refinement/cost/schedule tables are defined in `creatives.ts`.

## External Dependencies
- **AI Services**:
    - Claude (claude-sonnet-4-6): For captions, headlines, and refinement analysis.
    - Gemini (gemini-2.5-flash-image): For image generation.
    - Veo 2.0: For video generation.
    - ElevenLabs: For text-to-music and text-to-SFX.
- **Image Processing**: Sharp (for compositing and overlays).
- **Video Processing**: ffmpeg (for audio/video merging).
- **Archiving**: Archiver (for ZIP generation of content).
- **Social Media APIs**:
    - Twitter API v2 (with OAuth 1.0a media upload via `oauth-1.0a` package)
    - Instagram Graph API (Authorization header auth, Feed + Stories)
    - LinkedIn Community Management API (v202401)
    - TikTok Content Posting API v2 (OAuth 2.0 PKCE, video upload + photo posts)
    - YouTube Data API v3 (resumable video upload, Google OAuth 2.0)

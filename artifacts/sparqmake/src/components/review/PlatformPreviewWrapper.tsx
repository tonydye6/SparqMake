import { TikTokPreviewFrame } from "@/components/ui/tiktok-preview-frame";
import { InstagramFeedPreviewFrame } from "@/components/ui/instagram-feed-preview-frame";
import { InstagramStoryPreviewFrame } from "@/components/ui/instagram-story-preview-frame";
import { TwitterPreviewFrame } from "@/components/ui/twitter-preview-frame";
import { LinkedInPreviewFrame } from "@/components/ui/linkedin-preview-frame";

interface PlatformPreviewWrapperProps {
  platform: string;
  imageUrl?: string | null;
  caption?: string;
  headlineText?: string | null;
}

export function PlatformPreviewWrapper({
  platform,
  imageUrl,
  caption,
  headlineText,
}: PlatformPreviewWrapperProps) {
  switch (platform) {
    case "tiktok":
      return (
        <div className="max-w-[180px]">
          <TikTokPreviewFrame imageUrl={imageUrl ?? undefined} caption={caption ?? undefined} />
        </div>
      );
    case "instagram_feed":
      return (
        <div className="max-w-[280px]">
          <InstagramFeedPreviewFrame imageUrl={imageUrl ?? undefined} caption={caption ?? undefined} />
        </div>
      );
    case "instagram_story":
      return (
        <div className="max-w-[180px]">
          <InstagramStoryPreviewFrame imageUrl={imageUrl ?? undefined} caption={caption ?? undefined} />
        </div>
      );
    case "twitter":
      return (
        <div className="max-w-[320px]">
          <TwitterPreviewFrame imageUrl={imageUrl ?? undefined} caption={caption ?? undefined} />
        </div>
      );
    case "linkedin":
      return (
        <div className="max-w-[320px]">
          <LinkedInPreviewFrame imageUrl={imageUrl ?? undefined} caption={caption ?? undefined} />
        </div>
      );
    default:
      return imageUrl ? (
        <img src={imageUrl} alt={caption ?? ""} className="rounded-lg" />
      ) : null;
  }
}

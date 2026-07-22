/**
 * CaptionCard — platform pills, rewrite chips, alternates with Use this / Copy.
 * Spec §Phase D / CaptionCard.tsx
 */
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { Variant, RunTurnFn } from "./types";

interface CaptionAlternate {
  headline?: string;
  caption: string;
}

interface CaptionCardProps {
  activeVariant: Variant | null;
  allVariants: Variant[];
  captionAlternates: CaptionAlternate[];
  running: boolean;
  canWrite: boolean;
  runTurn: RunTurnFn;
  onFillComposer: (text: string) => void;
}

const PLATFORM_PILLS = [
  { label: "All", value: "all" },
  { label: "IG Feed", value: "instagram_feed" },
  { label: "IG Story", value: "instagram_story" },
  { label: "Twitter", value: "twitter" },
  { label: "LinkedIn", value: "linkedin" },
  { label: "TikTok", value: "tiktok" },
  { label: "YouTube", value: "youtube" },
] as const;

type PlatformValue = typeof PLATFORM_PILLS[number]["value"];

function getCaptionForPlatform(
  platform: PlatformValue,
  allVariants: Variant[],
  activeVariant: Variant | null,
): { headline?: string; caption?: string } {
  if (platform === "all") {
    return {
      headline: activeVariant?.headlineText ?? undefined,
      caption: activeVariant?.caption ?? undefined,
    };
  }
  const match = allVariants.find(v => v.platform === platform);
  if (match) {
    return { headline: match.headlineText ?? undefined, caption: match.caption ?? undefined };
  }
  return {
    headline: activeVariant?.headlineText ?? undefined,
    caption: activeVariant?.caption ?? undefined,
  };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
    >
      {copied ? <Check size={10} className="text-green-500" /> : <Copy size={10} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function CaptionCard({
  activeVariant,
  allVariants,
  captionAlternates,
  running,
  canWrite,
  runTurn,
  onFillComposer,
}: CaptionCardProps) {
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformValue>("all");
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  const { headline, caption } = getCaptionForPlatform(
    selectedPlatform,
    allVariants,
    activeVariant,
  );

  if (!caption && captionAlternates.length === 0) return null;

  const platformLabel =
    PLATFORM_PILLS.find(p => p.value === selectedPlatform)?.label ?? "All";

  const platformArg = selectedPlatform === "all" ? undefined : selectedPlatform;

  const handleUseThis = (alt: CaptionAlternate) => {
    const text = [alt.headline, alt.caption].filter(Boolean).join("\n");
    void runTurn(
      "caption",
      `Use exactly this caption and headline, verbatim:\n${text}`,
      platformArg,
    );
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border bg-muted/30 flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Caption
        </span>
      </div>

      {/* Platform pills — hidden for viewers (interactive control) */}
      {canWrite && (
        <div className="px-3 pt-2 flex flex-wrap gap-1">
          {PLATFORM_PILLS.map(p => (
            <button
              key={p.value}
              onClick={() => setSelectedPlatform(p.value)}
              className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-colors ${
                selectedPlatform === p.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* Caption text */}
      {(headline || caption) && (
        <div className="px-3 pt-2 pb-1 space-y-1">
          {headline && (
            <p className="text-xs font-semibold leading-snug">{headline}</p>
          )}
          {caption && (
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {caption}
            </p>
          )}
        </div>
      )}

      {/* Rewrite chips — hidden for viewers */}
      {canWrite && (
        <div className="px-3 pt-1.5 pb-2 flex flex-wrap gap-1.5">
          {(["Punchier", "Shorter", "Add CTA"] as const).map(label => {
            const instructions: Record<string, string> = {
              Punchier: "Rewrite the caption to be punchier and more engaging",
              Shorter: "Rewrite the caption to be more concise and punchy",
              "Add CTA": "Rewrite the caption with a clear call-to-action at the end",
            };
            return (
              <button
                key={label}
                disabled={running}
                onClick={() => void runTurn("caption", instructions[label], platformArg)}
                className="px-2 py-0.5 rounded-full text-[10px] border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {label}
              </button>
            );
          })}
          <button
            disabled={running}
            onClick={() =>
              onFillComposer(
                selectedPlatform === "all"
                  ? "/caption "
                  : `/caption ${selectedPlatform} `,
              )
            }
            className="px-2 py-0.5 rounded-full text-[10px] border border-border bg-background hover:bg-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Rewrite...
          </button>
        </div>
      )}

      {/* Alternates */}
      {captionAlternates.length > 0 && (
        <div className="border-t border-border">
          <div className="px-3 py-1 text-[10px] text-muted-foreground font-medium">
            Alternates
          </div>
          <div className="space-y-0">
            {captionAlternates.map((alt, i) => (
              <div
                key={i}
                className="px-3 py-2 border-t border-border/50 first:border-t-0 space-y-1"
              >
                {alt.headline && (
                  <p className="text-xs font-semibold">{alt.headline}</p>
                )}
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {alt.caption}
                </p>
                {canWrite && (
                  <div className="flex items-center gap-2 pt-0.5">
                    <button
                      disabled={running}
                      onClick={() => handleUseThis(alt)}
                      className="text-[10px] text-primary hover:underline disabled:opacity-50 disabled:no-underline"
                    >
                      Use this
                    </button>
                    <CopyButton
                      text={[alt.headline, alt.caption].filter(Boolean).join("\n")}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import { MessageSquarePlus, Check, Loader2 } from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const API_BASE = import.meta.env.VITE_API_URL || "";

// One-tap "why" chips: quick taste reactions that feed the brand's learning
// loop. Tapping a chip records the reaction immediately; the note popover
// lets the team add a free-text "why" for stronger signals.
const REACTION_CHIPS = [
  "Love it",
  "Off-brand",
  "Too busy",
  "Wrong tone",
  "Great colors",
] as const;

export function TasteReactionChips({
  creativeId,
  variantId,
  target,
  className,
}: {
  creativeId: string;
  variantId: string;
  target: "take" | "variant";
  className?: string;
}) {
  const { toast } = useToast();
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteSending, setNoteSending] = useState(false);

  async function send(reaction: string, noteText?: string) {
    const res = await apiFetch(
      `${API_BASE}/api/creatives/${creativeId}/variants/${variantId}/reaction`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction, note: noteText || undefined, target }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error || "Could not save reaction");
    }
  }

  async function tapChip(reaction: string) {
    if (sent.has(reaction) || sending) return;
    setSending(reaction);
    try {
      await send(reaction);
      setSent((prev) => new Set(prev).add(reaction));
    } catch (err) {
      toast({ variant: "destructive", title: "Reaction not saved", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setSending(null);
    }
  }

  async function sendNote() {
    if (!note.trim() || noteSending) return;
    setNoteSending(true);
    try {
      await send("note", note.trim());
      setNote("");
      setNoteOpen(false);
      toast({ title: "Noted", description: "Your feedback feeds what we've learned for this brand." });
    } catch (err) {
      toast({ variant: "destructive", title: "Note not saved", description: err instanceof Error ? err.message : "Please try again." });
    } finally {
      setNoteSending(false);
    }
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1">
        {REACTION_CHIPS.map((chip) => {
          const done = sent.has(chip);
          return (
            <button
              key={chip}
              onClick={() => void tapChip(chip)}
              disabled={done || sending === chip}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                done
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
              )}
              title={done ? "Recorded" : `Tell the AI why: ${chip}`}
              data-testid={`reaction-chip-${chip.toLowerCase().replace(/\s+/g, "-")}-${variantId}`}
            >
              {done ? <Check size={10} /> : sending === chip ? <Loader2 size={10} className="animate-spin" /> : null}
              {chip}
            </button>
          );
        })}
        <button
          onClick={() => setNoteOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground"
          title="Add a note about why"
          data-testid={`reaction-note-toggle-${variantId}`}
        >
          <MessageSquarePlus size={10} />
          Why?
        </button>
      </div>
      {noteOpen && (
        <div className="space-y-1.5">
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What works or doesn't about this one?"
            className="min-h-14 resize-none text-xs"
            data-testid={`reaction-note-input-${variantId}`}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              disabled={noteSending || !note.trim()}
              onClick={() => void sendNote()}
              data-testid={`reaction-note-send-${variantId}`}
            >
              {noteSending ? <Loader2 size={10} className="mr-1 animate-spin" /> : null}
              Send
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Preview pane — 560px wide, hover toolbar, floating region popover,
 * CaptionCard, 72px history strip with edge fade.
 * Spec §Phase D
 */
import { useState, useRef, useEffect } from "react";
import { Crop, Download, History, MessageSquare } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionState, SessionAction, Region, RunTurnFn, AssetItem } from "./types";
import { API_BASE } from "./types";
import { CaptionCard } from "./CaptionCard";

interface PreviewPaneProps {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  hasImage: boolean;
  canWrite: boolean;
  regionMode: boolean;
  setRegionMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  pendingRegion: Region | null;
  setPendingRegion: (v: Region | null) => void;
  dragStart: { x: number; y: number } | null;
  setDragStart: (v: { x: number; y: number } | null) => void;
  dragCurrent: { x: number; y: number } | null;
  setDragCurrent: (v: { x: number; y: number } | null) => void;
  pickHistoryVariant: (variantId: string) => Promise<void>;
  runTurn: RunTurnFn;
  handleRegionEdit: (instruction: string) => void;
  attachedAssets: AssetItem[];
  onFillComposer: (text: string) => void;
}

/** Floating popover that appears near a drawn region selection. */
function RegionPopover({
  region,
  onApply,
  onCancel,
}: {
  region: Region;
  onApply: (instruction: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Anchor the popover near the bottom-right of the selection box
  const left = `${Math.min(region.x1 * 100, 75)}%`;
  const top = `${Math.min(region.y1 * 100 + 2, 88)}%`;

  return (
    <div
      className="absolute z-30 bg-popover border border-border rounded-xl shadow-xl p-3 w-64"
      style={{ left, top }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">Edit region</span>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X size={12} />
        </button>
      </div>
      <input
        ref={inputRef}
        type="text"
        placeholder="What should change here?"
        value={instruction}
        onChange={e => setInstruction(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && instruction.trim()) {
            e.preventDefault();
            onApply(instruction.trim());
          }
          if (e.key === "Escape") onCancel();
        }}
        className="w-full text-xs border border-border rounded-lg px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary mb-2"
      />
      <div className="flex gap-1.5 justify-end">
        <button
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
        >
          Cancel
        </button>
        <button
          onClick={() => { if (instruction.trim()) onApply(instruction.trim()); }}
          disabled={!instruction.trim()}
          className="text-xs bg-primary text-primary-foreground px-2.5 py-1 rounded-lg disabled:opacity-40 hover:bg-primary/90 transition-colors"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

export function PreviewPane({
  state,
  dispatch,
  hasImage,
  canWrite,
  regionMode,
  setRegionMode,
  pendingRegion,
  setPendingRegion,
  dragStart,
  setDragStart,
  dragCurrent,
  setDragCurrent,
  pickHistoryVariant,
  runTurn,
  handleRegionEdit,
  onFillComposer,
}: PreviewPaneProps) {
  const { activeVariant, historyVariants, allVariants, captionAlternates, running } = state;

  const handleImgMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragStart({
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    });
    setDragCurrent(null);
    e.preventDefault();
  };

  const handleImgMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode || !dragStart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDragCurrent({
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    });
  };

  const handleImgMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!regionMode || !dragStart || !dragCurrent) {
      setDragStart(null);
      return;
    }
    const region: Region = {
      x0: Math.min(dragStart.x, dragCurrent.x),
      y0: Math.min(dragStart.y, dragCurrent.y),
      x1: Math.max(dragStart.x, dragCurrent.x),
      y1: Math.max(dragStart.y, dragCurrent.y),
    };
    if (region.x1 - region.x0 > 0.05 && region.y1 - region.y0 > 0.05) {
      setPendingRegion(region);
      setRegionMode(false);
    }
    setDragStart(null);
    setDragCurrent(null);
    e.preventDefault();
  };

  if (!activeVariant) {
    return (
      <div className="flex-1 flex items-center justify-center min-w-0">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto mb-3">
            <MessageSquare size={24} className="text-muted-foreground/40" />
          </div>
          <p className="text-sm text-muted-foreground">
            Preview appears here after the first draft
          </p>
        </div>
      </div>
    );
  }

  const imageUrl = activeVariant.compositedImageUrl || activeVariant.rawImageUrl || "";
  const downloadUrl = activeVariant.videoUrl
    ? `${API_BASE}${activeVariant.videoUrl}`
    : imageUrl;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-auto">
      {/* Image + hover toolbar — my-auto keeps content centered when
          the pane is taller than the image (overflow-safe vertical centering) */}
      <div className="flex justify-center px-6 my-auto pb-2">
        <div className="w-full max-w-[560px]">
          <div
            className={cn(
              "relative rounded-xl overflow-hidden shadow-lg border border-border bg-card group",
              regionMode && "cursor-crosshair",
            )}
            onMouseDown={handleImgMouseDown}
            onMouseMove={handleImgMouseMove}
            onMouseUp={handleImgMouseUp}
            onMouseLeave={() => {
              if (regionMode) {
                setDragStart(null);
                setDragCurrent(null);
              }
            }}
          >
            {activeVariant.videoUrl ? (
              <video
                src={`${API_BASE}${activeVariant.videoUrl}`}
                className="w-full aspect-square object-cover"
                controls
                autoPlay
                loop
                muted
                playsInline
              />
            ) : (
              <img
                src={imageUrl}
                alt="Generated post"
                className="w-full aspect-square object-cover"
                draggable={false}
              />
            )}

            {activeVariant.headlineText && !activeVariant.videoUrl && (
              <div className="absolute inset-0 flex items-end p-4 bg-gradient-to-t from-black/60 to-transparent pointer-events-none">
                <p className="text-white font-bold text-lg leading-tight">
                  {activeVariant.headlineText}
                </p>
              </div>
            )}

            {/* Hover toolbar */}
            {!regionMode && hasImage && (
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                {/* Select region — writers only */}
                {canWrite && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      setRegionMode(m => !m);
                      setPendingRegion(null);
                    }}
                    disabled={running}
                    className="w-7 h-7 rounded-lg bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors disabled:opacity-40"
                    title="Select region"
                  >
                    <Crop size={13} />
                  </button>
                )}

                {/* Download — available to all */}
                <a
                  href={downloadUrl}
                  download
                  target="_blank"
                  rel="noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="w-7 h-7 rounded-lg bg-black/60 text-white flex items-center justify-center hover:bg-black/80 transition-colors"
                  title="Download"
                >
                  <Download size={13} />
                </a>
              </div>
            )}

            {/* Region draw selection box */}
            {regionMode && dragStart && dragCurrent && (
              <div
                className="absolute border-2 border-primary bg-primary/20 pointer-events-none"
                style={{
                  left: `${Math.min(dragStart.x, dragCurrent.x) * 100}%`,
                  top: `${Math.min(dragStart.y, dragCurrent.y) * 100}%`,
                  width: `${Math.abs(dragCurrent.x - dragStart.x) * 100}%`,
                  height: `${Math.abs(dragCurrent.y - dragStart.y) * 100}%`,
                }}
              />
            )}

            {/* Pending region indicator (dashed) */}
            {pendingRegion && (
              <div
                className="absolute border-2 border-primary border-dashed bg-primary/10 pointer-events-none"
                style={{
                  left: `${pendingRegion.x0 * 100}%`,
                  top: `${pendingRegion.y0 * 100}%`,
                  width: `${(pendingRegion.x1 - pendingRegion.x0) * 100}%`,
                  height: `${(pendingRegion.y1 - pendingRegion.y0) * 100}%`,
                }}
              />
            )}

            {/* Region popover — anchored near the selection */}
            {pendingRegion && (
              <RegionPopover
                region={pendingRegion}
                onApply={instruction => {
                  handleRegionEdit(instruction);
                  setPendingRegion(null);
                }}
                onCancel={() => setPendingRegion(null)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Caption card */}
      <div className="flex justify-center px-6 pb-4">
        <div className="w-full max-w-[560px]">
          <CaptionCard
            activeVariant={activeVariant}
            allVariants={allVariants}
            captionAlternates={captionAlternates ?? []}
            running={running}
            canWrite={canWrite}
            runTurn={runTurn}
            onFillComposer={onFillComposer}
          />
        </div>
      </div>

      {/* History strip */}
      {historyVariants.length > 1 && (
        <div className="border-t border-border px-6 py-3 shrink-0 mt-auto">
          <div className="flex items-center gap-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <History size={12} />
            History
          </div>
          {/* Horizontal scroll with edge fade */}
          <div className="relative">
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
              {historyVariants.map((h, i) => (
                <button
                  key={h.variantId}
                  onClick={() => void pickHistoryVariant(h.variantId)}
                  className={cn(
                    "shrink-0 w-[72px] h-[72px] rounded-lg border-2 overflow-hidden transition-all",
                    state.activeVariant?.id === h.variantId
                      ? "border-primary"
                      : "border-border hover:border-primary/50",
                  )}
                >
                  {h.thumbnailUrl ? (
                    <img
                      src={h.thumbnailUrl}
                      alt={`T${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full bg-muted flex items-center justify-center">
                      <span className="text-xs text-muted-foreground">T{i + 1}</span>
                    </div>
                  )}
                </button>
              ))}
            </div>
            {/* Edge fade */}
            <div className="absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-background to-transparent pointer-events-none" />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Preview pane — 560px wide, hover toolbar, floating region popover,
 * CaptionCard, 72px history strip with edge fade.
 * Spec §Phase D
 */
import { useState, useRef, useEffect } from "react";
import { Crop, Download, History, MessageSquare, Paperclip, Check, Loader2 } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionState, SessionAction, Region, RunTurnFn, AssetItem, BrandAsset } from "./types";
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
  handleRegionEdit: (instruction: string, assetIds: string[]) => void;
  attachedAssets: AssetItem[];
  onFillComposer: (text: string) => void;
  brandAssets: BrandAsset[] | null;
  assetsLoading: boolean;
  onLoadAssets: () => Promise<void>;
}

/** Floating popover that appears near a drawn region selection. */
function RegionPopover({
  region,
  onApply,
  onCancel,
  brandAssets,
  assetsLoading,
  onLoadAssets,
}: {
  region: Region;
  onApply: (instruction: string, assetIds: string[]) => void;
  onCancel: () => void;
  brandAssets: BrandAsset[] | null;
  assetsLoading: boolean;
  onLoadAssets: () => Promise<void>;
}) {
  const [instruction, setInstruction] = useState("");
  const [attachedAssets, setAttachedAssets] = useState<AssetItem[]>([]);
  const [showAssets, setShowAssets] = useState(false);
  const [atFilter, setAtFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const assetsPickerRef = useRef<HTMLDivElement>(null);

  // preventScroll: focusing must never scroll ancestor containers — that
  // shoves the preview image out of alignment inside its rounded crop box.
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (assetsPickerRef.current && !assetsPickerRef.current.contains(e.target as Node))
        setShowAssets(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const filteredAssets = (brandAssets ?? []).filter(
    a => !atFilter || a.name.toLowerCase().includes(atFilter),
  );

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInstruction(val);
    const cursor = e.target.selectionStart ?? val.length;
    const textBefore = val.slice(0, cursor);
    const atMatch = textBefore.match(/(^|\s)(@\w*)$/);
    if (atMatch) {
      setAtFilter(atMatch[2]!.slice(1).toLowerCase());
      setShowAssets(true);
      void onLoadAssets();
    } else {
      setShowAssets(false);
    }
  };

  const pickAsset = (asset: AssetItem) => {
    setShowAssets(false);
    setAttachedAssets(prev => {
      if (prev.some(a => a.id === asset.id)) return prev;
      if (prev.length >= 3) return prev;
      return [...prev, asset];
    });
    const cleaned = instruction
      .replace(/(^|\s)(@\w*)$/, (_, space: string) => space)
      .trimEnd();
    setInstruction(cleaned);
    inputRef.current?.focus();
  };

  const removeAsset = (id: string) =>
    setAttachedAssets(prev => prev.filter(a => a.id !== id));

  const doApply = () => {
    if (!instruction.trim()) return;
    onApply(instruction.trim(), attachedAssets.map(a => a.id));
  };

  // Anchor near the selection without ever leaving the preview column:
  // right-align when the region ends on the right half, and open above the
  // region when it ends near the bottom so the popover stays fully visible.
  const anchorRight = region.x1 > 0.5;
  const anchorAbove = region.y1 > 0.7;
  const style: React.CSSProperties = {
    ...(anchorRight ? { right: 0 } : { left: `${Math.min(region.x0 * 100, 55)}%` }),
    ...(anchorAbove
      ? { bottom: `${Math.min((1 - region.y0) * 100 + 2, 90)}%` }
      : { top: `${Math.min(region.y1 * 100 + 2, 88)}%` }),
  };

  return (
    <div
      className="absolute z-30 bg-popover border border-border rounded-xl shadow-xl p-3 w-72 max-w-full"
      style={style}
      onMouseDown={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-foreground">Edit region</span>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          <X size={12} />
        </button>
      </div>

      {/* Attached asset chips */}
      {attachedAssets.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {attachedAssets.map(a => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs rounded-full pl-1 pr-1.5 py-0.5"
            >
              {a.thumbnailUrl ? (
                <img
                  src={`${API_BASE}${a.thumbnailUrl}`}
                  alt=""
                  className="w-4 h-4 rounded-full object-cover"
                />
              ) : (
                <Paperclip size={10} />
              )}
              <span className="max-w-[80px] truncate">{a.name}</span>
              <button onClick={() => removeAsset(a.id)} className="hover:text-foreground">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Asset picker dropdown */}
      {showAssets && (
        <div
          ref={assetsPickerRef}
          className="mb-2 bg-background border border-border rounded-lg shadow-lg overflow-auto max-h-36"
        >
          {assetsLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-2">
              <Loader2 size={12} className="animate-spin" /> Loading assets...
            </div>
          )}
          {!assetsLoading && filteredAssets.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-2">
              {(brandAssets ?? []).length === 0
                ? "No image assets in this brand's library yet."
                : "No matching assets."}
            </p>
          )}
          {attachedAssets.length >= 3 && (
            <p className="text-xs text-muted-foreground px-3 py-1.5 border-b border-border bg-muted/30">
              Up to 3 assets per instruction
            </p>
          )}
          {!assetsLoading &&
            filteredAssets.map(a => {
              const selected = attachedAssets.some(s => s.id === a.id);
              return (
                <button
                  key={a.id}
                  onMouseDown={e => {
                    e.preventDefault();
                    if (attachedAssets.length < 3 || selected) pickAsset(a);
                  }}
                  className={cn(
                    "w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors",
                    selected ? "bg-primary/10 text-primary" : "hover:bg-muted",
                  )}
                >
                  {a.thumbnailUrl ? (
                    <img
                      src={`${API_BASE}${a.thumbnailUrl}`}
                      alt=""
                      className="w-6 h-6 rounded object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-6 h-6 rounded bg-muted flex items-center justify-center shrink-0">
                      <Paperclip size={10} />
                    </div>
                  )}
                  <span className="flex-1 truncate">{a.name}</span>
                  {selected && <Check size={11} className="shrink-0 text-primary" />}
                </button>
              );
            })}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-center gap-1.5 mb-2">
        <button
          onMouseDown={e => {
            e.preventDefault();
            void onLoadAssets();
            setShowAssets(o => !o);
          }}
          className={cn(
            "shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors",
            showAssets || attachedAssets.length > 0
              ? "bg-primary/10 text-primary border border-primary/30"
              : "border border-border text-muted-foreground hover:text-foreground hover:bg-muted",
          )}
          title="Attach library asset (@)"
        >
          <Paperclip size={12} />
        </button>
        <input
          ref={inputRef}
          type="text"
          placeholder="What should change here?"
          value={instruction}
          onChange={handleChange}
          onKeyDown={e => {
            if (e.key === "Enter" && instruction.trim()) {
              e.preventDefault();
              doApply();
            }
            if (e.key === "Escape") {
              if (showAssets) { setShowAssets(false); return; }
              onCancel();
            }
          }}
          className="flex-1 text-xs border border-border rounded-lg px-2.5 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Hint */}
      {attachedAssets.length === 0 && (
        <p className="text-[10px] text-muted-foreground/60 mb-2">@ to attach library images</p>
      )}

      {/* Actions */}
      <div className="flex gap-1.5 justify-end">
        <button
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
        >
          Cancel
        </button>
        <button
          onClick={doApply}
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
  brandAssets,
  assetsLoading,
  onLoadAssets,
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
        <div className="w-full max-w-[560px] relative">
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

          </div>

          {/* Region popover — rendered OUTSIDE the overflow-hidden image box
              so it is never clipped and focusing it can't scroll/shift the
              image. Positioned against this relative wrapper, which matches
              the image box footprint. */}
          {pendingRegion && (
            <RegionPopover
              region={pendingRegion}
              onApply={(instruction, assetIds) => {
                handleRegionEdit(instruction, assetIds);
                setPendingRegion(null);
              }}
              onCancel={() => setPendingRegion(null)}
              brandAssets={brandAssets}
              assetsLoading={assetsLoading}
              onLoadAssets={onLoadAssets}
            />
          )}
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

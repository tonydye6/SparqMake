/**
 * Slash-command composer.
 *
 * Keyboard contract:
 *   Enter        → send (or select highlighted command)
 *   Shift+Enter  → newline
 *   /            → opens command picker
 *   @            → opens asset picker
 *   ArrowUp/Down → navigate command picker
 *   Escape       → dismiss picker
 *
 * Canonical copy (no em dashes anywhere):
 * #1  Enter to send · Shift+Enter new line · / commands · @ attach assets
 * #4  Waiting for the current step to finish
 */
import {
  useState, useRef, useCallback, useEffect, useLayoutEffect,
} from "react";
import {
  Loader2, Send, X, Check, Paperclip, AlertCircle, Image as ImageIcon, Square,
} from "lucide-react";
import { cn, apiFetch } from "@/lib/utils";
import type {
  Session, SessionState, SessionAction, AssetItem, BrandAsset, RunTurnFn,
} from "./types";
import { API_BASE } from "./types";
import {
  getCommandsWithStatus, CAPTION_PLATFORMS, type CommandWithStatus,
} from "./commands";

interface ComposerProps {
  session: Session | null;
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  canWrite: boolean;
  /** Currently in region-draw mode (shows hint banner only, no text entry) */
  regionMode: boolean;
  setRegionMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  attachedAssets: AssetItem[];
  setAttachedAssets: React.Dispatch<React.SetStateAction<AssetItem[]>>;
  brandAssets: BrandAsset[] | null;
  assetsLoading: boolean;
  onLoadAssets: () => Promise<void>;
  handleSend: () => void;
  runTurn: RunTurnFn;
  onStop: () => void;
  /** Scroll the thread to the newest fan_out turn (for /schedule). */
  onScrollToFanOut: () => void;
  hasFanOutTurn: boolean;
  /** Compact single-line variant for the floating collapsed composer */
  compact?: boolean;
}

export function Composer({
  session,
  state,
  dispatch,
  canWrite,
  regionMode,
  setRegionMode,
  attachedAssets,
  setAttachedAssets,
  brandAssets,
  assetsLoading,
  onLoadAssets,
  handleSend,
  runTurn,
  onStop,
  onScrollToFanOut,
  hasFanOutTurn,
  compact = false,
}: ComposerProps) {
  const [showCommands, setShowCommands] = useState(false);
  const [commandFilter, setCommandFilter] = useState("");
  const [selectedCmdIndex, setSelectedCmdIndex] = useState(0);
  const [showAssets, setShowAssets] = useState(false);
  const [atFilter, setAtFilter] = useState("");
  /** Pending action set after picking a slash command that needs text */
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandsRef = useRef<HTMLDivElement>(null);
  const assetsRef = useRef<HTMLDivElement>(null);

  const hasImage = Boolean(session?.imageInteractionId);

  // All commands with availability status
  const allCommands: CommandWithStatus[] = getCommandsWithStatus(session, hasFanOutTurn).filter(c =>
    !commandFilter || c.cmd.startsWith(commandFilter),
  );

  // Reset selected index when filter changes
  useEffect(() => { setSelectedCmdIndex(0); }, [commandFilter]);

  const placeholder = regionMode
    ? "Waiting for you to draw a region on the image..."
    : pendingAction === "caption"
    ? "Platform (optional) then your caption instruction"
    : pendingAction === "video"
    ? "Describe the video edit (or press Enter to proceed)"
    : hasImage
    ? "Describe a change, or type / for commands"
    : "Describe the post you want, then press Enter";

  // Auto-grow textarea
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta || compact) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [state.composerText, compact]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      dispatch({ type: "setComposer", text: val });

      const cursor = e.target.selectionStart ?? val.length;
      const textBefore = val.slice(0, cursor);

      const slashMatch = textBefore.match(/(^|\s)(\/\w*)$/);
      if (slashMatch) {
        setCommandFilter(slashMatch[2]!.toLowerCase());
        setShowCommands(true);
        setShowAssets(false);
      } else {
        setShowCommands(false);
      }

      const atMatch = textBefore.match(/(^|\s)(@\w*)$/);
      if (atMatch) {
        setAtFilter(atMatch[2]!.slice(1).toLowerCase());
        setShowAssets(true);
        setShowCommands(false);
        void onLoadAssets();
      } else {
        setShowAssets(false);
      }
    },
    [dispatch, onLoadAssets],
  );

  /** Parse a fully-typed slash command (e.g. user typed "/draft my brief" and hit Enter) */
  const parseTypedSlash = useCallback((text: string): {
    action: string;
    instruction: string;
    platform?: string;
    assetIds: string[];
  } | null => {
    if (!text.startsWith("/")) return null;
    const parts = text.split(/\s+/);
    const cmd = parts[0]?.toLowerCase();
    const rest = parts.slice(1);
    const instruction = rest.join(" ");
    const assetIds = attachedAssets.map(a => a.id);
    switch (cmd) {
      case "/draft":
        return { action: "draft", instruction: instruction || "Draft a post", assetIds };
      case "/edit":
        return { action: "edit_image", instruction, assetIds };
      case "/caption": {
        const [first, ...instrParts] = rest;
        const platform = CAPTION_PLATFORMS[first?.toLowerCase() ?? ""];
        return {
          action: "caption",
          instruction: platform
            ? instrParts.join(" ") || "Rewrite captions to be punchier and more engaging"
            : instruction || "Rewrite captions to be punchier and more engaging",
          platform: platform || undefined,
          assetIds: [],
        };
      }
      case "/takes":
        return { action: "compare", instruction: "Generate 3 fresh takes", assetIds: [] };
      case "/video": {
        const action = session?.videoInteractionId ? "edit_video" : "convert_video";
        return {
          action,
          instruction: instruction ||
            "Convert this image into a dynamic short video clip with natural movement and ambient animation",
          assetIds: [],
        };
      }
      case "/set":
        return {
          action: "fan_out",
          instruction: "Create platform-optimized versions for all channels",
          assetIds: [],
        };
      default:
        return null;
    }
  }, [attachedAssets, session]);

  const doSend = useCallback(() => {
    if (state.running) return;
    const text = state.composerText.trim();

    // -- Pending actions from picker selection --

    if (pendingAction === "caption") {
      const [first, ...rest] = text.split(/\s+/);
      const platform = CAPTION_PLATFORMS[first?.toLowerCase() ?? ""];
      const instruction = platform
        ? rest.join(" ") || "Rewrite captions to be punchier and more engaging"
        : text || "Rewrite captions to be punchier and more engaging";
      void runTurn("caption", instruction, platform || undefined);
      dispatch({ type: "setComposer", text: "" });
      setAttachedAssets([]);
      setPendingAction(null);
      return;
    }

    if (pendingAction === "video") {
      const action = session?.videoInteractionId ? "edit_video" : "convert_video";
      const instruction =
        text ||
        "Convert this image into a dynamic short video clip with natural movement and ambient animation";
      void runTurn(action, instruction);
      dispatch({ type: "setComposer", text: "" });
      setAttachedAssets([]);
      setPendingAction(null);
      return;
    }

    if (pendingAction === "draft") {
      if (!text) return;
      void runTurn("draft", text, undefined, undefined, undefined, undefined, attachedAssets.map(a => a.id));
      setAttachedAssets([]);
      dispatch({ type: "setComposer", text: "" });
      setPendingAction(null);
      return;
    }

    if (pendingAction === "edit_image" || pendingAction === "edit_region") {
      if (!text) return;
      void runTurn(pendingAction, text, undefined, undefined, undefined, undefined, attachedAssets.map(a => a.id));
      setAttachedAssets([]);
      dispatch({ type: "setComposer", text: "" });
      setPendingAction(null);
      return;
    }

    // -- No pending command — try to parse typed slash command --
    const parsed = parseTypedSlash(text);
    if (parsed) {
      void runTurn(parsed.action, parsed.instruction, parsed.platform, undefined, undefined, undefined, parsed.assetIds.length > 0 ? parsed.assetIds : undefined);
      setAttachedAssets([]);
      dispatch({ type: "setComposer", text: "" });
      setPendingAction(null);
      return;
    }

    // Default: delegate to parent (draft-or-edit routing)
    handleSend();
  }, [state.running, state.composerText, pendingAction, session, runTurn, dispatch, handleSend, attachedAssets, setAttachedAssets, parseTypedSlash]);

  const pickCommand = useCallback(
    (cmd: CommandWithStatus) => {
      if (!cmd.available) return;
      setShowCommands(false);
      setSelectedCmdIndex(0);
      setPendingAction(null);

      // Remove the typed /word from the composer
      const cleaned = state.composerText
        .replace(/(^|\s)(\/\w*)$/, (_, space: string) => space)
        .trimEnd();

      if (cmd.cmd === "/region") {
        dispatch({ type: "setComposer", text: cleaned });
        setRegionMode(true);
        return;
      }

      if (cmd.cmd === "/schedule") {
        dispatch({ type: "setComposer", text: cleaned });
        onScrollToFanOut();
        return;
      }

      if (cmd.cmd === "/takes") {
        dispatch({ type: "setComposer", text: "" });
        void runTurn("compare", "Generate 3 fresh takes");
        return;
      }

      if (cmd.cmd === "/set") {
        dispatch({ type: "setComposer", text: "" });
        void runTurn("fan_out", "Create platform-optimized versions for all channels");
        return;
      }

      if (cmd.cmd === "/video") {
        dispatch({ type: "setComposer", text: cleaned });
        setPendingAction("video");
        textareaRef.current?.focus();
        return;
      }

      if (cmd.cmd === "/caption") {
        dispatch({ type: "setComposer", text: cleaned });
        setPendingAction("caption");
        textareaRef.current?.focus();
        return;
      }

      // /draft, /edit: just clear slash, user continues typing
      dispatch({ type: "setComposer", text: cleaned });
      setPendingAction(cmd.action);
      textareaRef.current?.focus();
    },
    [
      state.composerText, dispatch, setRegionMode, runTurn,
      onScrollToFanOut,
    ],
  );

  const pickAsset = useCallback(
    (asset: AssetItem) => {
      setShowAssets(false);
      setAttachedAssets(prev => {
        if (prev.some(a => a.id === asset.id)) return prev;
        if (prev.length >= 3) return prev;
        return [...prev, asset];
      });
      const cleaned = state.composerText
        .replace(/(^|\s)(@\w*)$/, (_, space: string) => space)
        .trimEnd();
      dispatch({ type: "setComposer", text: cleaned });
    },
    [state.composerText, dispatch, setAttachedAssets],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        setShowCommands(false);
        setShowAssets(false);
        return;
      }

      if (showCommands && allCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedCmdIndex(i => Math.min(i + 1, allCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedCmdIndex(i => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const cmd = allCommands[selectedCmdIndex];
          if (cmd) pickCommand(cmd);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (state.running) return;
        if (showAssets) return;
        doSend();
      }
    },
    [showCommands, showAssets, allCommands, selectedCmdIndex, pickCommand, doSend],
  );

  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (commandsRef.current && !commandsRef.current.contains(e.target as Node))
        setShowCommands(false);
      if (assetsRef.current && !assetsRef.current.contains(e.target as Node))
        setShowAssets(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  const filteredAssets = (brandAssets ?? []).filter(
    a => !atFilter || a.name.toLowerCase().includes(atFilter),
  );

  if (!canWrite) {
    return (
      <div className="border-t border-border px-3 py-2">
        <div className="text-xs text-muted-foreground bg-muted/50 border border-border rounded px-2.5 py-1.5 flex items-center gap-1.5">
          <AlertCircle size={11} />
          View-only · editors and admins can make changes
        </div>
      </div>
    );
  }

  const wrapperCls = compact
    ? "flex items-center gap-2"
    : "border-t border-border shrink-0";

  return (
    <div className={wrapperCls}>
      {/* Region-draw hint banner */}
      {!compact && regionMode && (
        <div className="border-b border-primary/20 bg-primary/5 px-3 py-1.5 text-xs text-primary flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm border border-primary" />
          Drag on the image to select a region
          <button
            onClick={() => setRegionMode(false)}
            className="ml-auto text-muted-foreground hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Attached asset chips */}
      {!compact && attachedAssets.length > 0 && (
        <div className="border-b border-border px-3 py-1.5 flex flex-wrap gap-1.5">
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
              {a.name}
              <button
                onClick={() =>
                  setAttachedAssets(prev => prev.filter(p => p.id !== a.id))
                }
                className="hover:text-foreground"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Main input area */}
      <div className={compact ? "flex-1 flex items-center gap-2" : "relative px-3 py-2"}>
        {/* Command picker */}
        {showCommands && allCommands.length > 0 && (
          <div
            ref={commandsRef}
            className="absolute bottom-full left-3 right-3 mb-1 bg-popover border border-border rounded-lg shadow-lg overflow-hidden z-20"
          >
            {allCommands.map((c, i) => (
              <button
                key={c.cmd}
                onMouseDown={e => {
                  e.preventDefault();
                  if (c.available) pickCommand(c);
                }}
                className={cn(
                  "w-full flex items-start gap-2 px-3 py-2 text-left transition-colors",
                  i === selectedCmdIndex && "bg-primary/10",
                  c.available ? "hover:bg-primary/10" : "opacity-50 cursor-default",
                )}
              >
                <span
                  className={cn(
                    "text-xs font-mono font-semibold w-20 shrink-0 mt-0.5",
                    c.available ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {c.cmd}
                </span>
                <span className="text-xs text-muted-foreground flex-1 leading-snug">
                  {c.available ? c.note(session) : (c.disabledReason ?? c.note(session))}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Asset picker */}
        {showAssets && (
          <div
            ref={assetsRef}
            className="absolute bottom-full left-3 right-3 mb-1 bg-popover border border-border rounded-lg shadow-lg overflow-auto z-20 max-h-44"
          >
            {assetsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground px-3 py-2">
                <Loader2 size={12} className="animate-spin" /> Loading assets...
              </div>
            )}
            {!assetsLoading && filteredAssets.length === 0 && (
              <p className="text-xs text-muted-foreground px-3 py-2">No matching assets.</p>
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
                        className="w-7 h-7 rounded object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded bg-muted flex items-center justify-center shrink-0">
                        <ImageIcon size={11} />
                      </div>
                    )}
                    <span className="flex-1 truncate">{a.name}</span>
                    {selected && <Check size={11} className="shrink-0 text-primary" />}
                  </button>
                );
              })}
          </div>
        )}

        {compact ? (
          /* Compact floating variant — single-line */
          <>
            <textarea
              ref={textareaRef}
              value={state.composerText}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={regionMode}
              className="flex-1 resize-none bg-transparent text-sm focus:outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
            />
            {state.running ? (
              <button
                onClick={onStop}
                className="text-destructive shrink-0"
                title="Stop"
              >
                <Square size={12} />
              </button>
            ) : (
              <button
                onClick={doSend}
                disabled={!state.composerText.trim()}
                className="text-primary disabled:opacity-40 shrink-0"
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            )}
          </>
        ) : (
          <div className="flex gap-2 items-end">
            {/* Attach button */}
            <button
              onClick={() => {
                void onLoadAssets();
                setShowAssets(o => !o);
                setShowCommands(false);
              }}
              disabled={state.running}
              className={cn(
                "shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40",
                showAssets || attachedAssets.length > 0
                  ? "bg-primary/10 text-primary border border-primary/30"
                  : "border border-border text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
              title="Attach library asset (@)"
            >
              <Paperclip size={14} />
            </button>

            {/* Textarea */}
            <textarea
              ref={textareaRef}
              data-composer-input
              value={state.composerText}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              disabled={regionMode}
              className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 min-h-[36px] max-h-[120px] overflow-y-auto"
            />

            {/* Send / Stop */}
            {state.running ? (
              <button
                onClick={onStop}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-destructive/10 border border-destructive/30 text-destructive hover:bg-destructive/20 transition-colors"
                title="Stop generation"
              >
                <Square size={12} />
              </button>
            ) : (
              <button
                onClick={doSend}
                disabled={!state.composerText.trim() || state.running}
                className="shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40"
                title="Send (Enter)"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Hint line */}
      {!compact && !regionMode && (
        <div className="px-3 pb-2 text-[10px] text-muted-foreground/60 select-none">
          {state.running
            ? "Waiting for the current step to finish"
            : "Enter to send · Shift+Enter new line · / commands · @ attach assets"}
        </div>
      )}
    </div>
  );
}

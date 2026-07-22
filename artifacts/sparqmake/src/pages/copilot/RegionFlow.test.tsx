/**
 * Region-edit flow tests (/region command).
 *
 * The flow spans the Composer and the parent session view, so these tests use
 * a stateful harness that mirrors SessionView's region wiring: it owns
 * regionMode / pendingRegion / drag state and implements handleRegionEdit the
 * same way (runTurn("edit_region", instruction, undefined, pendingRegion, ...)).
 *
 * Covers:
 *  1. Picking /region from the picker enters region mode: composer textarea is
 *     disabled, hint banner shows, no turn fires.
 *  2. Dismissing the hint banner exits region mode and re-enables the textarea.
 *  3. Drawing a region on the preview image opens the popover; applying an
 *     instruction sends an edit_region turn with the drawn region coordinates.
 *  4. Cancelling the popover discards the pending region and sends nothing.
 *  5. A too-small drag (below the 5% minimum) is ignored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useReducer, useState, useCallback } from "react";
import { Composer } from "./Composer";
import { PreviewPane } from "./PreviewPane";
import {
  sessionReducer,
  type Session,
  type SessionState,
  type AssetItem,
  type Region,
  type RunTurnFn,
  type Variant,
} from "./types";

const runTurnMock = vi.fn<RunTurnFn>(() => Promise.resolve());
const handleSendMock = vi.fn();
const onStopMock = vi.fn();
const onLoadAssetsMock = vi.fn(() => Promise.resolve());
const onScrollToFanOutMock = vi.fn();
const pickHistoryVariantMock = vi.fn(() => Promise.resolve());
const onFillComposerMock = vi.fn();

const baseSession: Session = {
  id: "s1",
  brandId: "b1",
  creativeId: "c1",
  status: "active",
  activeVariantId: "v1",
  imageInteractionId: "img-1",
  videoInteractionId: null,
  sessionTitle: null,
  lastTurnSummary: null,
  thumbnailUrl: null,
  totalCostUsd: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const activeVariant: Variant = {
  id: "v1",
  platform: "instagram_feed",
  compositedImageUrl: "/files/v1.png",
  rawImageUrl: null,
  videoUrl: null,
  caption: "A caption",
  headlineText: null,
};

const initialState: SessionState = {
  session: baseSession,
  turns: [],
  activeVariant,
  allVariants: [activeVariant],
  historyVariants: [],
  loading: false,
  running: false,
  composerText: "",
  progressMessages: [],
  error: null,
  captionAlternates: null,
  captionPlatform: null,
  fanOutVideoVariants: {},
};

/** Mirrors SessionView's region wiring across Composer + PreviewPane. */
function Harness() {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const [regionMode, setRegionMode] = useState(false);
  const [pendingRegion, setPendingRegion] = useState<Region | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [dragCurrent, setDragCurrent] = useState<{ x: number; y: number } | null>(null);
  const [attachedAssets, setAttachedAssets] = useState<AssetItem[]>([]);

  // Same shape as SessionView.handleRegionEdit
  const handleRegionEdit = useCallback((instruction: string, assetIds: string[]) => {
    if (!instruction.trim() || !pendingRegion) return;
    void runTurnMock(
      "edit_region", instruction, undefined, pendingRegion,
      undefined, undefined, assetIds.length > 0 ? assetIds : undefined,
    );
    setPendingRegion(null);
    setRegionMode(false);
  }, [pendingRegion]);

  return (
    <>
      <PreviewPane
        state={state}
        dispatch={dispatch}
        hasImage={true}
        canWrite={true}
        regionMode={regionMode}
        setRegionMode={setRegionMode}
        pendingRegion={pendingRegion}
        setPendingRegion={setPendingRegion}
        dragStart={dragStart}
        setDragStart={setDragStart}
        dragCurrent={dragCurrent}
        setDragCurrent={setDragCurrent}
        pickHistoryVariant={pickHistoryVariantMock}
        runTurn={runTurnMock}
        handleRegionEdit={handleRegionEdit}
        attachedAssets={attachedAssets}
        onFillComposer={onFillComposerMock}
        brandAssets={null}
        assetsLoading={false}
        onLoadAssets={onLoadAssetsMock}
      />
      <Composer
        session={baseSession}
        state={state}
        dispatch={dispatch}
        canWrite={true}
        regionMode={regionMode}
        setRegionMode={setRegionMode}
        attachedAssets={attachedAssets}
        setAttachedAssets={setAttachedAssets}
        brandAssets={null}
        assetsLoading={false}
        onLoadAssets={onLoadAssetsMock}
        handleSend={handleSendMock}
        runTurn={runTurnMock}
        onStop={onStopMock}
        onScrollToFanOut={onScrollToFanOutMock}
        hasFanOutTurn={false}
      />
    </>
  );
}

function getTextarea(): HTMLTextAreaElement {
  return document.querySelector(
    "textarea[data-composer-input]",
  ) as HTMLTextAreaElement;
}

function enterRegionMode() {
  const ta = getTextarea();
  fireEvent.change(ta, { target: { value: "/region" } });
  fireEvent.keyDown(ta, { key: "Enter" });
}

/** The image container that owns the region-draw mouse handlers. */
function getDrawSurface(): HTMLElement {
  const el = document.querySelector(".cursor-crosshair") as HTMLElement | null;
  if (!el) throw new Error("region-draw surface not found (not in region mode?)");
  return el;
}

/** Give the draw surface a deterministic 100x100 rect so drag math is exact. */
function mockRect(el: HTMLElement) {
  el.getBoundingClientRect = () =>
    ({
      left: 0, top: 0, width: 100, height: 100,
      right: 100, bottom: 100, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
}

function drawRegion(from: { x: number; y: number }, to: { x: number; y: number }) {
  const surface = getDrawSurface();
  mockRect(surface);
  fireEvent.mouseDown(surface, { clientX: from.x, clientY: from.y });
  fireEvent.mouseMove(surface, { clientX: to.x, clientY: to.y });
  fireEvent.mouseUp(surface, { clientX: to.x, clientY: to.y });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/region entry", () => {
  it("picking /region enters region mode and disables text entry", () => {
    render(<Harness />);
    const ta = getTextarea();
    expect(ta.disabled).toBe(false);
    enterRegionMode();
    // No turn fired; the composer is locked while drawing
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toMatch(/draw a region/i);
    // Hint banner is visible
    expect(screen.getByText("Drag on the image to select a region")).toBeInTheDocument();
    // Preview surface is now in crosshair draw mode
    expect(document.querySelector(".cursor-crosshair")).toBeInTheDocument();
  });

  it("dismissing the hint banner exits region mode and re-enables the textarea", () => {
    render(<Harness />);
    enterRegionMode();
    const banner = screen.getByText("Drag on the image to select a region");
    fireEvent.click(banner.parentElement!.querySelector("button")!);
    expect(screen.queryByText("Drag on the image to select a region")).not.toBeInTheDocument();
    expect(getTextarea().disabled).toBe(false);
    expect(document.querySelector(".cursor-crosshair")).not.toBeInTheDocument();
    expect(runTurnMock).not.toHaveBeenCalled();
  });
});

describe("drawing and applying a region", () => {
  it("drawing a region exits draw mode and opens the popover; applying sends edit_region with coordinates", () => {
    render(<Harness />);
    enterRegionMode();
    drawRegion({ x: 20, y: 30 }, { x: 60, y: 80 });

    // Draw mode ends once a valid region is captured; composer usable again
    expect(getTextarea().disabled).toBe(false);
    // Popover appears with the instruction input
    const input = screen.getByPlaceholderText("What should change here?");
    fireEvent.change(input, { target: { value: "remove the shadow" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock).toHaveBeenCalledWith(
      "edit_region",
      "remove the shadow",
      undefined,
      { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.8 },
      undefined,
      undefined,
      undefined,
    );
    // Popover closed after apply
    expect(screen.queryByPlaceholderText("What should change here?")).not.toBeInTheDocument();
  });

  it("normalizes a drag made from bottom-right to top-left", () => {
    render(<Harness />);
    enterRegionMode();
    drawRegion({ x: 60, y: 80 }, { x: 20, y: 30 });
    const input = screen.getByPlaceholderText("What should change here?");
    fireEvent.change(input, { target: { value: "brighten this area" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runTurnMock).toHaveBeenCalledWith(
      "edit_region",
      "brighten this area",
      undefined,
      { x0: 0.2, y0: 0.3, x1: 0.6, y1: 0.8 },
      undefined,
      undefined,
      undefined,
    );
  });

  it("cancelling the popover discards the region without sending a turn", () => {
    render(<Harness />);
    enterRegionMode();
    drawRegion({ x: 20, y: 30 }, { x: 60, y: 80 });
    const input = screen.getByPlaceholderText("What should change here?");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("What should change here?")).not.toBeInTheDocument();
    expect(runTurnMock).not.toHaveBeenCalled();
  });

  it("Apply is a no-op with an empty instruction", () => {
    render(<Harness />);
    enterRegionMode();
    drawRegion({ x: 20, y: 30 }, { x: 60, y: 80 });
    const input = screen.getByPlaceholderText("What should change here?");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runTurnMock).not.toHaveBeenCalled();
    // Popover stays open awaiting an instruction
    expect(screen.getByPlaceholderText("What should change here?")).toBeInTheDocument();
  });

  it("ignores a drag smaller than the 5% minimum size", () => {
    render(<Harness />);
    enterRegionMode();
    drawRegion({ x: 50, y: 50 }, { x: 52, y: 52 });
    // No popover; still in region-draw mode
    expect(screen.queryByPlaceholderText("What should change here?")).not.toBeInTheDocument();
    expect(getTextarea().disabled).toBe(true);
    expect(runTurnMock).not.toHaveBeenCalled();
  });
});

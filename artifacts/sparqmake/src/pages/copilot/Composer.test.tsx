/**
 * Composer slash-command and @-mention tests.
 *
 * Covers:
 *  1. Typing /draft opens the command picker; a typed "/draft <brief>" + Enter
 *     runs a draft turn and clears the composer.
 *  2. /edit with no existing image is disabled in the picker and cannot be picked.
 *  3. Typing @logo opens the asset picker; selecting an asset adds a chip and
 *     clears the @ token from the composer.
 *  4. Shift+Enter does not send.
 *  5. Enter on plain text delegates to handleSend.
 *  6. The Stop button calls onStop while a turn is running.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useReducer, useState } from "react";
import { Composer } from "./Composer";
import {
  sessionReducer,
  type Session,
  type SessionState,
  type AssetItem,
  type BrandAsset,
} from "./types";

const runTurnMock = vi.fn(() => Promise.resolve());
const handleSendMock = vi.fn();
const onStopMock = vi.fn();
const onLoadAssetsMock = vi.fn(() => Promise.resolve());
const onScrollToFanOutMock = vi.fn();
const setRegionModeMock = vi.fn();

const baseSession: Session = {
  id: "s1",
  brandId: "b1",
  creativeId: "c1",
  status: "active",
  activeVariantId: null,
  imageInteractionId: "img-1",
  videoInteractionId: null,
  sessionTitle: null,
  lastTurnSummary: null,
  thumbnailUrl: null,
  totalCostUsd: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const initialState: SessionState = {
  session: null,
  turns: [],
  activeVariant: null,
  allVariants: [],
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

const logoAsset: BrandAsset = {
  id: "asset-1",
  name: "logo-primary",
  type: "logo",
  thumbnailUrl: null,
  fileUrl: null,
};

function Harness({
  session = baseSession,
  running = false,
  brandAssets = null,
  clearOnSend = false,
}: {
  session?: Session | null;
  running?: boolean;
  brandAssets?: BrandAsset[] | null;
  /** Mirror the parent SessionView, which clears the composer inside handleSend. */
  clearOnSend?: boolean;
}) {
  const [state, dispatch] = useReducer(sessionReducer, {
    ...initialState,
    running,
  });
  const [attachedAssets, setAttachedAssets] = useState<AssetItem[]>([]);
  const handleSend = () => {
    handleSendMock();
    if (clearOnSend) dispatch({ type: "setComposer", text: "" });
  };
  return (
    <Composer
      session={session}
      state={state}
      dispatch={dispatch}
      canWrite={true}
      regionMode={false}
      setRegionMode={setRegionModeMock}
      attachedAssets={attachedAssets}
      setAttachedAssets={setAttachedAssets}
      brandAssets={brandAssets}
      assetsLoading={false}
      onLoadAssets={onLoadAssetsMock}
      handleSend={handleSend}
      runTurn={runTurnMock}
      onStop={onStopMock}
      onScrollToFanOut={onScrollToFanOutMock}
      hasFanOutTurn={false}
    />
  );
}

function getTextarea(): HTMLTextAreaElement {
  return document.querySelector(
    "textarea[data-composer-input]",
  ) as HTMLTextAreaElement;
}

function type(ta: HTMLTextAreaElement, value: string) {
  fireEvent.change(ta, { target: { value } });
}

/** Find a command-picker row span (excludes the textarea, whose value also matches text queries). */
function commandRow(cmd: string): HTMLElement | null {
  const spans = screen.queryAllByText(cmd, { selector: "span" });
  return spans[0] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("slash commands", () => {
  it("typing /draft opens the command picker filtered to /draft", () => {
    render(<Harness />);
    const ta = getTextarea();
    type(ta, "/draft");
    expect(commandRow("/draft")).toBeInTheDocument();
    expect(commandRow("/caption")).toBeNull();
  });

  it("a fully typed /draft brief runs a draft turn on Enter and clears the composer", () => {
    render(<Harness />);
    const ta = getTextarea();
    type(ta, "/draft a summer sale post");
    // No trailing /word, so the picker is closed and Enter sends
    expect(screen.queryByText("Generate a first draft from your brief")).not.toBeInTheDocument();
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(runTurnMock).toHaveBeenCalledWith(
      "draft",
      "a summer sale post",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(handleSendMock).not.toHaveBeenCalled();
    expect(ta.value).toBe("");
  });

  it("selecting /draft from the picker with Enter clears the slash token and waits for a brief", () => {
    render(<Harness />);
    const ta = getTextarea();
    type(ta, "/draft");
    fireEvent.keyDown(ta, { key: "Enter" });
    // Picker selection consumed the Enter; no turn fired yet
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(ta.value).toBe("");
    // Now type the brief and Enter -> draft turn runs
    type(ta, "my brief");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(runTurnMock).toHaveBeenCalledWith(
      "draft",
      "my brief",
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
  });

  it("/edit cannot be picked when the session has no image (excluded from selection)", () => {
    // Intended behavior: unavailable commands are rendered disabled with the
    // reason "Needs a draft first" (for discoverability) and are excluded from
    // selection — neither keyboard Enter nor a click can activate them.
    render(<Harness session={{ ...baseSession, imageInteractionId: null }} />);
    const ta = getTextarea();
    type(ta, "/edit");
    const row = commandRow("/edit");
    expect(row).toBeInTheDocument();
    expect(screen.getByText("Needs a draft first")).toBeInTheDocument();
    // Enter on the disabled command is a no-op: no turn, no pending edit
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(runTurnMock).not.toHaveBeenCalled();
    // Clicking the disabled row is also a no-op
    fireEvent.mouseDown(row!.closest("button")!);
    expect(runTurnMock).not.toHaveBeenCalled();
    // The slash text remains untouched (pickCommand bailed both times)
    expect(ta.value).toBe("/edit");
  });

  it("/edit is available when the session has an image", () => {
    render(<Harness />);
    const ta = getTextarea();
    type(ta, "/edit");
    expect(commandRow("/edit")).toBeInTheDocument();
    expect(screen.queryByText("Needs a draft first")).not.toBeInTheDocument();
  });
});

describe("@ asset mentions", () => {
  it("typing @logo opens the asset picker and loads assets", () => {
    render(<Harness brandAssets={[logoAsset]} />);
    const ta = getTextarea();
    type(ta, "@logo");
    expect(onLoadAssetsMock).toHaveBeenCalled();
    expect(screen.getByText("logo-primary")).toBeInTheDocument();
  });

  it("selecting an asset adds a chip and clears the @ token", async () => {
    render(<Harness brandAssets={[logoAsset]} />);
    const ta = getTextarea();
    type(ta, "add the @logo");
    const option = screen.getByText("logo-primary");
    fireEvent.mouseDown(option.closest("button")!);
    await waitFor(() => {
      // Chip rendered in the attached-assets strip
      expect(screen.getByText("logo-primary")).toBeInTheDocument();
    });
    // Picker closed (only the chip remains)
    expect(screen.getAllByText("logo-primary")).toHaveLength(1);
    // @token removed from the composer text
    expect(ta.value).toBe("add the");
  });

  it("filters assets by the text after @", () => {
    const other: BrandAsset = { ...logoAsset, id: "asset-2", name: "hero-banner" };
    render(<Harness brandAssets={[logoAsset, other]} />);
    const ta = getTextarea();
    type(ta, "@logo");
    expect(screen.getByText("logo-primary")).toBeInTheDocument();
    expect(screen.queryByText("hero-banner")).not.toBeInTheDocument();
  });
});

describe("keyboard behavior", () => {
  it("Shift+Enter does not send", () => {
    render(<Harness />);
    const ta = getTextarea();
    type(ta, "hello world");
    fireEvent.keyDown(ta, { key: "Enter", shiftKey: true });
    expect(handleSendMock).not.toHaveBeenCalled();
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(ta.value).toBe("hello world");
  });

  it("Enter on plain text sends via handleSend and the composer ends up cleared", () => {
    // The parent's handleSend clears the composer after dispatching the turn
    // (mirrored here by the harness), so Enter -> sent + empty input.
    render(<Harness clearOnSend />);
    const ta = getTextarea();
    type(ta, "make the sky bluer");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(handleSendMock).toHaveBeenCalledTimes(1);
    expect(runTurnMock).not.toHaveBeenCalled();
    expect(ta.value).toBe("");
  });

  it("Enter does nothing while a turn is running", () => {
    render(<Harness running />);
    const ta = getTextarea();
    type(ta, "queued text");
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(handleSendMock).not.toHaveBeenCalled();
    expect(runTurnMock).not.toHaveBeenCalled();
  });
});

describe("stop button", () => {
  it("shows Stop while running and calls onStop on click", () => {
    render(<Harness running />);
    const stop = screen.getByTitle("Stop generation");
    fireEvent.click(stop);
    expect(onStopMock).toHaveBeenCalledTimes(1);
  });

  it("shows Send when not running", () => {
    render(<Harness />);
    expect(screen.getByTitle("Send (Enter)")).toBeInTheDocument();
    expect(screen.queryByTitle("Stop generation")).not.toBeInTheDocument();
  });
});

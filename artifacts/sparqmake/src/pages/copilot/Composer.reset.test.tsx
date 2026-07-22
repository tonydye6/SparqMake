import { describe, it, expect, vi } from "vitest";
import { useReducer, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { sessionReducer } from "./types";
import type { Session, SessionState, BrandAsset, AssetItem } from "./types";

function makeSession(id: string, brandId: string): Session {
  return {
    id,
    brandId,
    creativeId: "creative-1",
    status: "active",
    activeVariantId: null,
    imageInteractionId: null,
    videoInteractionId: null,
    sessionTitle: "Test session",
    lastTurnSummary: null,
    thumbnailUrl: null,
    totalCostUsd: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

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

const brandAAssets: BrandAsset[] = [
  { id: "a1", name: "logo-a.png", type: "visual", thumbnailUrl: null, fileUrl: "/f/a1" },
  { id: "a2", name: "hero-a.png", type: "visual", thumbnailUrl: null, fileUrl: "/f/a2" },
];

interface HarnessProps {
  sessionId: string;
  brandAssets: BrandAsset[] | null;
  onLoadAssets?: () => Promise<void>;
}

function Harness({ sessionId, brandAssets, onLoadAssets }: HarnessProps) {
  const [state, dispatch] = useReducer(sessionReducer, {
    ...initialState,
    session: makeSession(sessionId, sessionId === "session-a" ? "brand-a" : "brand-b"),
  });
  const [attachedAssets, setAttachedAssets] = useState<AssetItem[]>([]);

  return (
    <Composer
      session={state.session}
      state={state}
      dispatch={dispatch}
      canWrite
      regionMode={false}
      setRegionMode={() => {}}
      attachedAssets={attachedAssets}
      setAttachedAssets={setAttachedAssets}
      brandAssets={brandAssets}
      assetsLoading={false}
      onLoadAssets={onLoadAssets ?? (() => Promise.resolve())}
      handleSend={() => {}}
      runTurn={() => Promise.resolve()}
      onStop={() => {}}
      onScrollToFanOut={() => {}}
      hasFanOutTurn={false}
      sessionId={sessionId}
    />
  );
}

describe("Composer asset picker reset on session switch", () => {
  it("closes the picker and clears the list when switching to a different-brand session", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Harness sessionId="session-a" brandAssets={brandAAssets} />,
    );

    // Open the asset picker in session A by typing "@"
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "@");

    // Picker is open showing brand A assets
    expect(screen.getByText("logo-a.png")).toBeInTheDocument();
    expect(screen.getByText("hero-a.png")).toBeInTheDocument();

    // Switch to session B (different brand); SessionView resets brandAssets to null
    rerender(<Harness sessionId="session-b" brandAssets={null} />);

    // Picker is closed and no stale brand A assets are shown
    expect(screen.queryByText("logo-a.png")).not.toBeInTheDocument();
    expect(screen.queryByText("hero-a.png")).not.toBeInTheDocument();
    expect(screen.queryByText("No matching assets.")).not.toBeInTheDocument();
  });

  it("keeps the picker closed even if brandAssets still holds the old brand list", async () => {
    // Guards against the race where the lazy reload has not fired yet
    const user = userEvent.setup();
    const { rerender } = render(
      <Harness sessionId="session-a" brandAssets={brandAAssets} />,
    );

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "@log");
    expect(screen.getByText("logo-a.png")).toBeInTheDocument();

    // Session switches but the stale asset list is still passed down
    rerender(<Harness sessionId="session-b" brandAssets={brandAAssets} />);

    expect(screen.queryByText("logo-a.png")).not.toBeInTheDocument();

    // Reopening the picker via the attach button triggers a fresh load with an empty filter
    const onLoadAssets = vi.fn(() => Promise.resolve());
    rerender(
      <Harness sessionId="session-b" brandAssets={null} onLoadAssets={onLoadAssets} />,
    );
    await user.click(screen.getByTitle("Attach library asset (@)"));
    expect(onLoadAssets).toHaveBeenCalled();
    // Unfiltered picker with no assets loaded yet shows the empty state, not brand A items
    expect(screen.getByText("No matching assets.")).toBeInTheDocument();
    expect(screen.queryByText("logo-a.png")).not.toBeInTheDocument();
  });
});

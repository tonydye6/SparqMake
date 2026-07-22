/**
 * TurnCard cancelled-turn Retry behavior:
 *  - Cancelled copilot turns show a Retry button
 *  - Retry re-runs the preceding user turn's action/instruction/platform/region
 *  - Retry is disabled while another turn is running
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TurnCard } from "./TurnCard";
import type { Turn, RunTurnFn } from "./types";

afterEach(cleanup);

function makeTurn(overrides: Partial<Turn>): Turn {
  return {
    id: "t1",
    seq: 1,
    role: "copilot",
    instruction: null,
    action: "edit_image",
    status: "cancelled",
    resultVariantIds: [],
    costUsd: null,
    durationMs: null,
    error: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const noop = () => {};

function renderCard(props: {
  turn: Turn;
  prevUserTurn?: Turn | null;
  isRunning?: boolean;
  canWrite?: boolean;
}) {
  const runTurn = vi.fn<RunTurnFn>(async () => {});
  render(
    <TurnCard
      turn={props.turn}
      allVariants={[]}
      activeVariantId={null}
      isLatestDone={false}
      canWrite={props.canWrite ?? true}
      runTurn={runTurn}
      turnPayload={null}
      prevUserTurn={props.prevUserTurn ?? null}
      isRunning={props.isRunning ?? false}
      onFillComposer={noop}
      onPickTake={noop}
      onSchedule={noop}
      onConvertVideo={noop}
      convertedVariants={{}}
      onBranchToVariant={noop}
      onNavigateHome={noop}
    />,
  );
  return runTurn;
}

describe("TurnCard cancelled retry", () => {
  it("shows a Retry button on cancelled turns", () => {
    renderCard({ turn: makeTurn({}) });
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByTestId("button-retry-turn-t1")).toBeTruthy();
  });

  it("re-runs the preceding user turn's payload on click", async () => {
    const prevUserTurn = makeTurn({
      id: "u1",
      role: "user",
      action: "edit_region",
      instruction: "make the sky purple",
      status: "done",
      instructionPayload: {
        platform: "instagram_feed",
        region: { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 },
      },
    });
    const runTurn = renderCard({ turn: makeTurn({}), prevUserTurn });
    await userEvent.click(screen.getByTestId("button-retry-turn-t1"));
    expect(runTurn).toHaveBeenCalledWith(
      "edit_region",
      "make the sky purple",
      "instagram_feed",
      { x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6 },
      undefined,
    );
  });

  it("is disabled while another turn is running", async () => {
    const runTurn = renderCard({ turn: makeTurn({}), isRunning: true });
    const btn = screen.getByTestId("button-retry-turn-t1") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await userEvent.click(btn);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("hides Retry for viewers without write access", () => {
    renderCard({ turn: makeTurn({}), canWrite: false });
    expect(screen.queryByTestId("button-retry-turn-t1")).toBeNull();
  });
});

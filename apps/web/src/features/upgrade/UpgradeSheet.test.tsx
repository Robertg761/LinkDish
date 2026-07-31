import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpgradeSheetProvider, useUpgradeSheet } from "./UpgradeSheet";

const analyticsMocks = vi.hoisted(() => ({
  trackWebEvent: vi.fn()
}));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: {
      billingPlan: "free",
      email: "cook@example.com",
      id: "user_1"
    }
  })
}));

const TriggerButtons = () => {
  const { requestUpgradeSheet } = useUpgradeSheet();

  return (
    <>
      <button onClick={() => requestUpgradeSheet("save_limit")} type="button">
        Save limit
      </button>
      <button onClick={() => requestUpgradeSheet("import_limit")} type="button">
        Import limit
      </button>
    </>
  );
};

const renderUpgradeHarness = () =>
  render(
    <MemoryRouter>
      <UpgradeSheetProvider>
        <TriggerButtons />
      </UpgradeSheetProvider>
    </MemoryRouter>
  );

describe("UpgradeSheetProvider", () => {
  beforeEach(() => {
    analyticsMocks.trackWebEvent.mockReset();
    sessionStorage.clear();
  });

  it("shows a sheet once per trigger per session and never stacks sheets", async () => {
    renderUpgradeHarness();

    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));

    expect(
      await screen.findByRole("dialog", { name: "Your free cookbook is full." })
    ).toBeInTheDocument();
    expect(screen.getByText(/You have 15 recipes saved on Free/u)).toBeInTheDocument();
    expect(screen.getByText("Better recovery for difficult recipe pages")).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "upgrade_viewed",
        properties: {
          trigger: "save_limit"
        }
      })
    );

    fireEvent.click(screen.getByRole("button", { name: "Import limit" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss upgrade" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Save limit" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import limit" }));
    expect(
      await screen.findByRole("dialog", { name: "More room for the recipes worth keeping." })
    ).toBeInTheDocument();
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledTimes(2);
  });
});

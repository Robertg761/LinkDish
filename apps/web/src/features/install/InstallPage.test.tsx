import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";

import { BOOKMARKLET_HREF } from "./install-content";
import { InstallPage } from "./InstallPage";

import type { InstallOutcome, InstallPlatform } from "../../platform/install-prompt";

const installMocks = vi.hoisted(() => ({
  canInstall: false,
  isInstalled: false,
  platform: "desktop" as InstallPlatform,
  promptInstall: vi.fn<() => Promise<InstallOutcome>>()
}));

vi.mock("../../platform/install-prompt", () => ({
  useInstallPrompt: () => ({
    canInstall: installMocks.canInstall,
    isInstalled: installMocks.isInstalled,
    platform: installMocks.platform,
    promptInstall: installMocks.promptInstall
  })
}));

const analyticsMocks = vi.hoisted(() => ({ trackWebEvent: vi.fn() }));

vi.mock("../../analytics/client", () => ({
  trackWebEvent: analyticsMocks.trackWebEvent
}));

const renderInstall = () =>
  render(
    <ToastProvider>
      <InstallPage />
    </ToastProvider>
  );

describe("InstallPage", () => {
  beforeEach(() => {
    installMocks.canInstall = false;
    installMocks.isInstalled = false;
    installMocks.platform = "desktop";
    installMocks.promptInstall.mockReset();
    installMocks.promptInstall.mockResolvedValue("accepted");
    analyticsMocks.trackWebEvent.mockReset();
  });

  it("offers a real install button when the browser allows it", async () => {
    installMocks.canInstall = true;
    installMocks.platform = "android";

    renderInstall();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Install LinkDish" }));
      await Promise.resolve();
    });

    expect(installMocks.promptInstall).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.trackWebEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "web_install_cta_clicked" })
    );
    expect(await screen.findByText("LinkDish is installing")).toBeVisible();
  });

  it("shows only this device's steps, with other devices tucked away", () => {
    installMocks.platform = "ios";

    renderInstall();

    expect(screen.queryByRole("button", { name: "Install LinkDish" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /iPhone and iPad/u })).toBeVisible();
    expect(screen.getAllByText("Add to Home Screen", { selector: "strong" })[0]).toBeVisible();

    const other = screen.getByText("Installing on another device?").closest("details");
    expect(other).not.toBeNull();
    expect(other).not.toHaveAttribute("open");
    expect(
      within(other as HTMLElement).getByRole("heading", { name: /Android/u })
    ).toBeInTheDocument();
    expect(
      within(other as HTMLElement).queryByRole("heading", { name: /iPhone/u })
    ).not.toBeInTheDocument();
  });

  it("says so when LinkDish is already installed", () => {
    installMocks.isInstalled = true;

    renderInstall();

    expect(screen.getByRole("heading", { name: "You're all set" })).toBeVisible();
    expect(screen.queryByText("Installing on another device?")).not.toBeInTheDocument();
  });

  it("provides a draggable Save to LinkDish bookmarklet", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderInstall();

    const bookmarklet = screen.getByRole("link", { name: "Save to LinkDish" });
    expect(bookmarklet.getAttribute("href")).toBe(
      "javascript:location.href='https://app.linkdish.ca/import?url='+encodeURIComponent(location.href)"
    );
    expect(BOOKMARKLET_HREF).toBe(bookmarklet.getAttribute("href"));

    // Clicking it on this page would only import the install page, so it explains dragging instead.
    fireEvent.click(bookmarklet);
    expect(
      await screen.findByText("Drag the button to your bookmarks bar to use it.")
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Copy the code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(BOOKMARKLET_HREF));
  });

  it("explains sharing into LinkDish for each platform", () => {
    installMocks.platform = "android";

    renderInstall();

    const tips = screen.getByText("Android", { selector: "strong" }).closest("li");
    expect(tips).toHaveClass("is-yours");
    expect(screen.getByRole("link", { name: /Google Play/u })).toHaveAttribute(
      "href",
      "https://play.google.com/store/apps/details?id=com.linkdish.app"
    );
  });
});

import { act, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markClerkBridgeFailed, resetClerkBridgeForTests } from "../auth/clerk-bridge";

import { SsoCallbackPage } from "./SsoCallbackPage";

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/sso-callback"]}>
      <Routes>
        <Route element={<SsoCallbackPage />} path="/sso-callback" />
        <Route element={<p>Account page</p>} path="/account" />
      </Routes>
    </MemoryRouter>
  );

describe("SsoCallbackPage", () => {
  beforeEach(() => {
    resetClerkBridgeForTests();
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_sso");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetClerkBridgeForTests();
  });

  it("shows progress while Clerk finishes the redirect", () => {
    renderPage();

    expect(screen.getByRole("status")).toHaveTextContent("Signing you in…");
  });

  it("offers a way back when Clerk can't load", () => {
    renderPage();

    act(() => {
      markClerkBridgeFailed();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in didn't finish");
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/account"
    );
  });

  it("sends builds without Clerk to the account page", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    renderPage();

    expect(screen.getByText("Account page")).toBeInTheDocument();
  });
});

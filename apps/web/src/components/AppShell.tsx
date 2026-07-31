import React, { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

import { FirstRunOnboardingSheet } from "../features/onboarding/FirstRunOnboardingSheet";
import { SAVE_FEEDBACK_EVENT } from "../lib/delight-events";

import { Icon } from "./Icon";
import "./AppShell.css";

interface AppShellProps {
  children?: React.ReactNode;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const AppShell: React.FC<AppShellProps> = ({ children }) => {
  const [cookbookBounceActive, setCookbookBounceActive] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isCookbookDestination =
    location.pathname === "/" || location.pathname.startsWith("/recipes/");
  const isImportDestination = location.pathname === "/import";
  const isShoppingDestination = location.pathname === "/shopping";
  const isHouseholdDestination =
    location.pathname === "/account" || location.pathname === "/household";
  const isDestinationPage =
    location.pathname === "/" ||
    location.pathname === "/import" ||
    location.pathname === "/shopping" ||
    location.pathname === "/account";

  useEffect(() => {
    const handleSaveFeedback = () => {
      if (prefersReducedMotion()) {
        return;
      }

      setCookbookBounceActive(false);
      requestAnimationFrame(() => {
        setCookbookBounceActive(true);
      });
    };

    window.addEventListener(SAVE_FEEDBACK_EVENT, handleSaveFeedback);

    return () => {
      window.removeEventListener(SAVE_FEEDBACK_EVENT, handleSaveFeedback);
    };
  }, []);

  const handleBack = () => {
    if (window.history.length > 1) {
      void navigate(-1);
      return;
    }

    void navigate("/");
  };

  return (
    <div className="app-shell">
      <header
        className={`app-topbar ${isDestinationPage ? "app-topbar-destination" : ""}`}
        aria-label="App navigation"
      >
        {!isDestinationPage && (
          <button className="app-nav-btn" onClick={handleBack} aria-label="Go back">
            <Icon name="chevron-left" size={24} color="currentColor" />
          </button>
        )}

        <button
          className={`app-wordmark-btn ${isCookbookDestination ? "app-nav-btn-active" : ""} ${
            cookbookBounceActive ? "app-nav-btn-save-bounce" : ""
          }`}
          onClick={() => {
            void navigate("/");
          }}
          onAnimationEnd={() => setCookbookBounceActive(false)}
          aria-label="Go to Cookbook"
          aria-current={isCookbookDestination ? "page" : undefined}
        >
          LinkDish
        </button>

        <span className="app-topbar-spacer" aria-hidden="true" />

        <button
          className={`app-nav-btn ${isImportDestination ? "app-nav-btn-active" : ""}`}
          onClick={() => {
            void navigate("/import");
          }}
          aria-label="Add recipe"
          aria-current={isImportDestination ? "page" : undefined}
        >
          <Icon name="plus-circle-outline" size={22} color="currentColor" />
          <span className="app-nav-btn-label">Add</span>
        </button>

        <button
          className={`app-nav-btn ${isShoppingDestination ? "app-nav-btn-active" : ""}`}
          onClick={() => {
            void navigate("/shopping");
          }}
          aria-label="Shopping"
          aria-current={isShoppingDestination ? "page" : undefined}
        >
          <Icon name="cart-outline" size={22} color="currentColor" />
          <span className="app-nav-btn-label">Shopping</span>
        </button>

        <button
          className={`app-nav-btn ${isHouseholdDestination ? "app-nav-btn-active" : ""}`}
          onClick={() => {
            void navigate("/account");
          }}
          aria-label="Household and account"
          aria-current={isHouseholdDestination ? "page" : undefined}
        >
          <Icon name="account-group-outline" size={22} color="currentColor" />
          <span className="app-nav-btn-label">Household</span>
        </button>
      </header>

      <main className="app-shell-content">{children}</main>
      <FirstRunOnboardingSheet />
    </div>
  );
};

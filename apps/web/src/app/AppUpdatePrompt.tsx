import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

import { useToast } from "../components/Toast";
import {
  applyUpdate,
  shouldAutoApplyUpdate,
  startAppUpdates,
  useAppUpdate
} from "../platform/app-update";
import { whenBootSettled } from "../platform/boot-settle";

import type { FC } from "react";

/** The toast stays until acted on; an ignored update applies itself on a later navigation. */
const UPDATE_TOAST_DURATION_MS = 24 * 60 * 60_000;
export const APP_UPDATE_TOAST_ID = "app-update-ready";

/**
 * Registers the service worker once the first screen has settled, offers "Reload" when a new version is
 * waiting, and applies an ignored update on the next navigation.
 */
export const AppUpdatePrompt: FC = () => {
  const { needRefresh, applying } = useAppUpdate();
  const { showToast } = useToast();
  const location = useLocation();
  const lastKeyRef = useRef(location.key);

  // The service worker (and workbox-window) never compete with the first paint.
  useEffect(() => whenBootSettled(() => void startAppUpdates()), []);

  useEffect(() => {
    if (!needRefresh || applying) {
      return;
    }

    showToast({
      action: { label: "Reload", onClick: () => void applyUpdate() },
      duration: UPDATE_TOAST_DURATION_MS,
      icon: "sparkles",
      id: APP_UPDATE_TOAST_ID,
      message: "A fresh version of LinkDish is ready"
    });
  }, [applying, needRefresh, showToast]);

  useEffect(() => {
    if (location.key === lastKeyRef.current) {
      return;
    }

    lastKeyRef.current = location.key;

    // Moving to another page anyway: a good moment for the reload the prompt asked for.
    if (shouldAutoApplyUpdate()) {
      void applyUpdate();
    }
  }, [location.key]);

  return null;
};

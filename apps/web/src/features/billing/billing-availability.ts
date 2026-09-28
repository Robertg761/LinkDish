import { useCallback, useEffect, useState } from "react";

import { apiClient } from "../../api/client";

import type { WebBillingAvailability } from "@linkdish/api-contracts";

/**
 * Prices and checkout availability for the web. The defaults match the API's own defaults, so the
 * page can render real prices before (or without) the request; checkout stays off until the API
 * says it is available.
 */
export const DEFAULT_WEB_BILLING_AVAILABILITY: WebBillingAvailability = {
  managementPortalAvailable: false,
  plans: {
    family: {
      monthly: false,
      yearly: false
    },
    plus: {
      monthly: false,
      yearly: false
    }
  },
  prices: {
    family: {
      monthly: "$4.99/month",
      yearly: "$44.99/year"
    },
    plus: {
      monthly: "$2.99/month",
      yearly: "$24.99/year"
    }
  },
  webCheckoutEnabled: false
};

export type BillingAvailabilityStatus = "loading" | "ready" | "error";

const CACHE_TTL_MS = 60_000;

let cached: { availability: WebBillingAvailability; loadedAt: number } | null = null;
let inflight: Promise<WebBillingAvailability> | null = null;

/** Loads availability once and shares it (the pricing page and upgrade sheet ask together). */
export const loadWebBillingAvailability = (
  options: { force?: boolean } = {}
): Promise<WebBillingAvailability> => {
  if (!options.force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return Promise.resolve(cached.availability);
  }

  if (!options.force && inflight) {
    return inflight;
  }

  const request = apiClient.getWebBillingAvailability().then((availability) => {
    cached = { availability, loadedAt: Date.now() };
    return availability;
  });
  const settle = () => {
    if (inflight === request) {
      inflight = null;
    }
  };
  inflight = request;
  void request.then(settle, settle);

  return request;
};

export interface WebBillingAvailabilityView {
  availability: WebBillingAvailability;
  status: BillingAvailabilityStatus;
  retry: () => void;
}

export function useWebBillingAvailability(): WebBillingAvailabilityView {
  const [state, setState] = useState<{
    availability: WebBillingAvailability;
    status: BillingAvailabilityStatus;
  }>(() =>
    cached
      ? { availability: cached.availability, status: "ready" }
      : { availability: DEFAULT_WEB_BILLING_AVAILABILITY, status: "loading" }
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    loadWebBillingAvailability({ force: attempt > 0 }).then(
      (availability) => {
        if (!cancelled) {
          setState({ availability, status: "ready" });
        }
      },
      () => {
        if (!cancelled) {
          setState((current) => ({ availability: current.availability, status: "error" }));
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState((current) => ({ ...current, status: "loading" }));
    setAttempt((value) => value + 1);
  }, []);

  return { ...state, retry };
}

/** Test seam. */
export function resetWebBillingAvailabilityForTests(): void {
  cached = null;
  inflight = null;
}

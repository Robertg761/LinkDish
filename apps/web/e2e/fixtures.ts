import { test as base, expect } from "@playwright/test";

import { E2E_API_ORIGIN } from "./api-origin";

import type { AuthConfigResponse } from "@linkdish/api-contracts";
import type { Page, Request, Route } from "@playwright/test";

export { expect };

export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

interface MockResponse {
  status?: number;
  json: unknown;
}

type ApiHandler = (call: ApiCall) => MockResponse;

/** What the API says to a signed-out visitor: Clerk off, so no sign-in script loads. */
const SIGNED_OUT_AUTH_CONFIG: AuthConfigResponse = {
  authMode: "clerk_primary",
  clerkEnabled: false,
  emailCodeEnabled: false
};

/**
 * Stands in for the LinkDish API. Every request to the E2E API origin is recorded and answered
 * by the handler registered for its method and path, or with a 404 (the app treats those as a
 * server without the feature, as it would for a signed-out visitor).
 */
export class ApiMock {
  readonly calls: ApiCall[] = [];
  private readonly handlers = new Map<string, ApiHandler>();

  constructor() {
    this.on("GET", "/auth/config", () => ({ json: SIGNED_OUT_AUTH_CONFIG }));
    this.on("POST", "/analytics/events", (call) => ({
      json: { accepted: (call.body as { events?: unknown[] } | null)?.events?.length ?? 0 }
    }));
  }

  /** Answers `method path` (path without the query string) with `handler`, replacing any other. */
  on(method: string, path: string, handler: ApiHandler): void {
    this.handlers.set(`${method} ${path}`, handler);
  }

  callsTo(method: string, path: string): ApiCall[] {
    return this.calls.filter((call) => call.method === method && call.path === path);
  }

  async handle(route: Route, request: Request): Promise<void> {
    const url = new URL(request.url());
    const call: ApiCall = {
      method: request.method(),
      path: url.pathname,
      body: parseBody(request)
    };
    this.calls.push(call);

    const handler = this.handlers.get(`${call.method} ${call.path}`);
    const response = handler ? handler(call) : { status: 404, json: { error: "not_found" } };

    await route.fulfill({
      status: response.status ?? 200,
      json: response.json,
      headers: { "access-control-allow-origin": "*" }
    });
  }
}

const parseBody = (request: Request): unknown => {
  const raw = request.postData();

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

interface Fixtures {
  api: ApiMock;
  /** Whether the first-run sheet counts as seen (default true, so it doesn't cover each page). */
  onboardingSeen: boolean;
}

export const test = base.extend<Fixtures>({
  onboardingSeen: [true, { option: true }],

  // Automatic: no test may run with the network open, whether or not it uses `api`.
  api: [
    async ({ context, baseURL }, use) => {
      const api = new ApiMock();
      const appOrigin = new URL(baseURL!).origin;

      // Hermetic: the app's own files are served, the API is mocked, anything else is refused.
      await context.route("**/*", async (route, request) => {
        const { origin } = new URL(request.url());

        if (origin === appOrigin) {
          await route.fallback();
        } else if (origin === E2E_API_ORIGIN) {
          await api.handle(route, request);
        } else {
          await route.abort("blockedbyclient");
        }
      });

      await use(api);
    },
    { auto: true }
  ],

  page: async ({ page, onboardingSeen }, use) => {
    if (onboardingSeen) {
      await page.addInitScript(() => {
        window.localStorage.setItem("linkdish:web:first-run-onboarding-seen:v1", "true");
      });
    }

    const uncaught: string[] = [];
    page.on("pageerror", (error) => uncaught.push(error.stack ?? error.message));

    await use(page);

    expect(uncaught, "uncaught errors in the page").toEqual([]);
  }
});

/** The app's toasts (a polite live region; the offline banner is a status region too). */
export const toasts = (page: Page) => page.locator(".toast-region");

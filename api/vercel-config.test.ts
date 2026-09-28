import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface Route {
  src?: string;
  dest?: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  handle?: string;
}

interface VercelConfig {
  routes?: Route[];
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  rewrites?: Array<{ source: string; destination: string }>;
}

const webConfig = JSON.parse(
  readFileSync(new URL("../apps/web/vercel.json", import.meta.url), "utf8")
) as VercelConfig;

/* `headers` and `rewrites` are sugar for routes: headers run before the filesystem, rewrites after. */
const toRoutes = (config: VercelConfig): Route[] =>
  config.routes ?? [
    ...(config.headers ?? []).map((rule) => ({
      src: rule.source,
      headers: Object.fromEntries(rule.headers.map((header) => [header.key, header.value])),
      continue: true
    })),
    { handle: "filesystem" },
    ...(config.rewrites ?? []).map((rule) => ({ src: rule.source, dest: rule.destination }))
  ];

const phaseRoutes = (routes: Route[], handle: string | null): Route[] => {
  const start = handle === null ? 0 : routes.findIndex((route) => route.handle === handle) + 1;

  if (handle !== null && start === 0) {
    return [];
  }

  const rest = routes.slice(start);
  const end = rest.findIndex((route) => route.handle);
  return end === -1 ? rest : rest.slice(0, end);
};

const matches = (route: Route, path: string): boolean =>
  route.src !== undefined && new RegExp(`^${route.src}$`, "u").test(path);

/* What the web deployment contains, from a real build: hashed chunks and stable-named files. */
const deployedFiles = new Set([
  "/index.html",
  "/sw.js",
  "/manifest.webmanifest",
  "/favicon.ico",
  "/workbox-948e45c5.js",
  "/assets/AccountPage-BJWiRY3W.js",
  "/assets/FirstRunOnboardingDialog-Dln-yQn-.css",
  "/fonts/Fraunces-Bold.woff2",
  "/icons/icon-192.png"
]);

/*
 * A model of Vercel's routing phases, as `vercel dev` implements them: routes before
 * `handle: filesystem` run first and their headers stay on whatever response follows, a 404
 * included. When the path is not a file, the routes after `filesystem` may rewrite it. Once a
 * file is found, `handle: hit` routes add headers without overriding earlier ones. `hitPath`
 * chooses whether hit routes see the rewritten path (vercel dev) or the requested one, so the
 * config is checked under both readings.
 */
const serve = (config: VercelConfig, requestPath: string, hitPath: "rewritten" | "requested") => {
  const routes = toRoutes(config);
  const headers: Record<string, string> = {};
  const applyHeaders = (route: Route, override: boolean) => {
    for (const [name, value] of Object.entries(route.headers ?? {})) {
      const key = name.toLowerCase();

      if (override || !(key in headers)) {
        headers[key] = value;
      }
    }
  };
  const runPhase = (phase: Route[], path: string): string => {
    for (const route of phase) {
      if (!matches(route, path)) {
        continue;
      }

      applyHeaders(route, true);

      if (route.dest) {
        return route.dest;
      }

      if (!route.continue) {
        break;
      }
    }

    return path;
  };
  const toFile = (path: string) => (path === "/" ? "/index.html" : path);

  let path = runPhase(phaseRoutes(routes, null), requestPath);

  if (!deployedFiles.has(toFile(path))) {
    path = runPhase(phaseRoutes(routes, "filesystem"), path);
  }

  if (!deployedFiles.has(toFile(path))) {
    return { status: 404, file: null, headers };
  }

  for (const route of phaseRoutes(routes, "hit")) {
    if (matches(route, hitPath === "rewritten" ? path : requestPath)) {
      applyHeaders(route, false);
    }
  }

  return { status: 200, file: toFile(path), headers };
};

const immutable = /immutable/u;

describe("apps/web/vercel.json caching", () => {
  it("only sets a long immutable cache once the filesystem has found the file", () => {
    const routes = toRoutes(webConfig);
    const beforeFilesystemCheck = [
      ...phaseRoutes(routes, null),
      ...phaseRoutes(routes, "filesystem")
    ];

    for (const route of beforeFilesystemCheck) {
      expect(Object.values(route.headers ?? {}).join(" ")).not.toMatch(immutable);
    }

    /* Vercel only accepts header-only routes after `handle: hit`. */
    for (const route of phaseRoutes(routes, "hit")) {
      expect(route).toMatchObject({ continue: true });
      expect(route.dest).toBeUndefined();
      expect(route.status).toBeUndefined();
    }
  });

  describe.each(["rewritten", "requested"] as const)("hit routes see the %s path", (hitPath) => {
    it("caches hashed build output for a year", () => {
      for (const path of [
        "/assets/AccountPage-BJWiRY3W.js",
        "/assets/FirstRunOnboardingDialog-Dln-yQn-.css",
        "/workbox-948e45c5.js"
      ]) {
        const response = serve(webConfig, path, hitPath);

        expect(response).toMatchObject({ status: 200, file: path });
        expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      }
    });

    it("answers a chunk from another deployment with a 404 that no browser keeps", () => {
      const response = serve(webConfig, "/assets/RecipePage-0ldHa5h1.js", hitPath);

      expect(response.file).not.toBe("/index.html");
      expect(response.status).toBe(404);
      expect(response.headers["cache-control"] ?? "").not.toMatch(immutable);
    });

    it("never caches the app shell, including every deep link that falls back to it", () => {
      for (const path of ["/", "/index.html", "/recipes/abc123", "/import", "/featured/pasta"]) {
        const response = serve(webConfig, path, hitPath);

        expect(response).toMatchObject({ status: 200, file: "/index.html" });
        expect(response.headers["cache-control"]).toBe("no-cache");
      }

      expect(serve(webConfig, "/sw.js", hitPath).headers["cache-control"]).toBe("no-cache");
    });

    it("does not pin stable-named files such as the fonts for a year", () => {
      const font = serve(webConfig, "/fonts/Fraunces-Bold.woff2", hitPath);

      expect(font.status).toBe(200);
      expect(font.headers["cache-control"] ?? "").not.toMatch(immutable);
      expect(serve(webConfig, "/fonts/Missing.woff2", hitPath).status).toBe(404);
    });

    it("keeps the security headers on every response", () => {
      for (const path of ["/", "/recipes/abc123", "/assets/AccountPage-BJWiRY3W.js"]) {
        const { headers } = serve(webConfig, path, hitPath);

        expect(headers["content-security-policy"]).toContain(
          "'sha256-Gx75g3P/94t2dubzu/zEVZUhlNzdIAiLifLVj8l4WJA='"
        );
        expect(headers["x-frame-options"]).toBe("DENY");
        expect(headers["strict-transport-security"]).toContain("max-age=63072000");
      }
    });
  });
});

describe("vercel.json app hosts", () => {
  interface HeaderRule {
    source: string;
    has?: Array<{ type: string; value: string }>;
    headers: Array<{ key: string; value: string }>;
  }

  const rootConfig = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
  ) as {
    headers?: HeaderRule[];
  };
  const cspOf = (rule: { headers: Array<{ key: string; value: string }> } | undefined) =>
    rule?.headers.find((header) => header.key.toLowerCase() === "content-security-policy")?.value;

  it("serves the app hosts the same CSP as the web app, theme bootstrap hash included", () => {
    const appHostRule = rootConfig.headers?.find((rule) =>
      rule.has?.some((condition) => condition.type === "host" && condition.value.includes("app"))
    );
    const webCsp = toRoutes(webConfig)
      .map((route) =>
        Object.entries(route.headers ?? {}).find(
          ([key]) => key.toLowerCase() === "content-security-policy"
        )
      )
      .find(Boolean)?.[1];

    expect(cspOf(appHostRule)).toBeDefined();
    // One policy for the app, whichever config serves it, so an inline-script hash can't drift.
    expect(webCsp).toBeDefined();
    expect(cspOf(appHostRule)).toBe(webCsp);
    expect(cspOf(appHostRule)).toContain("'sha256-Gx75g3P/94t2dubzu/zEVZUhlNzdIAiLifLVj8l4WJA='");
  });
});

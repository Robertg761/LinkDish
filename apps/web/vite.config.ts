import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

import type { HtmlTagDescriptor, Plugin, Rollup } from "vite";

type ManualChunkMeta = Parameters<Rollup.GetManualChunk>[1];
type OutputChunk = Rollup.OutputChunk;

/** Brand canvas (#fbf7f0): splash background and browser chrome for the installed app. */
const BRAND_CANVAS = "#f4efe7";

/**
 * The entry chunk holds only the app shell; every page is its own chunk. Most visits start on
 * the Cookbook (/), so its chunk, the chunks it imports and its stylesheet are preloaded from
 * index.html and download alongside the entry instead of after it. (main.tsx also imports the
 * landing route's chunk before React renders, for every route.)
 */
const preloadLandingRoute = (routeModule: string): Plugin => ({
  name: "linkdish:preload-landing-route",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler(_html, context) {
      const bundle: Rollup.OutputBundle | undefined = context.bundle;
      const entry = context.chunk;

      if (!bundle || !entry) {
        return [];
      }

      const chunks = new Map(
        Object.values(bundle)
          .filter((output): output is OutputChunk => output.type === "chunk")
          .map((chunk) => [chunk.fileName, chunk])
      );
      // The chunk that holds the route module (Vite's import-analysis leaves it without a facade).
      const route = [...chunks.values()].find((chunk) =>
        chunk.moduleIds.some((id) => id.replaceAll("\\", "/").endsWith(routeModule))
      );

      if (!route) {
        throw new Error(`preloadLandingRoute: no chunk contains ${routeModule}`);
      }

      // Everything the entry already loads (statically) needs no extra hint.
      const loadedWithEntry = new Set<string>();
      const markEntryGraph = (fileName: string) => {
        if (loadedWithEntry.has(fileName)) {
          return;
        }

        loadedWithEntry.add(fileName);
        chunks.get(fileName)?.imports.forEach(markEntryGraph);
      };
      markEntryGraph(entry.fileName);

      const scripts: string[] = [];
      const styles = new Set<string>();
      const seen = new Set<string>();
      const visit = (fileName: string) => {
        const chunk = chunks.get(fileName);

        if (!chunk || seen.has(fileName) || loadedWithEntry.has(fileName)) {
          return;
        }

        seen.add(fileName);
        scripts.push(fileName);
        chunk.viteMetadata?.importedCss.forEach((css) => styles.add(css));
        chunk.imports.forEach(visit);
      };
      visit(route.fileName);

      const tags: HtmlTagDescriptor[] = [
        ...scripts.map(
          (fileName): HtmlTagDescriptor => ({
            attrs: {
              crossorigin: "",
              fetchpriority: "low",
              href: `/${fileName}`,
              rel: "modulepreload"
            },
            injectTo: "head",
            tag: "link"
          })
        ),
        ...[...styles].map(
          (fileName): HtmlTagDescriptor => ({
            attrs: {
              as: "style",
              crossorigin: "",
              fetchpriority: "low",
              href: `/${fileName}`,
              rel: "preload"
            },
            injectTo: "head",
            tag: "link"
          })
        )
      ];

      return tags;
    }
  }
});

/** Shared building blocks of the pages: components, stores, storage and helpers. */
const APP_SHARED_PATTERN =
  /\/apps\/web\/src\/(?:components|data|storage|api|platform|preferences)\/|\/apps\/web\/src\/features\/library\/saved-recipe-(?:store|types)\.ts$|\/node_modules\/idb\//u;
/** The small, zod-free recipe-domain formatters the Cookbook uses (and the recipe pages share). */
const DOMAIN_CORE_PATTERN =
  /\/packages\/recipe-domain\/src\/(?:durations|urls|servings|number-format|number-phrases)\.ts$/u;
/**
 * The unit tables and noun inflection behind ingredient amounts: the recipe pages, cook mode and
 * the lists need them, the Cookbook doesn't, so they are grouped apart from `domain-core`.
 */
const DOMAIN_FORMAT_PATTERN =
  /\/packages\/recipe-domain\/src\/(?:quantity-format|inflection|units|format-internal)\.ts$/u;

/**
 * Without this, every shared component or store a page imports becomes its own tiny chunk (and
 * stylesheet): the Cookbook alone needed 20 scripts and 10 stylesheets. Shared page code is
 * grouped instead: what the landing page (the Cookbook) and the boot-time lazy UI use goes in
 * `app-core`, the rest of the shared building blocks in `app-shared`, and the small domain
 * formatters in `domain-core`. Modules the entry loads stay in the entry, and modules only ever
 * imported lazily (pages, sheets) keep their own chunks.
 */
const createManualChunks = (bootModules: readonly string[]): Rollup.GetManualChunk => {
  let entryGraph: Set<string> | null = null;
  let landingGraph: Set<string> | null = null;

  const collectStaticGraph = (meta: ManualChunkMeta, roots: string[]): Set<string> => {
    const graph = new Set<string>();
    const visit = (id: string) => {
      if (graph.has(id)) {
        return;
      }

      graph.add(id);
      meta.getModuleInfo(id)?.importedIds.forEach(visit);
    };

    roots.forEach(visit);
    return graph;
  };

  const sharedChunkFor = (id: string, meta: ManualChunkMeta): string | undefined => {
    const path = id.replaceAll("\\", "/");
    const info = meta.getModuleInfo(id);

    // Entry code stays in the entry; modules only ever imported lazily keep their own chunks.
    if (entryGraph?.has(id) || !info || info.importers.length === 0) {
      return undefined;
    }

    if (path.endsWith(".css")) {
      // A stylesheet follows its component, so a page's own CSS never lands in a shared chunk.
      const owners = new Set(info.importers.map((importer) => sharedChunkFor(importer, meta)));
      return owners.size === 1 ? [...owners][0] : undefined;
    }

    if (APP_SHARED_PATTERN.test(path)) {
      return landingGraph?.has(id) ? "app-core" : "app-shared";
    }

    if (DOMAIN_CORE_PATTERN.test(path)) {
      return "domain-core";
    }

    return DOMAIN_FORMAT_PATTERN.test(path) ? "domain-format" : undefined;
  };

  return (id, meta) => {
    if (!entryGraph || !landingGraph) {
      const moduleIds = [...meta.getModuleIds()];
      entryGraph = collectStaticGraph(
        meta,
        moduleIds.filter((moduleId) => meta.getModuleInfo(moduleId)?.isEntry)
      );
      landingGraph = collectStaticGraph(
        meta,
        moduleIds.filter((moduleId) =>
          bootModules.some((bootModule) => moduleId.replaceAll("\\", "/").endsWith(bootModule))
        )
      );
    }

    // Named explicitly: Rollup moves a manual chunk's dependencies into it unless they belong to
    // another manual chunk, which would otherwise drag shell code (React, the router) along.
    if (entryGraph.has(id)) {
      return "index";
    }

    return sharedChunkFor(id, meta);
  };
};

/** The page most visits start on; see preloadLandingRoute and app/routes.ts. */
const LANDING_ROUTE_MODULE = "/src/features/library/LibraryPage.tsx";
/**
 * Lazy UI the shell loads on every visit (the kitchen timer dock, the import queue count on Add),
 * grouped with the landing page.
 */
const BOOT_LAZY_MODULES = [
  "/src/features/cook-mode/TimerDock.tsx",
  "/src/components/ImportQueueCount.tsx"
];

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: createManualChunks([LANDING_ROUTE_MODULE, ...BOOT_LAZY_MODULES])
      }
    }
  },
  server: {
    host: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, "")
      }
    }
  },
  plugins: [
    react(),
    preloadLandingRoute(LANDING_ROUTE_MODULE),
    VitePWA({
      // A new version waits until the reader says "Reload" (or navigates after ignoring the
      // prompt), instead of swapping code under an open page. The app registers the worker
      // itself (platform/app-update.ts via virtual:pwa-register) once the page is idle.
      registerType: "prompt",
      injectRegister: false,
      // The plugin generates /manifest.webmanifest (there is no hand-written copy in public/).
      manifest: {
        name: "LinkDish",
        short_name: "LinkDish",
        description:
          "Paste a link. Get cooking. Save recipes from any site, cook step by step, plan the week and shop.",
        start_url: "/?source=pwa",
        scope: "/",
        lang: "en",
        dir: "ltr",
        display: "standalone",
        display_override: ["standalone", "minimal-ui", "browser"],
        background_color: BRAND_CANVAS,
        theme_color: BRAND_CANVAS,
        orientation: "portrait-primary",
        categories: ["food", "lifestyle"],
        share_target: {
          action: "/import",
          method: "GET",
          params: {
            text: "text",
            url: "url"
          }
        },
        shortcuts: [
          {
            name: "Add recipe",
            short_name: "Add",
            description: "Paste a link or recipe text",
            url: "/import"
          },
          {
            name: "Shopping list",
            short_name: "Shopping",
            url: "/shopping"
          },
          {
            name: "This week",
            short_name: "Plan",
            description: "Your meal plan",
            url: "/plan"
          },
          {
            name: "Cookbook",
            short_name: "Cookbook",
            url: "/"
          }
        ],
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "/icons/maskable-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable"
          },
          {
            src: "/icons/maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff2}"],
        // The RevenueCat checkout SDK is only needed after a signed-in user starts
        // a purchase. Keeping the large lazy chunk out of the install-time precache
        // preserves a small, reliable offline shell without downloading billing code
        // for every visitor.
        globIgnores: ["**/Purchases.es-*.js"],
        navigateFallback: "/index.html",
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              (url.pathname === "/image" || url.pathname === "/api/image") &&
              (url.origin === self.location.origin ||
                url.hostname === "api.linkdish.ca" ||
                url.hostname === "linkdish-api.vercel.app"),
            handler: "CacheFirst",
            options: {
              // v2: only readable (CORS) responses. The v1 cache held opaque ones, which Chrome
              // pads to ~7 MB each in the storage quota (a full cache "used" 1.4 GB).
              cacheName: "recipe-images-v2",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30
              },
              cacheableResponse: {
                statuses: [200]
              },
              plugins: [
                {
                  // Once per worker: drop the old cache of opaque responses.
                  handlerWillStart: async () => {
                    const scope = globalThis as unknown as Record<string, unknown>;

                    if (!scope.linkdishDroppedOpaqueImages) {
                      scope.linkdishDroppedOpaqueImages = true;
                      await caches.delete("recipe-image-proxy");
                    }
                  },
                  // <img> requests are no-cors; ask the proxy (which sends CORS headers for the
                  // app's origins) in cors mode, so the cached copy is a readable 200.
                  requestWillFetch: ({ request }: { request: Request }) =>
                    Promise.resolve(
                      request.mode === "no-cors"
                        ? new Request(request.url, { credentials: "omit", mode: "cors" })
                        : request
                    ),
                  // An origin the proxy doesn't allow (a preview deploy): still show the image,
                  // just don't cache it.
                  handlerDidError: async ({ request }: { request: Request }) =>
                    fetch(request.url, { credentials: "omit", mode: "no-cors" })
                }
              ]
            }
          },
          {
            urlPattern: /^https:\/\/api\.linkdish\.ca\/.*$/,
            handler: "NetworkOnly"
          },
          {
            urlPattern: /^https:\/\/linkdish-api\.vercel\.app\/.*$/,
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ]
});

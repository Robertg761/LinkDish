import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/** Brand canvas (#fbf7f0): splash background and browser chrome for the installed app. */
const BRAND_CANVAS = "#fbf7f0";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true
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
    VitePWA({
      registerType: "autoUpdate",
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
              cacheName: "recipe-image-proxy",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 60 * 60 * 24 * 30
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
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

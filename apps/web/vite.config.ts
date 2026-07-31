import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

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
      manifest: {
        name: "LinkDish",
        short_name: "LinkDish",
        description: "Turn recipe links into clean ingredients and steps.",
        start_url: "/?source=pwa",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui", "browser"],
        background_color: "#fff7ed",
        theme_color: "#fff7ed",
        orientation: "portrait-primary",
        share_target: {
          action: "/import",
          method: "GET",
          params: {
            text: "text",
            url: "url"
          }
        },
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png"
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
          },
          {
            urlPattern:
              /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mdi\/font@7\.4\.47\/(?:css\/materialdesignicons\.min\.css|fonts\/.*)$/i,
            handler: "CacheFirst",
            options: {
              cacheName: "mdi-font-assets",
              expiration: {
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    })
  ]
});

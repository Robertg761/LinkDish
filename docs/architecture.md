# Architecture Notes

## Public Site

- `site/` contains the static marketing, support, privacy, invite, and search
  landing pages for `linkdish.ca`.
- The site has no build step. GitHub Pages publishes only `site/` through the
  dedicated deployment workflow.
- The support form and first-party analytics call the API in this repository,
  so their browser payloads and backend contracts must change together.
- `pnpm check:site` validates local references, metadata, sitemap coverage,
  social artwork, and the support form contract.

## Web App

`apps/web` is a React 19 + Vite PWA served from its own Vercel project
(`app.linkdish.ca`).

- **Design system.** Semantic CSS custom properties in
  `src/styles/tokens.css` for light and dark themes (System/Light/Dark
  preference, applied before first paint by an inline script whose CSP hash is
  pinned in `preferences/theme-boot-script.test.ts`, `apps/web/vercel.json` and
  the root `vercel.json`). Feature CSS uses only tokens. Icons are vendored
  Lucide SVG data behind a typed `<Icon name>` (no icon font or CDN). Shared
  components live in `src/components` (Sheet, Menu, Toast, RecipeCard,
  RecipeImage, SegmentedControl, Stepper, EmptyState and others).
- **Shell.** Phones get a bottom tab bar (Cookbook, Plan, Add, Shopping, You),
  hidden on recipe and featured pages; from 1024px the same navigation is a
  side rail. Route metadata (`components/app-route-meta.ts`) drives titles,
  the back button and the tab bar. A ⌘K command palette, keyboard shortcuts,
  an offline banner, route announcements and an app-update toast
  (`vite-plugin-pwa` in prompt mode) live at shell level.
- **Loading.** Every route is its own chunk (`lazyWithRetry`, self-healing
  after deploys). The Cookbook chunk is modulepreloaded from `index.html`, and
  Clerk loads through a lazy sibling bridge (`auth/ClerkBridge.tsx`) only when a
  Clerk session hint exists or sign-in starts. `pnpm --filter @linkdish/web
size` checks the budgets after a build (entry ≤ 115 KB gzip, landing JS ≤
  150 KB, landing CSS ≤ 24 KB).
- **Local data.** IndexedDB `linkdish-web` v4 (`storage/linkdish-db.ts`)
  holds `savedRecipes`, `recipeSourceImages` (scan images, kept out of list
  reads), `shoppingItems`, `collections`, `mealPlan`, `importQueue` and
  `cookSessions`. Upgrades are additive and run inside the versionchange
  transaction; a blocked or outdated tab surfaces a retry state instead of
  hanging. Reactive stores in `src/data` (`useSavedRecipes`, collections, meal
  plan, import queue, cook sessions) use `useSyncExternalStore`, optimistic
  writes with rollback, and a BroadcastChannel change feed across tabs.
  Personal metadata (favorites, tags, collections, ratings, cook log) stays on
  the device and is never part of the household sync payload.
- **Features.** Cookbook (ranked search, filters, collections, tags, shelves),
  recipe view (servings scaling, Original/US/Metric units, tap-to-check,
  editor), cook mode (resumable sessions, global timer dock, notifications
  through the service worker), importer (link, pasted text, photos downscaled
  on the device, cancellable progress, duplicate check, background queue),
  meal planner, aisle-grouped shopping list with household sync, backups and
  Paprika/Mela/JSON-LD import in Settings, pricing, household and account.
- **Analytics.** First-party events are queued and sent in batches (beacon on
  page hide). Event names are the closed enum in `packages/api-contracts`;
  the API drops unknown events individually, so deploy the API before clients
  that send new names.

## Mobile

- Expo Router drives navigation between the intake screen and a result preview screen.
- The mobile app talks to the backend through `@linkdish/api-client`.
- Mock mode lives in the mobile service layer so the UI can ship ahead of the extractor implementation.
- The result flow is a typed state machine: `success`, `needs_retry`, and `failure`.
- Retryable responses trigger an explicit fallback request instead of silently escalating to AI.
- The Cookbook renders with a FlatList; saved-recipes and shopping state are split into
  state and action contexts, and AsyncStorage writes go through a debounced writer that
  flushes when the app goes to the background.
- Search, shopping aggregation (aisle grouping, clean fractions), US/metric conversion and
  servings/time formatting come from `@linkdish/recipe-domain`, the same code the web uses.

## Backend

- `POST /extract` is the stable entry point for extraction.
- The canonical implementation of `POST /extract` lives in `services/extractor-api`, not in the root Vercel `api` folder.
- Shared zod schemas validate both requests and responses.
- The extractor pipeline is split into source detection, layered fetching, extraction, normalization, and confidence scoring to make future source-specific logic easy to add.
- Deterministic extraction is implemented separately for recipe webpages, articles, and YouTube.
- HTML fetching now prefers browser-like HTTP requests and can optionally escalate to Playwright browser rendering when a site is blocked or JS-heavy.
- Source detection now uses fetched HTML hints in addition to URL heuristics.
- Success responses include `fetchMode` and extraction provenance metadata.
- LLM fallback is behind a provider interface and is optional at runtime. The backend controls whether Gemini, OpenAI, or no provider is active.
- The root `api/extract.ts` Vercel handler is an adapter into the full extractor runtime. See [extractor-deployment.md](extractor-deployment.md) before changing production routing.

### Sources

Responses only ever use the `sourceType` values installed clients already accept
(`recipe-webpage`, `article`, `youtube`, `image`, `video`, `social`, `unknown`); new
platforms map onto them and are told apart internally by the detection `adapterKey`.

- **Recipe pages** are read from Recipe JSON-LD (top level, arrays, `@graph`,
  `mainEntity`), then microdata, then domain-adapter DOM selectors, then the Readability
  article heuristics. JSON-LD strings may carry markup: block tags become line breaks,
  other tags are dropped, entities decoded (`extractors/html-text.ts`). A string
  `recipeIngredient`/`recipeInstructions`, null entries or nested HowToSection/HowToStep
  shapes no longer throw (`extractors/recipe-webpage/json-ld.ts`). Structured lines are
  kept even when short ("Salt", "Toss."), and repeated ingredients are not de-duplicated.
- **Metadata**: description, `totalTimeMinutes` (ISO 8601 via recipe-domain
  `parseDuration`), author, `siteName` (`og:site_name`, then the page's WebSite or
  Organization), cuisine, category, keywords (split, trimmed, de-duplicated, at most 30)
  and `videoUrl` (VideoObject `contentUrl`/`embedUrl`, http(s) only). Microdata
  `totalTime` fills `totalTimeMinutes` only; it is never copied into prep or cook. WP
  Recipe Maker and Tasty Recipes ingredient groups become ingredient `section`s when the
  page's group sizes add up to the structured list. recipe-domain has no step sections,
  so HowToSection names are not kept on steps. The LLM fallback keeps any metadata the
  deterministic pass found.
- **Confidence**: a site's own Recipe JSON-LD/microdata with a title, at least two
  ingredients and a step is a success even without servings or times; the gap becomes a
  plain-language warning ("The source didn't list servings or cooking times."). A
  published total time stands in for prep/cook in scoring. Heuristic extractions keep the
  old penalties and still return `needs_retry` when weak.
- **Redirects**: a redirect only fails an import as "unrelated content" when it lands on
  another site (registrable domain, so apex↔www and subdomains are the same site), on the
  homepage for a deep link, on an unrelated path, or on a page whose title (or the
  readable text of a short page) says it moved or was not found. Scripts and i18n
  bundles are never scanned. Link shorteners (pin.it, bit.ly, t.co, tinyurl.com, ow.ly,
  buff.ly, lnkd.in, linktr.ee and a few more) may redirect anywhere.
- **YouTube**, including Shorts, embed and live links: always fetched through the
  canonical watch page. The description is the full `videoDetails.shortDescription` from
  the player response (og:description is truncated). The channel becomes `author`.
- **Pinterest** pins (and pin.it links that land on one): the pin's outbound link
  (`og:see_also`, else `"link"` in the pin's app state) is validated with the same SSRF
  checks and extracted instead. The recipe's `sourceUrl` is that page, and the result is
  cached under its URL, so a later direct import of the same recipe hits the cache.
- **TikTok**: the caption is read through the public oEmbed endpoint
  (`fetchers/fetch-tiktok-document.ts`; short links are resolved hop by hop, TikTok hosts
  only, each hop SSRF-validated, with the request deadline and a byte cap). A caption with
  recipe signals answers the primary attempt with `needs_retry`
  (`unsupported_primary_extraction`, `sourceType: social`), so the LLM only runs on the
  client's explicit fallback attempt and is billed like one. Captions without a recipe
  fail with `parse_failed` and no LLM call. Instagram and Facebook stay unsupported.

### Pasted text import

`POST /extract` also accepts `{ text, sourceUrl?, attempt?, correlationId? }` (20 to
20,000 characters; `extractRecipeTextRequestSchema`, client method
`extractRecipeFromText`). `ExtractRecipeRequest` keeps its URL/image shape; the server
parses `extractRecipeAnyRequestSchema`.

- Text always goes to the LLM extractor, so it is authorized and committed as a fallback
  attempt (imports and strong extractions) whatever `attempt` says. Usage is only
  committed for successes.
- Text without recipe signals (`extractors/recipe-text-signals.ts`) fails with
  `parse_failed` before any LLM call. Without an LLM provider it returns
  `fallback_unavailable`.
- Without a `sourceUrl`, the recipe gets a stable synthetic one,
  `https://linkdish.app/text-imports/<sha256 prefix of the text>`, so the same paste keeps
  the same saved-recipe id. `sourceType` is `unknown`, or derived from `sourceUrl`.
- Text imports never read or write the result cache and have no hand-off.

### Quota visibility

- Extract successes carry an optional `quota` (the existing `quotaStatusSchema`) with the
  allowance left after this import was counted: the allowance that runs out first when a
  fallback counts against both imports and strong extractions. It is absent when billing
  is disabled or for the live canary. It is attached after extraction, so it is never
  stored in the shared result cache (cache reads and writes also strip it).
- `GET /billing/usage` returns `{ billingEnabled, plan, quota }` for the caller, resolved
  exactly like an extraction (install id or signed-in account, plan, household) but
  read-only. It is rate limited per network (60/min) and sent with `no-store`.

### Analytics ingestion

- `POST /analytics/events` validates the envelope (1 to 25 events) and then each event on
  its own. Invalid events, including names this API does not know yet, are dropped and
  counted; the rest are written. The response is `{ accepted, dropped }` (`dropped` is an
  optional, additive field). Only a malformed envelope is a 400.
- Postgres stores `event_name` as free text, so new names need no migration.
- **Deploy order**: event names are a closed enum in `packages/api-contracts`. Deploy the
  API before shipping clients that send new names. Older APIs rejected whole batches with
  unknown names; the current one drops only those events, but they are still lost until
  the API knows them.

### `/extract` request path and performance

`api/extract.ts` and the Fastify route share `services/extract-request-pipeline.ts`:

1. IP rate limit (Upstash), then request parsing.
2. Billing authorization and extraction start together. URL validation (DNS), the
   result-cache lookup and the page fetch overlap the auth, household and RevenueCat
   lookups. If billing denies, the in-flight fetch is aborted and the `plan_limit`
   response is returned. Deterministic extraction, browser renders started after the
   fetch, LLM calls and cache writes all wait for billing's answer.
3. Usage is committed before responding, exactly as before, including for cache hits
   (a cache hit is still an import).
4. Durable Postgres analytics, cache writes and fallback hand-off writes run after the
   response through `@vercel/functions` `waitUntil` (fire-and-forget on Fastify). The
   in-process admin metrics are recorded by both adapters.

Performance pieces in `services/extractor-api/src/modules/extract`:

- **Result cache** (`cache/extraction-cache.ts`): a URL-keyed Upstash cache
  (`linkdish:extract-cache:v1:<EXTRACTOR_CACHE_VERSION>:<sha256(canonical URL)>`, where
  the canonical URL has tracking parameters, fragments, host case and trailing slashes
  normalised, and YouTube URLs use their watch URL). It holds only validated successes
  at or above the success confidence bar. It never stores needs_retry, failures, quota
  data or image scans, and never a page that redirected to another site. A hit skips
  fetch, parse and LLM calls and re-stamps the per-request `recipe.sourceUrl`. Bump
  `EXTRACTOR_CACHE_VERSION` whenever extraction output changes. `EXTRACT_CACHE_ENABLED`
  is the kill switch and `EXTRACT_CACHE_TTL_SECONDS` sets the lifetime (default 7 days).
  Live canary requests (`x-linkdish-canary`) skip cache reads. Responses carry
  `x-linkdish-cache: hit|miss|bypass`, and logs and analytics carry `cacheStatus`.
- **Fallback hand-off** (`cache/fallback-handoff.ts`): when a primary attempt with a
  `correlationId` returns needs_retry, it stores the LLM prompt summary, candidate,
  detection and fetch mode for 15 minutes, keyed by the correlation id and URL. The
  explicit fallback attempt uses that entry instead of re-fetching or re-rendering the
  page, and falls back to a fresh fetch when the entry is missing. For a Pinterest pin
  the entry also records the recipe page the pin resolved to (`sourceUrl`). TikTok
  captions and pasted text are not handed off (re-reading a caption is one small request).
- **One deadline** (`deadline.ts`): `EXTRACT_REQUEST_DEADLINE_MS` (default 50 s, under
  the 60 s `maxDuration`) sizes every step. The HTTP fetch retries at most once, only
  after connection errors, and not at all when Playwright can take over. The browser
  queue times out. Gemini attempts fit the remaining time. The OpenAI client has an
  explicit timeout and `maxRetries: 0`.
- **LLM text cleanup** runs only when `RECIPE_TEXT_CLEANUP_ENABLED` is on, the runtime
  provider is not `none`, and the text shows artifacts (`text-cleanup/needs-text-cleanup.ts`).
- **Parse once** (`html/parsed-html-document.ts`): each fetched page is parsed by cheerio
  once. Detection, page checks, extractors and image capture share that parse.
- **Cold start**: cheerio, the fetchers, Playwright, the OpenAI SDK, `pg` and JSDOM load
  on first use. The import of `api/extract.ts` dropped from about 375 ms to about 95 ms
  in a local benchmark.
- **Block signals**: anti-bot markers count when they appear in the page title. They
  also count in the readable text of pages that already look like a wall (401, 402, 403,
  429, 451 or 503, or almost no readable text), so Cloudflare or reCAPTCHA scripts on
  normal pages no longer force a browser render.
- **Entitlements** (`billing/revenuecat-entitlements.ts`): paid plans are cached in
  Upstash for 5 minutes. "free" is never cached. The RevenueCat webhook invalidates every
  user an event concerns. Household changes that require Family use fresh lookups.

## Authentication

- Clerk owns social sign-in proof; LinkDish owns the stable application user ID.
- The backend maps Clerk subjects to LinkDish users through provider-neutral external identity keys, so billing, households, quotas, shared recipes, and deletion continue to use LinkDish `user.id`.
- `AUTH_MODE` controls rollout behavior: `legacy_email_code`, `clerk_beta`, or `clerk_primary`.
- `GET /auth/config` lets mobile discover whether Clerk sign-in and email-code fallback should be visible without requiring a signed-in session.
- Google sign-in is supported through Clerk. Apple sign-in is intentionally hidden until an Apple Developer account and production Apple credentials exist.
- See [clerk-auth.md](clerk-auth.md) before changing auth routes, Clerk/Google dashboard configuration, mobile sign-in UI, account linking, or deletion behavior.

## Extraction Fallback Contract

Production extraction is expected to follow this ladder:

1. Browser-like HTTP fetch.
2. Playwright browser fetch for blocked, thin, or JavaScript-heavy pages when enabled.
3. Deterministic extraction and confidence scoring.
4. Explicit mobile retry with the configured Gemini/OpenAI fallback provider when deterministic extraction is incomplete. The retry reuses the page the primary attempt fetched (the hand-off) when it arrives with the same `correlationId` within 15 minutes.

Cached successes short-circuit this ladder. They are shared only when they cleared the success confidence bar for their source type, and they are billed like any other import.

Strong structured recipes (the site's own JSON-LD or microdata with a title, two or more ingredients and a step) stop at step 3 with a success even when servings or times are missing. TikTok captions always take step 4, because reading a caption needs the LLM.

If production `/extract` skips browser fetch or fallback retry, it is a deployment regression even when `/health` is green.

## Shared Packages

- Domain models and API contracts stay outside both apps to avoid drift.
- `@linkdish/recipe-domain` is the shared, pure recipe engine: ingredient parsing and
  scaling (mixed numbers, alternates, package sizes, noun agreement), quantity formatting,
  US↔metric conversion (with a density table for baking staples and oven temperatures),
  servings and duration parsing, shopping aggregation with aisle categories, ranked search,
  conservative auto-tagging, URL canonicalization and duplicate detection, meal-plan
  helpers, and interop (versioned LinkDish backups, Paprika/Mela/schema.org importers,
  text/Markdown/JSON-LD export). Zod schemas live in separate modules so screens that only
  need helpers don't load the schema library.
- `@linkdish/api-client` methods are async and always reject rather than throw. Every
  method takes an optional `{ signal }` that is combined with the client timeout (a caller
  abort rejects with the signal's reason). Failures are `ExtractorApiError`s with a
  `kind`: `network` (no response, status 0, original message kept), `timeout` (client
  timeout, status 0), `http` (non-2xx, `serverMessage` from `body.message`), `contract`
  (a 2xx that does not match the schema) or `validation` (bad input, nothing sent, zod
  issues in `details`). `message`, `statusCode` and `details` keep their old meaning.
- UI primitives are intentionally thin so the mobile app can own product styling while keeping presentation consistent.

## Quality Gates

- Fixture-backed unit and integration tests stay deterministic and run in CI.
- `pnpm validate` runs lint, every typecheck, all package tests, the Vercel handler tests
  and the site check. The web bundle budget (`pnpm --filter @linkdish/web size`) needs a
  build first, so it is not part of `validate`.
- The live canary manifest is intentionally separate from PR-blocking CI so real-world regressions can be measured without making the pipeline flaky.

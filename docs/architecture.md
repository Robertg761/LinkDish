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
- **HTTP caching** (`apps/web/vercel.json`, written as `routes` because only
  the `handle: hit` phase can tell a real file from a rewrite or a 404: headers
  set before the filesystem check stick to whatever response follows). Hashed
  `/assets/*-<hash>.js|css` and `/workbox-<hash>.js` get a one-year
  `immutable` cache, but only in the `hit` phase, so only files that exist.
  `/assets/`, `/fonts/`, `/icons/` and `/workbox-` are excluded from the SPA
  fallback: a chunk from another deployment is a plain 404, never `index.html`
  cached for a year under the chunk's URL. The self-hosted fonts keep stable
  names and are cached for a week. Everything else (the app shell and every
  deep link that falls back to it, `sw.js`, the manifest) is `no-cache`.
  `api/vercel-config.test.ts` models Vercel's routing phases and checks this.
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
- The result flow is a typed state machine: `success`, `needs_retry`, and `failure`. The
  server no longer sends `needs_retry` (links and text are read without an LLM), but
  installed clients keep handling it.
- The Cookbook renders with a FlatList; saved-recipes and shopping state are split into
  state and action contexts, and AsyncStorage writes go through a debounced writer that
  flushes when the app goes to the background.
- Search, shopping aggregation (aisle grouping, clean fractions), US/metric conversion and
  servings/time formatting come from `@linkdish/recipe-domain`, the same code the web uses.
- Tabs: Cookbook, Add, Plan, Shopping and Household. The Add tab imports a link, photos or
  pasted text; text (or shared text with no link) is held in memory under a route key
  (`https://linkdish.app/text-imports/android-<id>`, never sent) while `/recipe` extracts it
  with `extractRecipeFromText`.
- Collections and tags work as on the web. Collections are stored under
  `linkdish.collections.v1`; a recipe's tags and collection ids ride on the record as
  `libraryExtras` and sync with the cookbook. The Cookbook filters by favorites, collection and
  tag, and search matches tags and collection names.
- The meal planner (`src/features/meal-plan`) keeps the plan on the device under
  `linkdish.mealPlan.v1`, as the web keeps it local: a week view, meals from the cookbook or
  notes, and "Shop for the week", which scales each planned recipe to its servings and merges the
  lines with `mergeShoppingInputs`. Recipe pages have an "Add to meal plan" row.
- Backups (`src/features/backup`, on the Household screen) write and read the shared
  LinkDish backup format, including the web app's `linkdishWeb` extras (collection emoji and
  order, extraction details, meal-plan timestamps), so a backup moves between Android and the
  web either way. The file is saved through the share sheet and picked with expo-file-system's
  picker. Restoring only adds, with the web's rules: existing recipes (same id, or same link and
  title) are kept but join the backup's collections, new ones respect the free limit, starters
  come back outside it, and the cookbook is written at once.

## Backend

- `POST /extract` is the stable entry point for extraction.
- The canonical implementation of `POST /extract` lives in `services/extractor-api`, not in the root Vercel `api` folder.
- Shared zod schemas validate both requests and responses.
- The extractor pipeline is split into source detection, layered fetching, extraction, normalization, and confidence scoring to make future source-specific logic easy to add.
- Deterministic extraction is implemented separately for recipe webpages, articles, and YouTube.
- HTML fetching now prefers browser-like HTTP requests and can optionally escalate to Playwright browser rendering when a site is blocked or JS-heavy.
- Source detection now uses fetched HTML hints in addition to URL heuristics.
- Success responses include `fetchMode` and extraction provenance metadata.
- Links, YouTube videos, TikTok captions and pasted text are read by rules only, whatever
  `attempt` says. Photo scans are read by an LLM, behind a provider interface that is
  optional at runtime; the backend controls whether Gemini, OpenAI, or no provider is
  active. The one other LLM call is the video reader (below), the last resort for a TikTok
  or YouTube link with no written recipe.
- The root `api/extract.ts` Vercel handler is an adapter into the full extractor runtime. Production routing lives in the root `vercel.json`.

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
  so HowToSection names are not kept on steps.
- **Confidence**: a site's own Recipe JSON-LD/microdata with a title, at least two
  ingredients and a step is a success even without servings or times; the gap becomes a
  plain-language warning ("The source didn't list servings or cooking times."). A
  published total time stands in for prep/cook in scoring. A heuristic extraction below
  its source's bar fails with `parse_failed` and a message naming what was missing (for
  example "LinkDish couldn't find the method on that page.").
- **Redirects**: a redirect only fails an import as "unrelated content" when it lands on
  another site (registrable domain, so apex↔www and subdomains are the same site), on the
  homepage for a deep link, on an unrelated path, or on a page whose title (or the
  readable text of a short page) says it moved or was not found. Scripts and i18n
  bundles are never scanned. Link shorteners (pin.it, bit.ly, t.co, tinyurl.com, ow.ly,
  buff.ly, lnkd.in, linktr.ee and a few more) may redirect anywhere.
- **YouTube**, including Shorts, embed and live links: always fetched through the
  canonical watch page. The description is the full `videoDetails.shortDescription` from
  the player response (og:description is truncated). The channel becomes `author`. The
  recipe is read from the description with the text parser (below); a transcript is only
  used when it is itself laid out as a recipe and the description is not. Creators often
  post the written recipe as a comment instead ("recipe in the comments"), so the first
  page of comments is read too (`youtubei/v1/next` with the watch page's comment-section
  continuation, in parallel with the transcript), and the creator's own top-level
  comments (`isCreator`, up to three) are the next source; a comment's own title line
  ("Marry Me Chicken Gnocchi") wins over the video title. "Recipe in the comments"
  pointers are dropped from video titles. When the
  description has no method, or no recipe at all, up to two "full recipe" links in it
  (`findYouTubeRecipeLinks`: cue lines like "Full recipe:" first, social, shop and music
  hosts and home pages skipped) are fetched and extracted like any recipe page, with the
  video kept as `videoUrl`. A description with ingredients only is saved with the step
  "Follow the video for the method." when no linked page works. Otherwise the import fails
  with "That video's description and the creator's comments don't include a written
  recipe."
- **Pinterest** pins (and pin.it links that land on one): the pin's outbound link
  (`og:see_also`, else `"link"` in the pin's app state), when it is a valid recipe
  `sourceUrl` (http(s), at most 2048 characters), is validated with the same SSRF
  checks and extracted instead, through the same path a direct link to it takes: YouTube
  through the transcript path, TikTok through its caption, and other social or video
  sites are rejected as `unsupported_source` before anything is fetched. The recipe's
  `sourceUrl` is that page, and the result is cached under its URL, so a later direct
  import of the same recipe hits the cache.
- **TikTok**: the caption is read through the public oEmbed endpoint
  (`fetchers/fetch-tiktok-document.ts`; short links are resolved hop by hop, TikTok hosts
  only, each hop SSRF-validated, with the request deadline and a byte cap) and parsed by
  the text parser on the first attempt. An ingredients-only caption keeps the video step,
  as YouTube does. Captions without a recipe fail with `parse_failed`. Instagram and
  Facebook stay unsupported.
- **Video reader** (`extractors/video/`, behind `VIDEO_RECIPE_READER_ENABLED` and
  `GEMINI_API_KEY`): when a TikTok caption has no recipe or only the ingredients, or a
  YouTube video's description, creator comments and linked pages have none, Gemini
  (`VIDEO_RECIPE_MODEL`) watches the video. TikToks are downloaded from the embed page's
  MP4 (larger than 14 MB through the Files API, deleted after the read); YouTube is passed
  by URL, only for Shorts and videos of known length up to `VIDEO_RECIPE_MAX_SECONDS`.
  Every ingredient comes back with its evidence (words heard, text shown, a caption line),
  and `build-video-recipe-candidate.ts` drops an ingredient its quote doesn't name and an
  amount its quote doesn't state ("a tablespoon" needs one tablespoon, not "a teaspoon",
  "half a tablespoon" or "a few tablespoons"); the gaps become a warning. Results use the `llm-fallback` strategy and `llm`
  provenance, are metered as plain imports and are never cached. Reads need 15 s of
  request time left (10 s after a TikTok download) and are capped at
  `VIDEO_RECIPE_DAILY_READ_LIMIT` Gemini calls per UTC day, counted just before each call
  (one Upstash counter across instances, per instance without Upstash). Past the cap the
  outcome is `skipped_daily_limit`; when the counter can't be checked the read is skipped
  as `limit_unavailable`. Each read logs a
  `video_recipe_read` line, and the outcome is stored as `videoRead` in the extraction
  analytics `properties`.

### Pasted text import

`POST /extract` also accepts `{ text, sourceUrl?, attempt?, correlationId? }` (20 to
20,000 characters; `extractRecipeTextRequestSchema`, client method
`extractRecipeFromText`). `ExtractRecipeRequest` keeps its URL/image shape; the server
parses `extractRecipeAnyRequestSchema`.

- Text is read by `extractors/text/parse-recipe-text.ts`, a rule-based parser shared with
  TikTok captions and YouTube descriptions. It finds the title, servings and labelled
  times, then the ingredients and method under the text's own headings ("Ingredients",
  "Method", "For the sauce:"), splitting run-on captions and numbered steps; without
  headings it takes a run of measured ingredient lines followed by method lines. A
  numbered method with no ingredient list at all (three or more steps) has its
  ingredients read from the amounts the steps name ("add 12 ounces of bacon" →
  "12 ounces bacon") and from "season with A, B and C"; the recipe carries a note that
  the list was put together from its steps. Text is
  metered as a plain import (no strong extraction) whatever `attempt` says, and usage is
  only committed for successes.
- Text the parser can't split fails with `parse_failed`: text with recipe signals
  (`extractors/recipe-text-signals.ts`) is told to label its ingredients and steps, other
  text is told it doesn't look like a recipe.
- Without a `sourceUrl`, the recipe gets a stable synthetic one,
  `https://linkdish.app/text-imports/<sha256 prefix of the text>`, so the same paste keeps
  the same saved-recipe id. `sourceType` is `unknown`, or derived from `sourceUrl`.
- Text imports never read or write the result cache.

### Quota visibility

- Extract successes carry an optional `quota` (the existing `quotaStatusSchema`) with the
  allowance left after this import was counted: the allowance that runs out first when a
  photo scan counts against both imports and strong extractions. It is absent when billing
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

### Analytics storage

- The Postgres schema is versioned in
  `services/extractor-api/src/modules/analytics/analytics-migrations.ts`, tracked in
  `analytics_schema_migrations`. The API applies pending migrations on first use in each process
  (one transaction under an advisory lock, so concurrent cold starts apply each once); when the
  database is current that is a version read and no DDL. `pnpm --filter @linkdish/extractor-api
  analytics:migrate` applies them by hand. Never edit a shipped migration; add the next one.
  Migration 1 is the schema the API used to create on every cold start, still guarded by
  `if not exists`, so databases created that way adopt it.
- **Retention is off by default: analytics are kept indefinitely.** Vercel Cron calls
  `GET /admin/cron/analytics-retention` daily (root `vercel.json` `crons`; it is folded into
  `api/admin.ts` for the 12-function limit). It authenticates with `CRON_SECRET` only, not the
  dashboard token, and returns 503 until that is set. It deletes nothing unless a retention is
  set: with `ANALYTICS_RETENTION_DAYS`, raw rows (`analytics_events`, `extraction_analytics`,
  `error_analytics`) older than that are deleted in batches by `received_at`, because
  `occurred_at` is client-supplied; with `ANALYTICS_ROLLUP_RETENTION_DAYS`, rollups and store
  metrics older than that go. A run stops after about 40 seconds and the next one carries on.
  Setting either one is a permanent deletion of older rows, and the privacy pages should then
  state the period.
- **Account deletion** deletes every raw analytics row carrying the account's hashed id before
  anything else is removed, so an analytics database failure fails the deletion while it can
  still be retried. Rows recorded before sign-in carry only an anonymous id and expire with
  retention. Purge and account deletion run whenever `ANALYTICS_DATABASE_URL` is set, even with
  `ANALYTICS_ENABLED` off.
- **Deploy order**: event names are a closed enum in `packages/api-contracts`. Deploy the
  API before shipping clients that send new names. Older APIs rejected whole batches with
  unknown names; the current one drops only those events, but they are still lost until
  the API knows them.

### Personal library sync

A signed-in account's own cookbook (recipes with their notes, favorites, tags, collection
membership, rating, cook log and preferred servings, plus collections) is kept in the account so it
follows the account between devices. Household recipes and the household shopping list keep their
own routes. Scan photos, starter recipes, the meal plan and cook-mode sessions are not part of it.

- `GET /library/changes?since=<cursor>` returns the account's items written after the cursor
  ("0" for everything), oldest first, at most 100 items or about 2 MB per page, with the next
  `cursor` and `hasMore`. A cursor past anything the account has written (a lost or reset store)
  answers from the start with `reset: true`, so the device sends everything it holds again.
- `POST /library/changes` takes 1 to 25 changes. Each is a recipe, a collection or a tombstone
  (`deleted: true`, no payload) with the `updatedAt` of the device that changed it, and
  `baseUpdatedAt`: the cloud copy the device merged it with (null for an item it never saw). A
  change is stored when it is at least as new as the stored copy and was merged with that copy;
  otherwise the stored copy comes back in `newer` for the device to merge, so a device never
  overwrites a change it hasn't seen (two devices syncing at once, or clocks that disagree). Invalid changes and new items past the limits (5,000 recipes,
  200 collections; 120,000 characters per item) are `rejected` one by one and the rest are stored.
- Storage (`modules/library/library-service.ts`) is Upstash, per LinkDish user id:
  `linkdish:library:v1:item:<user>:<kind>:<id>` holds the newest copy and the revision it was
  written at, the `changes` sorted set scores each item by that revision (the feed a pull reads),
  a `rev` counter hands out revisions, and `live` sets count live items against the limits. Writes
  for one account run under a 30 s lock, so revisions commit in order and a pull never skips one.
  Tombstones are kept so devices that were offline for months still learn about deletions.
- `LIBRARY_SYNC_ENABLED` (off by default) switches the routes on; off, they answer 404 and clients
  keep working locally. In production the routes refuse to run without Upstash (503) rather than
  keep cookbooks in process memory. Deleting the account deletes every library key.
- On Vercel the routes are served by the `api/household` function (`/library/*` rewrites to
  `api/household?path=library/...`, see `api/_lib/library-routes.ts`): the Hobby plan allows 12
  functions per deployment, and `api/vercel-config.test.ts` keeps the count within it.

On a device, sync is one shared engine (`packages/recipe-domain/src/library-sync.ts`) driven by
each app:

- A device remembers, per item, a fingerprint of the copy the cloud last had (its "base"). An item
  whose local fingerprint differs from its base changed on the device; a pulled copy that differs
  changed elsewhere. Fields are fingerprinted in groups (content, notes, favorite, tags,
  collections, rating, cooking, servings, ...), so edits to different groups on two devices both
  survive; when both changed one group the device merging keeps its own, except tags, collection
  membership and the cook log, which combine. Apps keep their own write paths: nothing records
  changes as they happen, a run compares.
- A run pulls and merges every page, then pushes what still differs from its base (deletions as
  tombstones), stamping uploads later than the cloud copy they replace. A merged write is applied
  only while the item still is what it was merged with; an item that keeps changing meanwhile
  keeps the pulled change as `pending` for the next run and sends nothing over it. A change the API
  turns away is held (not sent again) until the item changes. `packages/api-client/src/
library-sync.ts` validates each change before sending, so one bad item never fails a batch.
- A device's cookbook is linked to one account: the first to sign in on it (merging the two). It
  keeps the cookbook when that account signs out. Another account that signs in doesn't sync it;
  it can replace it with its own cookbook. Deleting the account unlinks the device; its recipes
  stay. Starter recipes, scans and when a recipe was last opened stay on the device.
- Web (`apps/web/src/features/cloud-sync`): the link and bases live in the `librarySync` store
  (IndexedDB v5), so they change with the recipes they describe; runs are serialized across tabs
  with Web Locks and start after local changes (4 s), on focus, on coming online, every 5 minutes,
  and on sign-in. The module loads after the first screen settles, and only once someone signs in.
  The Account page shows its state, and the switch for another account's cookbook.
- Android (`apps/mobile/src/features/saved-recipes/librarySync.ts`, `CookbookSyncContext.tsx`):
  the link and bases live under `linkdish.librarySync.v1` in AsyncStorage and collections under
  `linkdish.collections.v1` (collections an older build kept in the sync state move there on the
  next run); tags, collection membership, rating, cook log and preferred servings ride along on
  each record as `libraryExtras`.
  Merged changes are written to the stored cookbook before the bases that describe them. Runs
  start after changes (4 s), when the app comes to the foreground, every 5 minutes while open, and
  on sign-in; never while the stored cookbook couldn't be read. The Household screen shows its
  state and the switch.

### `/extract` request path and performance

`api/extract.ts` and the Fastify route share `services/extract-request-pipeline.ts`:

1. IP rate limit (Upstash), then request parsing. Only a request that fails
   `extractRecipeAnyRequestSchema` is a 400; any later error, a ZodError from the
   extraction included, is a 500.
2. Billing authorization and extraction start together. URL validation (DNS), the
   result-cache lookup and the page fetch overlap the auth, household and RevenueCat
   lookups. If billing denies, the in-flight fetch is aborted and the `plan_limit`
   response is returned. Only the plain HTTP fetch overlaps billing: a Playwright render
   (the escalation for a blocked, shell or thin page, which launches Chromium and cannot
   be aborted) awaits billing's answer through `SourceFetchOptions.awaitAuthorized`, as do
   deterministic extraction, LLM calls and cache writes.
3. Usage is committed before responding, exactly as before, including for cache hits
   (a cache hit is still an import).
4. Durable Postgres analytics and cache writes run after the
   response through `@vercel/functions` `waitUntil` (fire-and-forget on Fastify). The
   in-process admin metrics are recorded by both adapters.

Performance pieces in `services/extractor-api/src/modules/extract`:

- **Result cache** (`cache/extraction-cache.ts`): a URL-keyed Upstash cache
  (`linkdish:extract-cache:v1:<EXTRACTOR_CACHE_VERSION>:<sha256(canonical URL)>`, where
  the canonical URL has tracking parameters, fragments, host case and trailing slashes
  normalised, and YouTube URLs use their watch URL). Route fragments (`#/…`, `#!…`) are
  kept: a browser render keeps the fragment, so a hash-routed app renders a different
  recipe for each. It holds only validated
  deterministic successes at or above the success confidence bar. It never stores
  needs_retry, failures, quota data, image scans or LLM fallback output (strategy
  `llm-fallback` or `llm` provenance: the model reads page text anyone can post, such as
  comments, so one caller could steer what later importers are served), and never a page
  that redirected to another site. Reads treat an LLM-derived entry as a miss. A hit skips
  fetch and parse and re-stamps the per-request
  `recipe.sourceUrl`. Bump `EXTRACTOR_CACHE_VERSION` whenever extraction output or cache
  semantics change. `EXTRACT_CACHE_ENABLED` is the kill switch and
  `EXTRACT_CACHE_TTL_SECONDS` sets the lifetime (default 7 days). Only the live canary that
  presents `LINKDISH_CANARY_TOKEN` as a bearer token (the same check billing uses) skips
  cache reads and refreshes the entry; the bare `x-linkdish-canary` marker is
  caller-controlled and only keeps a request out of durable analytics. Responses carry
  `x-linkdish-cache: hit|miss|bypass`, and logs and analytics carry `cacheStatus`.
- **One deadline** (`deadline.ts`): `EXTRACT_REQUEST_DEADLINE_MS` (default 50 s, under
  the 60 s `maxDuration`) sizes every step. The HTTP fetch retries at most once, only
  after connection errors, and not at all when Playwright can take over. The browser
  queue times out. Gemini attempts fit the remaining time. The OpenAI client has an
  explicit timeout and `maxRetries: 0`.
- **LLM text cleanup** runs only on photo scans, when `RECIPE_TEXT_CLEANUP_ENABLED` is on,
  the runtime provider is not `none`, and the text shows artifacts
  (`text-cleanup/needs-text-cleanup.ts`).
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
  user an event concerns and leaves a 5-minute marker; a lookup only caches a paid plan
  when no marker exists (checked and written in one EVAL) and it started less than 5
  minutes ago, so a lookup still waiting on RevenueCat when a refund or expiry arrives
  cannot put the old plan back. Household changes that require Family use fresh lookups.

## Authentication

- Clerk owns social sign-in proof; LinkDish owns the stable application user ID.
- The backend maps Clerk subjects to LinkDish users through provider-neutral external identity keys, so billing, households, quotas, shared recipes, and deletion continue to use LinkDish `user.id`.
- `AUTH_MODE` controls rollout behavior: `legacy_email_code`, `clerk_beta`, or `clerk_primary`.
- `GET /auth/config` lets mobile discover whether Clerk sign-in and email-code fallback should be visible without requiring a signed-in session.
- Google sign-in is supported through Clerk. Apple sign-in is intentionally hidden until an Apple Developer account and production Apple credentials exist.

### Admin dashboard

`/admin` (rewritten to `api/admin` on Vercel, `registerAdminDashboardRoutes` on Fastify) is
protected by named tokens rather than a Clerk session. Both adapters go through
`authorizeAdminAccess` in `modules/admin/admin-access.ts`:

- **Named tokens.** `ADMIN_DASHBOARD_TOKENS` holds one `name:token` pair per person,
  comma separated (lowercase names; tokens from `openssl rand -hex 32`). The browser
  prompt takes the name as the username and the token as the password; scripts send
  `Authorization: Bearer <token>` or `x-admin-dashboard-token`. Revoking one person means
  deleting their pair. The older shared `ADMIN_DASHBOARD_TOKEN` still works as the user
  `admin`, and the dashboard's Notes ask for it to be replaced. Malformed, duplicate or
  shared entries are skipped and reported in Notes instead of failing API startup. With no
  tokens, Fastify admits loopback callers only and Vercel refuses with 403.
- **Lockout.** Each presented-but-wrong token atomically increments a per-network counter
  in Upstash (`linkdish:admin:auth-failures:v1:<hashed IP>`), so a concurrent burst cannot
  slip under the limit. After `ADMIN_AUTH_FAILURE_LIMIT_MAX`
  (10) failures within `ADMIN_AUTH_FAILURE_LIMIT_WINDOW_MS` (15 minutes) that network gets
  429 even with a valid token until the window ends (the lockout is per network, so
  someone sharing the admin's IP can trigger it). A request with no credential (the
  browser's first hit before its prompt) is not counted. The limiter fails open if
  Upstash is unreachable, so an outage does not lock the owner out; the token check
  still runs.
- **Cross-site writes.** Browsers replay cached Basic credentials, so POST/PUT/DELETE are
  refused when `Sec-Fetch-Site` is anything but `same-origin`/`none`, and POST/PUT must
  send `application/json` (which forces a CORS preflight the admin routes never answer).
- **Audit log.** Failed sign-ins, lockouts, account lookups, plan grants (including dry
  runs) and model changes/resets are appended to the `linkdish:admin:audit:v1` sorted set
  (sign-in failures and lockouts to `linkdish:admin:audit:v1:auth`, so a flood of them
  cannot trim real actions out) with the admin's name, IP, outcome and details (never the
  presented token). Each set is trimmed to `ADMIN_AUDIT_RETENTION_DAYS` (180) and 2,000
  entries, each network adds at most the lockout limit of failure entries per window, and
  everything is mirrored to the function log
  as `[admin-audit]` lines. The dashboard shows the newest 50 under Admin Activity. Plan
  grants also keep their own `linkdish:admin:billing-grant:*` record, now with
  `grantedBy: admin-api:<name>`.

## Extraction Fallback Contract

Production extraction is expected to follow this ladder:

1. Browser-like HTTP fetch.
2. Playwright browser fetch for blocked, thin, or JavaScript-heavy pages when enabled.
3. Deterministic extraction and confidence scoring.
4. For YouTube, the "full recipe" links in the description when the description itself has no method.

Cached successes short-circuit this ladder. They are shared only when they cleared the success confidence bar for their source type, and they are billed like any other import.

Strong structured recipes (the site's own JSON-LD or microdata with a title, two or more ingredients and a step) stop at step 3 with a success even when servings or times are missing. Anything that doesn't clear its confidence bar after these steps fails with a plain reason; no step calls an LLM. Photo scans are the only path that uses the configured Gemini/OpenAI provider.

If production `/extract` skips the browser fetch, it is a deployment regression even when `/health` is green.

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
- `pnpm test:e2e:web` runs the web app's key flows (import, cookbook, shopping list, meal
  plan) in Playwright against a production build with the API mocked
  (`apps/web/e2e/README.md`). CI runs it as the `e2e-web` job; it is not part of `validate`
  because it needs a build and a browser.
- The live canary manifest is intentionally separate from PR-blocking CI so real-world regressions can be measured without making the pipeline flaky.
- API deploys (`deploy-api.yml`) are gated on it instead: the workflow deploys with
  `--prod --skip-domain`, runs the health check and the live canary against that deployment's
  own `*.vercel.app` URL, and only then runs `vercel promote`. After promoting it confirms through
  the Vercel API that api.linkdish.ca points at the new deployment before the final health check.
  A failing check leaves api.linkdish.ca on the previous deployment, and the run summary names the
  staged URL so it can be promoted by hand when the failure is a third-party site rather than the
  change (only if no later run has promoted a newer one). A failure after promotion gets a
  `vercel rollback` hint instead. The workflow only runs from `main`. This relies
  on the API project having no Vercel Deployment Protection; turning it on would need a bypass
  header in both check scripts.

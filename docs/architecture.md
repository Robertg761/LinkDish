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

## Mobile

- Expo Router drives navigation between the intake screen and a result preview screen.
- The mobile app talks to the backend through `@linkdish/api-client`.
- Mock mode lives in the mobile service layer so the UI can ship ahead of the extractor implementation.
- The result flow is a typed state machine: `success`, `needs_retry`, and `failure`.
- Retryable responses trigger an explicit fallback request instead of silently escalating to AI.

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
  page, and falls back to a fresh fetch when the entry is missing.
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

If production `/extract` skips browser fetch or fallback retry, it is a deployment regression even when `/health` is green.

## Shared Packages

- Domain models and API contracts stay outside both apps to avoid drift.
- UI primitives are intentionally thin so the mobile app can own product styling while keeping presentation consistent.

## Quality Gates

- Fixture-backed unit and integration tests stay deterministic and run in CI.
- The live canary manifest is intentionally separate from PR-blocking CI so real-world regressions can be measured without making the pipeline flaky.

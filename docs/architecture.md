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
4. Explicit mobile retry with the configured Gemini/OpenAI fallback provider when deterministic extraction is incomplete.

If production `/extract` skips browser fetch or fallback retry, it is a deployment regression even when `/health` is green.

## Shared Packages

- Domain models and API contracts stay outside both apps to avoid drift.
- UI primitives are intentionally thin so the mobile app can own product styling while keeping presentation consistent.

## Quality Gates

- Fixture-backed unit and integration tests stay deterministic and run in CI.
- The live canary manifest is intentionally separate from PR-blocking CI so real-world regressions can be measured without making the pipeline flaky.

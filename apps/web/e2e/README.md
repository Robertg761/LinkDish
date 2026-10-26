# Web end-to-end tests

Playwright drives the web app's key flows in Chromium, at desktop and phone (Pixel 7) sizes:

- `cookbook.e2e.ts`: the first-run welcome and starter recipes, opening a recipe, delete and undo
- `import.e2e.ts`: importing from a link and saving it, and falling back to pasted text when a
  site blocks the link
- `plan-and-shop.e2e.ts`: adding a recipe's groceries to the shopping list and ticking them off,
  and planning a recipe for dinner

Run them with:

```bash
pnpm --filter @linkdish/web exec playwright install chromium   # once
pnpm test:e2e:web
```

Add `--ui`, `--headed` or `--project=desktop` after `pnpm --filter @linkdish/web test:e2e --`
to watch or narrow a run. CI runs them in the `e2e-web` job of `ci.yml` and uploads the HTML
report and traces when a test fails.

## How they run

- The suite builds the app (`vite build --outDir dist-e2e`) and serves it with `vite preview`
  on port 4183, so it tests what ships. Locally an already running server on that port is
  reused; stop it after changing app code.
- The build points the API at `https://api.e2e.invalid`. `fixtures.ts` answers those requests
  (`api.on("POST", "/extract", ...)`), records them in `api.calls`, and returns 404 for anything
  a test didn't mock. Requests to any other origin are aborted, so nothing reaches production.
- Each test gets a fresh browser context: an empty cookbook (the starter recipes), no
  account (Clerk is off) and the first-run sheet already dismissed (`test.use({ onboardingSeen:
false })` shows it).
- A test fails if the page throws an uncaught error.
- Files are `*.e2e.ts`, not `*.test.ts`, so Vitest leaves them alone.

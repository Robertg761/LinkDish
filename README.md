# LinkDish

LinkDish saves recipes from links and turns them into a clean, portable recipe
library across web and mobile.

- Web: [app.linkdish.ca](https://app.linkdish.ca)
- Product site: [linkdish.ca](https://linkdish.ca)
- API: [api.linkdish.ca](https://api.linkdish.ca)

## What it does

- Saves recipes from websites, YouTube (including Shorts), Pinterest pins,
  TikTok captions, pasted text and photos of cookbook pages.
- Keeps a photo-first cookbook with ranked search, favorites, tags,
  collections, ratings and a cook log, in light or dark mode.
- Scales recipes by servings and converts between original, US and metric
  units (including oven temperatures).
- Cook mode with resumable sessions and timers that keep running across the app.
- Weekly meal planner that turns a week into a shopping list grouped by aisle,
  shared with a Family household.
- Backups and imports from Paprika, Mela and JSON-LD files.

See [docs/whats-new.md](docs/whats-new.md) for the current release notes.

## Repository

This pnpm workspace contains:

- `apps/web`: React and Vite web application
- `apps/mobile`: Expo and React Native mobile application
- `services/extractor-api`: Fastify recipe extraction API
- `packages`: shared contracts, domain logic, API client, UI, and utilities
- `site`: public product, privacy, and support pages

See [docs/architecture.md](docs/architecture.md) for a high-level system map.

## Local development

Requirements:

- Node.js 20 or newer
- pnpm 10.8.0

Install and validate the workspace:

```bash
pnpm install --frozen-lockfile
pnpm validate
```

Copy the relevant example environment file before running an application:

- `apps/web/.env.example`
- `apps/mobile/.env.example`
- `services/extractor-api/.env.example`

Start a development target:

```bash
pnpm dev:site
pnpm dev:web
pnpm dev:mobile
pnpm dev:api
```

Check the web bundle budgets after a production build:

```bash
pnpm build:web
pnpm --filter @linkdish/web size
```

The static product site is served at `http://localhost:4173`; its analytics are
disabled on localhost. `pnpm validate` also checks its internal links, metadata,
sitemap, support form contract, and social-preview image. See
[site/README.md](site/README.md) for website development and deployment details.

Do not commit credentials, production data, or private environment files.

## Contributions and security

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull
request. Report security concerns privately as described in
[SECURITY.md](SECURITY.md).

## License

This repository is source-visible, not open source. Copyright (c) 2026 Robert
Gordon. All rights reserved.

The source is published for transparency and review. No permission is granted
to copy, modify, distribute, deploy, sublicense, sell, or create derivative
works without prior written permission. See [LICENSE](LICENSE).

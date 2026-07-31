# LinkDish

LinkDish saves recipes from links and turns them into a clean, portable recipe
library across web and mobile.

- Web: [app.linkdish.ca](https://app.linkdish.ca)
- Product site: [linkdish.ca](https://linkdish.ca)
- API: [api.linkdish.ca](https://api.linkdish.ca)

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
pnpm dev:web
pnpm dev:mobile
pnpm dev:api
```

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

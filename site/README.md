# LinkDish Public Site

This directory is the static public site for [linkdish.ca](https://linkdish.ca).
It lives in the LinkDish monorepo so website, API, web-app, and mobile changes can
be reviewed and shipped together.

## What Lives Here

- `index.html`: marketing homepage (hero paste box, sources, features, Family,
  pricing, iPhone waitlist, FAQ) and social-preview metadata.
- `recipe-saver-app/`, `save-recipes-from-websites/`,
  `save-recipes-from-youtube/`, `scan-recipes-from-photos/`,
  `meal-planner-and-grocery-list/` and `paprika-alternative/`: search landing
  pages. Each has a canonical URL, Open Graph/Twitter tags, SoftwareApplication,
  BreadcrumbList and FAQPage JSON-LD, and a sitemap entry.
- `support/index.html`: support page and support ticket form.
- `privacy/index.html`: privacy policy (keep in step with
  `../public/privacy.html`).
- `invite/index.html`: household invite handoff (web join link for everyone,
  Android app link on Android only; there is no iPhone app yet).
- `base.css`: tokens (light and `prefers-color-scheme: dark`), header, footer,
  buttons, forms, FAQ, final call, mobile dock and motion. Every page loads it.
- `marketing.css`: homepage and landing-page layouts plus the HTML/CSS product
  mocks (phone, planner, shopping list). `info.css`: support, privacy, invite
  and 404.
- `site.js` and `analytics.js`: shared browser behavior and first-party
  analytics. They are plain ES5-style scripts listed in the ESLint ignores; a new
  `.js` file here must be added to those ignores too.
- `CNAME`, `robots.txt`, `sitemap.xml`, `favicon.ico` and
  `apple-touch-icon.png`: GitHub Pages, search and icon metadata.
- `assets/`: fonts, icons, screenshots and social-preview images.

There is no compilation step. GitHub Pages publishes this directory through
`.github/workflows/deploy-site.yml`.

## Page Conventions

- Every page shares the same header, footer and mobile dock markup and loads
  `site.js` and `analytics.js`. Asset and page links are root-absolute
  (`/assets/...`, `/support/`), so the 404 page works at any depth.
- Links to `app.linkdish.ca` and Google Play carry `data-cta="<placement>"`
  (`hero-web`, `plans-plus`, `dock-android`, ...). `analytics.js` sends it as the
  `cta` property and appends `utm_source=linkdish.ca`, `utm_medium=<placement>`
  and `utm_campaign=<page>` (Play links get the same values in `referrer`).
  `pnpm check:site` fails when such a link has no `data-cta`.
- Above-the-fold content is never hidden for motion. Only `[data-reveal]`
  blocks fade in, and only after the inline head script adds `motion-ready`.
- FAQ answers live in `<details data-faq>` blocks; the FAQPage JSON-LD must use
  the same questions (`pnpm check:site` compares them with the visible text).
- Prices mirror `apps/web/src/features/pricing/plans-content.ts` and the API's
  default price labels. The Founding offer is only shown in the app when the API
  says it is available, so it is not advertised here.

## Images

- Screenshots are served with `<picture>`: AVIF and WebP at 360, 600 and 720 px
  (`screen-*-360.avif`, `screen-*-600.webp`, ...) with a 720 px PNG as the
  fallback, and `sizes` set to the width the frame really renders at (so a 2x
  phone picks 600 and a 3x phone 720). Every `<img>` needs `alt`, `width` and
  `height`, and every `srcset` file must exist (`pnpm check:site` checks all
  three).
- The screenshots are real captures of the web app (a production build with the
  API stubbed and a seeded cookbook, week plan and shopping list), taken at
  390 x 844 with a 3x device scale and an iPhone status bar and home indicator
  added, so every one is 720 x 1558 at the fallback size: `screen-cookbook`,
  `screen-recipe` (Metric selected), `screen-cookmode` (running timer),
  `screen-shopping` (by aisle), `screen-planner`, `screen-import` (a YouTube
  import) and `screen-dark` (the cookbook in dark mode). Keep that frame when
  replacing one, and retake them when the app's look changes.
- `photo-*` are the recipe photos from those captures, as AVIF and WebP at 240
  and 480 px with a JPEG fallback, for the homepage photo card.
- The header and footer logo use `linkdish-icon-64.png`/`-128.png`; the 512 px
  `linkdish-icon.png` is only for structured data and external links.
- Social cards stay under 300 KB (WhatsApp drops larger previews).

## Local Development

From the repository root:

```bash
pnpm dev:site
```

Open `http://localhost:4173`. Marketing analytics intentionally do not run on
localhost. Validate internal references, metadata, the sitemap, the support
form contract, and social-card dimensions with:

```bash
pnpm check:site
```

`pnpm validate` includes this site check.

## Support System Contract

The support page offers an inline form and direct email links to
`support@linkdish.ca`. The form posts JSON to:

```text
https://api.linkdish.ca/support-ticket
```

The endpoint and its tests now live beside the site:

- [`../api/support-ticket.ts`](../api/support-ticket.ts)
- [`../api/support-ticket.test.ts`](../api/support-ticket.test.ts)

If form fields or allowed problem types change, update the page, endpoint, and
tests in the same change. Keep the hidden `website` honeypot empty. A successful
submission returns:

```json
{ "status": "submitted", "ticketId": "LD-YYYYMMDD-XXXXXXXX" }
```

Public contact links must use `support@linkdish.ca`; never add a personal email
address to the site.

## Homepage And Social Preview Contract

Keep visible homepage claims aligned with the Open Graph and Twitter metadata
in `index.html`. Update the preview when positioning, availability, pricing,
plan limits, screenshots, or other major visual direction changes.

When artwork changes, add a new 1200 x 630 PNG with a dated filename such as
`assets/social-card-YYYYMMDD.png`, then update both `og:image` and
`twitter:image`. A new filename avoids stale social-platform caches. Avoid
putting pricing or quota promises into the image unless production plan
configuration was verified in the same change.

The current card is `assets/social-card-20260928b.png`, built from the real app
screenshots; every page and the web app (`apps/web/index.html`) use it. The
older `social-card-20260928.png` and `social-card-20260729.png` stay so links
already shared with them keep their preview.

## Deployment And Ownership

Changes under `site/` deploy from the public `Robertg761/LinkDish` repository
after they reach `main`. The workflow uploads only this directory, without this
README; app and API files are not part of the Pages artifact.

The custom domain, Pages configuration, deployment workflow, and complete site
history are owned by this monorepo. The former `Robertg761/LinkDish-site`
repository is archived, has Pages disabled, and is not required for development
or deployment.

For every site change:

1. Run `pnpm check:site` from the repository root.
2. Merge or push the change to `main` and confirm the `Deploy Site` workflow
   succeeds.
3. Verify the affected routes on `https://linkdish.ca`, including the support
   form or invite handoff when those contracts changed.

If the custom domain or Pages settings ever need repair, configure GitHub Pages
on `Robertg761/LinkDish` with GitHub Actions as the source, `linkdish.ca` as the
custom domain, and HTTPS enforcement enabled. Do not restore Pages on the
archived repository.

Do not change DNS, Vercel environment variables, Proton Mail, or Resend settings
as part of routine site deployment.

# LinkDish Public Site

This directory is the static public site for [linkdish.ca](https://linkdish.ca).
It lives in the LinkDish monorepo so website, API, web-app, and mobile changes can
be reviewed and shipped together.

## What Lives Here

- `index.html`: marketing homepage and social-preview metadata.
- `support/index.html`: support page and support ticket form.
- `privacy/index.html`: privacy policy.
- `invite/index.html`: household invite handoff page.
- `recipe-saver-app/`, `save-recipes-from-websites/`, and
  `paprika-alternative/`: search landing pages.
- `home.css`, `info.css`, `seo.css`, and `styles.css`: site styling.
- `site.js` and `analytics.js`: shared browser behavior and first-party
  analytics.
- `CNAME`, `robots.txt`, and `sitemap.xml`: GitHub Pages and search metadata.
- `assets/`: fonts, screenshots, icons, and social-preview images.

There is no compilation step. GitHub Pages publishes this directory through
`.github/workflows/deploy-site.yml`.

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

## Deployment And Cutover

Changes under `site/` deploy from the public `Robertg761/LinkDish` repository
after they reach `main`. The workflow uploads only this directory; app and API
files are not part of the Pages artifact.

The former `Robertg761/LinkDish-site` repository served `linkdish.ca` before the
monorepo migration. For the one-time hosting cutover:

1. Push the merged monorepo and enable GitHub Actions as the Pages source for
   `Robertg761/LinkDish`.
2. Confirm the new workflow successfully publishes its temporary GitHub Pages
   URL.
3. Remove the `linkdish.ca` custom domain from the old repository, configure it
   on `Robertg761/LinkDish`, and enforce HTTPS.
4. Rerun the site workflow and verify the homepage, support form, privacy page,
   SEO pages, sitemap, social image, and household invite redirect.
5. Archive the old site repository only after the custom domain is healthy on
   the monorepo.

Do not change DNS, Vercel environment variables, Proton Mail, or Resend settings
as part of routine site deployment.

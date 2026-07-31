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

## Deployment And Ownership

Changes under `site/` deploy from the public `Robertg761/LinkDish` repository
after they reach `main`. The workflow uploads only this directory; app and API
files are not part of the Pages artifact.

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

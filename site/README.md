# LinkDish Public Site

This repo is the static public site for `https://linkdish.ca`. It is separate
from the LinkDish app/API monorepo.

## What Lives Here

- `index.html`: public LinkDish marketing/home page.
- `support/index.html`: public support page and support ticket form.
- `privacy/index.html`: public privacy policy.
- `styles.css`: shared public-site styling.
- `CNAME`: GitHub Pages custom domain, currently `linkdish.ca`.
- `assets/`: public images used by the static pages.

There is no build step for this repo. GitHub Pages serves the files from
`main` at the repository root.

## Support System Contract

The support page has two support paths:

- Inline support form in `support/index.html`.
- Direct email links to `support@linkdish.ca`.

The form posts JSON to:

```text
https://api.linkdish.ca/support-ticket
```

That endpoint is owned by the LinkDish monorepo, not this static-site repo:

```text
/Users/robert/Documents/Projects/LinkDish/api/support-ticket.ts
```

The backend sends ticket emails through Resend to Proton Mail at
`support@linkdish.ca`. The detailed backend/DNS/mailbox runbook is in:

```text
/Users/robert/Documents/Projects/LinkDish/docs/support-system.md
```

If you change form fields here, update `api/support-ticket.ts` and
`api/support-ticket.test.ts` in the LinkDish monorepo in the same work session.

## Form Payload

`support/index.html` currently sends:

```json
{
  "email": "customer@example.com",
  "problemType": "Recipe import problem",
  "link": "https://example.com/recipe",
  "device": "iPhone Safari",
  "details": "What happened...",
  "expected": "What should have happened...",
  "website": ""
}
```

The `website` field is a hidden honeypot and should remain empty. The backend
will reject submissions if it is populated.

Allowed `problemType` values must match the API enum exactly:

- `Recipe import problem`
- `Account or household issue`
- `Web app bug`
- `Privacy or data request`
- `Other`

On success, the endpoint returns:

```json
{ "status": "submitted", "ticketId": "LD-YYYYMMDD-XXXXXXXX" }
```

The page shows that ticket ID in the form status text.

## Public Email Links

Use `support@linkdish.ca` for public support/contact mailto links. Do not
restore the older personal Gmail address on public pages.

Current pages with support/contact email links:

- `index.html`
- `support/index.html`
- `privacy/index.html`

Check with:

```bash
rg -n 'mailto:|support@linkdish\\.ca|robertgordon761@gmail.com' .
```

Expected result: public mailto links should use `support@linkdish.ca`, and
there should be no `robertgordon761@gmail.com` on the public site.

## Homepage And Social Preview Contract

`index.html` owns both the rendered homepage and the metadata that social
platforms use for link previews. X, iMessage, Slack, and similar platforms may
show only the Open Graph/Twitter tags and the referenced image, so keep those in
sync with visible site changes.

Update the social preview in the same change when any of these change:

- Homepage headline, positioning, or primary value proposition.
- Pricing, trial, quota, free-import, or plan language.
- App availability, such as iOS web app, Android, Google Play, or install CTAs.
- Canonical domain or legacy-domain copy.
- Brand colors, app screenshots, or other major visual direction.
- Any image or text that would make an existing preview misleading.

The homepage tags to keep aligned are:

- `og:title`
- `og:description`
- `og:image`
- `og:image:alt`
- `twitter:title`
- `twitter:description`
- `twitter:image`
- `twitter:image:alt`

When changing the preview image, create a new 1200 x 630 PNG with a dated
filename such as `assets/social-card-YYYYMMDD.png`, then point both `og:image`
and `twitter:image` at that new URL. Do not keep pointing metadata at an old image URL for changed artwork;
social platforms can keep serving a cached preview for the old URL.

Avoid putting pricing or quota promises in social images unless the billing docs
and production plan configuration were checked in the same work session. Prefer
evergreen product copy such as what LinkDish does and where to open/install it.

Before pushing, check for stale preview copy:

```bash
rg -n 'og:|twitter:|social-card|imports free|linkdish\.xyz' index.html
sips -g pixelWidth -g pixelHeight -g format assets/social-card-*.png
```

## Deploy And Verify

Commit and push to `main`:

```bash
git status --short
git add index.html support/index.html privacy/index.html styles.css assets CNAME robots.txt sitemap.xml
git commit -m "<message>"
git push
```

GitHub Pages deploys from `main`. Check status:

```bash
gh run list --limit 5
gh api repos/Robertg761/LinkDish-site/pages --jq '{status:.status,cname:.cname,html_url:.html_url,source:.source}'
```

After Pages reports `built`, verify the live HTML and social-preview metadata:

```bash
for url in https://linkdish.ca/ https://linkdish.ca/support/ https://linkdish.ca/privacy/; do
  echo "--- $url"
  curl -fsSL "$url?verify=$(date +%s)" | rg -n 'support@linkdish\\.ca|robertgordon761@gmail.com' || true
done

curl -fsSL "https://linkdish.ca/?verify=$(date +%s)" \
  | rg -n 'og:description|og:image|twitter:description|twitter:image|social-card|imports free|linkdish\.xyz'

curl -fsSL https://linkdish.ca/assets/social-card-YYYYMMDD.png \
  -o /tmp/linkdish-social-card.png
sips -g pixelWidth -g pixelHeight -g format /tmp/linkdish-social-card.png
```

Expected result: live metadata points to the current social-card filename, the
social-card URL returns a 1200 x 630 PNG, and the metadata does not contain stale
quota, pricing, or legacy-domain copy.

To verify the form path end to end, submit a test ticket through the API and
then confirm it appears in Proton Mail. The canonical test command is in the
LinkDish monorepo doc:

```text
/Users/robert/Documents/Projects/LinkDish/docs/support-system.md
```

## DNS And Mail Ownership

DNS and mailbox setup do not live in this repo. Current production ownership:

- DNS registrar/provider: Porkbun
- Mailbox provider: Proton Mail custom domain
- Ticket sender: Resend via `linkdish-api`
- Ticket recipient: `support@linkdish.ca`

Do not change DNS, Vercel env vars, Proton settings, or Resend sender settings
from assumptions in this repo alone. Use the monorepo support-system runbook.

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

After Pages reports `built`, verify the live HTML:

```bash
for url in https://linkdish.ca/ https://linkdish.ca/support/ https://linkdish.ca/privacy/; do
  echo "--- $url"
  curl -fsSL "$url?verify=$(date +%s)" | rg -n 'support@linkdish\\.ca|robertgordon761@gmail.com' || true
done
```

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

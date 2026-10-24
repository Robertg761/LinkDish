# Security policy

Please report suspected LinkDish security vulnerabilities privately by email
to [support@linkdish.ca](mailto:support@linkdish.ca).

Include:

- the affected component or URL;
- a clear description of the impact;
- reproducible steps or a proof of concept;
- any suggested mitigation;
- a safe way to contact you.

Do not include credentials, personal information, or unnecessary production
data. Do not open a public issue for an unpatched vulnerability.

This project does not currently operate a bug-bounty program. Submission of a
report does not create a promise of payment or a response deadline.

## Dependency audit exceptions

CI fails on any high or critical advisory (`pnpm audit --audit-level=high`).
`pnpm.auditConfig.ignoreGhsas` in the root `package.json` lists the only
exceptions. Each one is reachable solely through the Expo CLI and Metro
bundler that build the mobile app on a developer machine or CI runner; none
ships in the web app, the mobile app bundle or the API.

| Advisory | Package | Reached through | Why it is ignored |
| --- | --- | --- | --- |
| `GHSA-5p2g-fcmc-qvqq` | image-size (JXL/HEIF parsers) | `metro` | Metro reads the size of the repository's own image assets. The fix is image-size 2, which removed the synchronous API Metro 0.84 calls. |
| `GHSA-w3rx-r6r6-pgpr` | image-size (ICNS parser) | `metro` | As above. |
| `GHSA-86w9-cpqp-85rv` | node-forge | `@expo/cli` | Parses local iOS signing certificates and signs development update manifests; the advisory concerns verifying untrusted RSA signatures, which this path never does. No patched release exists. |
| `GHSA-mrhx-c7xc-m3w5` | zod 3 | `@expo/cli` | The Expo CLI validates its own dev-tools plugin schemas with zod 3; the advisory concerns validating large untrusted arrays. The fix exists only in zod 4, which the web app, API and shared packages use, and the `zod@>=4.0.0 <4.6.6` override keeps them patched. |
| `GHSA-vfj7-8cjw-p6xm` | braces | `@expo/metro-file-map` → `micromatch` | Glob patterns come from the repository's own Metro config, not from untrusted input. No patched release exists. |

Remove an entry as soon as Expo or Metro ships a release that drops the
vulnerable version.

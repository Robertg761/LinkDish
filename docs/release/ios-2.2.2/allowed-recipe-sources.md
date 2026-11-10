# iPhone recipe-source review — November 9, 2026

Branch: `codex/ios-approved-url-imports`. Draft application changes only; do not merge or represent this restriction as present in build 38. Privacy-only PR #139 is separately merged and deployed.

## Initial source

| Source                    | Reuse evidence                                                                                                                                                                                                                                                                                                                                             | Access and compatibility                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicdomainrecipes.com` | [Homepage](https://publicdomainrecipes.com/) explicitly dedicates recipes to the public domain. [README licence section](https://github.com/ronaldl29/public-domain-recipes#license) includes all site content and contributed text/images. [Unlicense](https://github.com/ronaldl29/public-domain-recipes/blob/main/LICENSE.md) permits commercial reuse. | `robots.txt` returned HTTP 200 with an empty Disallow for `*`. Basic Waffles returned HTTP 200 without redirect; the existing article parser extracted ingredients and steps locally. |

The permission basis is the publisher's express public-domain dedication, not robots.txt. Source URLs remain part of the imported recipe. These statements are evidence of the publisher's grant, not a guarantee about every contributor's ownership or Apple's decision. Recheck the licence when expanding the catalog or if the publisher changes its terms.

## Researched but not enabled

- [Based Cooking](https://github.com/LukeSmithxyz/based.cooking#license): express public-domain dedication covers text/images; robots permits access. However, the current article parser returned no candidate for its Basic Waffles page. Defer until extraction compatibility is fixed and tested.
- Recipe Commons / Wikibooks: per-work or attribution/share-alike terms need item-level review and appropriate attribution support; no blanket domain permission assumed.
- Commercial recipe sites and social platforms: not enabled without an applicable licence or permission. Public access, robots permission, ingredient lists, disclaimers and user acceptance do not establish rights to all prose or images.

## Application behavior

- iOS only: exact HTTPS host and single static recipe path; rejects subdomains, lookalike domains, credentials, nonstandard ports, queries and directory pages.
- Both URL entry and the extraction-service boundary enforce the list. Successful responses with an unsupported final source URL are rejected before display/save. Direct/deep links and primary/fallback requests cannot skip the boundary. Rejection makes no extraction API call and consumes no server import quota.
- The import and recovery forms show the source catalog inline. User-provided photos/text remain available with AI consent and a permission reminder; screenshots are not presented as a way around source restrictions.
- Android and web behavior is unchanged. Existing saved recipes are not deleted or retrospectively licensed by this change.

## Remaining release work

1. The deployed backend's redirect safety check prevents unsafe network destinations, but it does not enforce this rights-based source list. Before treating the restriction as end-to-end enforcement, add backend enforcement for the iOS import path, including every redirect and any secondary content fetch. Do not rely on a client-supplied platform header as an authorization boundary. No backend changes or deployment are part of this branch.
2. Test the final build on an iPhone against the deployed API, including a supported link, a rejected link/shared URL, photo/text import and saved-recipe reopening. Local parsing is not a deployed authenticated extraction test. The review account's limited imports were not spent.
3. Update iPhone screenshots, listing text and review notes to match restricted source support; do not advertise arbitrary social-platform imports for this build. Build/upload a new version of the binary after app changes are approved.
4. Content Rights remains unanswered. The owner still needs to assess the declaration for the actual submitted app, including built-in, saved, uploaded and shared content. An allowlist is not an automatic affirmative answer to Apple's declaration or a guarantee of approval.

## Verification

- Policy-only PR #139: all seven GitHub checks passed; Deploy Site succeeded; all three public policy pages return HTTP 200 with November 9 updates.
- All 527 mobile tests and mobile TypeScript checks pass. Targeted lint and the production iOS JavaScript/Hermes export pass; the export verifier confirms production API, Clerk and RevenueCat with no checked staging/debug/secret markers. A signed native archive and physical-device test have not been run for this branch. No native signing, dependency, build-number or backend configuration changes are included.

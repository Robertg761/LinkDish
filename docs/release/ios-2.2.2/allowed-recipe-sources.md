# iPhone recipe-source review — November 10, 2026

Branch: `codex/ios-approved-url-imports`. Application changes remain unmerged. Build 39 contains the restriction; build 38 does not. Privacy-only PR #139 is separately merged and deployed.

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

## Backend and release status

- Backend PR #141 is merged and deployed independently. `/extract/ios` fixes `ios_public_domain_v1` on the server and checks every redirect and secondary HTML fetch, robots access and final source URL. It disables browser/social/video fetchers, bypasses the unrestricted cache, and omits remote artwork. A modified client can still call the older public endpoint: this is not device attestation.
- Production testing found that the permitted publisher's explicit recipe sections failed the generic confidence threshold. Backend-only PR #142 adds deterministic parsing for that exact template, with a real public-domain fixture and negative tests. Missing optional details remain null/warnings; other sites' thresholds are unchanged.
- EAS produced signed version 2.2.2 build 39 from the mobile branch. Apple processed it and assigned it to LinkDish Internal Testers. It is selected for version 2.2.2 in App Store Connect. Mobile PR #140 remains unmerged.
- Both English listing localizations and reviewer notes describe the narrower source support. The updated ten-image set includes a new import screen; the other nine genuine captures show unchanged features.

## Remaining release work

1. Complete production verification after the parser follow-up deployment, then smoke-test the actual build 39 TestFlight archive on an iPhone. Simulator tests use the new JavaScript bundle on the unchanged native simulator shell, not the signed device archive. Test supported/rejected links, photo/text import and saved-recipe reopening.
2. Content Rights remains unanswered. Robert needs to assess the declaration for the actual submitted app, including built-in, saved, uploaded and shared content. The publisher's public-domain grant is documented above; an allowlist does not itself authorize an affirmative declaration or guarantee approval.
3. Keep the mobile branch unmerged until the user approves integration. Do not submit the version while required owner declarations remain pending.

## Verification

- Policy-only PR #139 is merged/deployed; public privacy/Terms pages are live and the approved iOS App Privacy labels are published.
- Mobile: 527 tests, TypeScript, lint, production release preflight and Hermes export passed. EAS signing/build succeeded for bundle `com.linkdish.app`, Expo project `@linkdish/linkdish`.
- Backend enforcement: full validation and all seven CI checks passed before deployment. Parser follow-up: 925 extractor tests, workspace types/lint, 109 Vercel handler tests and site validation passed locally. One unchanged web CommandPalette test timed out during the full run; all 16 tests in that file passed on rerun. CI is recorded on PR #142.
- The simulator rejects unsupported URLs and displays Google Gemini consent for the permitted source. No reviewer-account imports were consumed. See the build 39 release report for final production verification and screenshot upload status.

# iOS 2.2.2 (37) release handoff

Prepared November 7–8, 2026. **Not ready for final App Review submission yet.** Nothing was submitted to App Review or publicly released. No backend deployment, commit, or push was performed.

## Release candidate

- Expo `@linkdish/linkdish`; project `a2c1318c-39e0-45a3-a114-1f5e88288af1`.
- Bundle `com.linkdish.app`; Apple team `73UT6LC439`; ASC app `6826987838`.
- Version **2.2.2**, build **37**, synchronized in Expo, Info.plist and Xcode project.
- [EAS build](https://expo.dev/accounts/linkdish/projects/linkdish/builds/2e60b600-66ba-4871-95c3-e78d4c7b60e4): finished successfully.
- [Apple upload](https://expo.dev/accounts/linkdish/projects/linkdish/submissions/5f4d825b-4763-4f41-b5f3-5ce5bc28e3d5): successful. Apple processed and validated build 37; it is available to LinkDish Internal Testers (2 testers), with What to Test instructions saved. It is selected in the 2.2.2 distribution draft.
- Release environment remains the previously approved production API `https://api.linkdish.ca`, production Clerk publishable key, and RevenueCat iOS public SDK key. Secret credentials were not added to the app. Staging was not substituted.
- iPhone only, iOS 17 minimum. Local native validation used Xcode 26.6 / iOS 26.5 SDK. Apple accepted the EAS archive. Camera/photo permissions, Apple sign-in capability, app icon, and non-exempt-encryption=false configuration inspected.
- Mock API, local preview, development client and debug-household bypass disabled in the release profile. Production Hermes bundle assertion passed.

## Work completed

- Limited new **iOS** purchases and paywall cards to `linkdish_plus_monthly`. A purchase-layer guard also rejects Family/yearly/unknown products. Android offers and recognition of existing entitlements remain intact.
- Removed misleading annual/static-price/Family upgrade copy from iOS launch surfaces. Existing Family customers retain their access; new Plus purchases do not promise household sharing.
- Added an EAS TestFlight submission profile using the existing ASC app/team.
- Saved English (Canada) and English (U.S.) product-page copy. Name: **LinkDish: Recipe Saver**; subtitle: **Cookbook, meals & shopping**. Category Food & Drink, age rating 13+, free app download, US and Canada only, manual release.
- Uploaded three genuine Release-app promotional screenshots to both English localizations, in cookbook → cooking → shopping order. The source captures are unaltered app screens; the surrounding SVG compositions follow the Android cream/green visual direction.
- Verified RevenueCat default offering / `$rc_monthly` maps to the existing iOS product and Plus entitlement. Shared offerings were not edited.
- Confirmed subscription prices in ASC: **USD 2.99 / month; CAD 3.99 / month**. Availability US and Canada. Apple Family Sharing remains off; unsupported multiseat/Business/School purchase options disabled for this individual subscription.
- Saved Plus Monthly description and review notes; replaced the old multi-plan review screenshot with build 37's monthly-only paywall. Apple accepted the opaque JPEG after asset processing; Plus Monthly is Ready for Review in a draft submission.
- Saved App Privacy draft for 11 data types, linked to identity, none used for tracking; not published pending the owner/backend data-use confirmation below.
- Agreements, tax and bank statuses inspected: Free Apps Active, Paid Apps Active, bank Active, W-9 Active, DSA Active. No agreements accepted or financial information changed.

## Validation matrix

| Check | Result | Evidence / limitation |
| --- | --- | --- |
| Mobile automated suite | Complete | 488 tests / 62 files passed, including iOS product allowlist and retained Family entitlement test |
| TypeScript and focused lint | Complete | Passed; `git diff --check` clean |
| Production export/preflight | Complete | Hermes export and production configuration assertion passed |
| Native Release simulator | Complete | Xcode build succeeded; actual installed bundle 2.2.2 (37), com.linkdish.app |
| Apple upload/processing | Complete | Build 37 selectable and selected in version draft |
| Text import/save/edit | Complete, simulator | Authored Lemon Chickpea Couscous imported, saved, servings edited |
| Servings/cooking/shopping | Complete, simulator | 2x quantities verified; step 2/4 displayed; seven ingredients added with aisle grouping |
| Quota error → paywall | Complete, simulator | Free quota error offers View Plans; only Plus Monthly at localized $2.99/month |
| Paywall legal/management controls | Complete, simulator inspection | Renewal copy, Manage subscription, Privacy, Apple EULA, sign-in-to-restore controls present |
| Authentication on build 37 | Unverified on physical TestFlight | Requires a usable test account and physical-device access; simulator displayed Google/email, Apple availability is device-dependent |
| TestFlight purchase/restore/expiry | Unverified on build 37 | Prior development-build sandbox tests are historical evidence only, not a replacement for this candidate |
| Fresh install / session / sign-out | Unverified on build 37 | Simulator installation preserved existing local data |
| Camera/library, denial, offline | Unverified on build 37 | Automated coverage and prior work do not constitute current device verification |
| Account deletion | Unverified | Dedicated disposable account required; no personal account was deleted |
| Small screen / large text / VoiceOver | Unverified | Must complete candidate device pass; ordinary simulator layout inspected |
| iPad/macOS/visionOS | Not applicable | iPhone-only build; Mac/Vision availability disabled |

Historical billing evidence from the earlier development build: Plus and Family purchases refreshed without restart, restore produced feedback, and expiry returned access to Free without restarting. RevenueCat's sandbox history confirms those transactions. Repeat Plus tests on **TestFlight 37** before submission; Family new purchases are deliberately excluded from this launch.

## Genuine remaining blockers / owner actions

The earlier Add for Review validation (before the contact/copyright follow-up) reported: copyright, review username/password, contact first/last name/email/phone (international +country-code format), unpublished App Privacy, Content Rights Information, and one or more screenshots still processing. The subscription and group are both Ready for Review in the same draft; the app version cannot join until these fields/assets clear.


1. **Review contact and copyright owner — complete:** user confirmed Flavio Herrera as the review contact and Robert Gordon as copyright owner. Contact details and `2026 Robert Gordon` were saved in ASC. Personal email/phone are intentionally not copied into this repository.
2. **App Review access — configured in ASC:** on November 8 the dedicated reviewer email and reusable code were saved in App Review Information, with the request-code-first procedure, 10-minute window, and retry instructions. Robert reported the production account created and tested. The account starts on Free with three starter recipes; no imports were used during setup. Credentials are stored in ASC, not Git. Independent build-37 login verification remains pending; Robert’s test is reported evidence, not a test performed in this task.
3. **Content-rights declaration:** user explicitly deferred this to Robert Gordon. Leave the declaration unanswered until Robert confirms rights/permissions for third-party recipe content; user-provided links alone do not resolve the declaration.
4. **Privacy policy and privacy labels:** the public policy still refers generically to extraction providers. Website/backend owner must name Google Gemini and confirm the deployed processing/retention/training settings. See `privacy-owner-actions.md`. Finish/publish the accurate ASC privacy answers after confirmation; the draft is not a verified final legal statement.
5. **Final candidate testing:** use TestFlight 2.2.2 (37) to finish authentication, purchase/restore/relaunch/expiry, media imports, deletion with a disposable account, and accessibility/offline cases below. Physical iPhone Mirroring timed out connecting during this pass.
6. **Apple screenshot processing:** three correctly sized screenshots are attached in each English localization and their order is verified. Apple still reports one or more processing; wait for processing to complete, then verify the product-page preview before submission. The subscription review screenshot did finish processing.
7. **Final submission assembly:** Plus Monthly and its subscription group are now **Ready for Review**, both added to the same pending submission after Apple accepted the review image. Once the app blockers above are cleared, add version 2.2.2 to that same submission. Do not add yearly or Family products or submit the subscription alone.

Apple Developer membership expiration was not independently inspected; successful signed build/upload confirms usable signing credentials at this time, not a future membership guarantee.

## Precise remaining device pass

1. Install build 37 from TestFlight. Preserve/export any personal local recipes before any fresh-install test; use a dedicated device/account for deletion tests.
2. Confirm Google and Sign in with Apple, then email sign-in if advertised. Relaunch, confirm the session persists, sign out, and confirm signed-out data/entitlements do not leak between accounts.
3. Import a public recipe link, pasted text, and a camera/library photo. Deny photo/camera permission once; verify guidance. Try a blocked/private link and its alternate-import action. Toggle airplane mode and verify retry behavior.
4. Save/edit a recipe; force quit/reopen; confirm cookbook and shopping persistence. Scale servings, cook steps and timer behavior. Check a small-screen iPhone, larger accessibility text, and VoiceOver labels.
5. Sign in with the dedicated LinkDish account. Confirm Plus Monthly only, localized price/period, renewal copy and legal links. Use sandbox purchase (no real charge), confirm the same RevenueCat app user ID receives Plus, and a paid import/save works without restart.
6. Restore and confirm clear feedback; relaunch and verify entitlement. Cancel a purchase sheet and verify no false error/success. Disable sandbox renewal and wait for expiration; confirm Free returns without restart. Existing paid account restore should recover access, never grant the wrong signed-in user another account's entitlement.
7. Delete only the dedicated disposable account after confirming the destructive action. Check server account deletion and subscription-management guidance separately; account deletion does not itself cancel Apple billing.

## Optional polish (not proven release blockers)

- Recipe detail's “Duplicate” label wraps awkwardly on iPhone 17; the action works.
- Free-import quota copy can appear twice on the Add screen after quota exhaustion.
- Native back navigation exposes “(tabs)” on the recipe detail screen.
- First-party iOS analytics use the contract's legacy `android_app`/`android_*` labels with `osName=ios`; coordinate contract/reporting cleanup with the backend owner.
- Pasted recipe extraction initially captured extra text in servings; editing corrected it. AI results need review, already disclosed.

## Assets and reproducibility

- `listing-copy.json`: saved listing/reviewer prose (no credentials).
- `screenshots/01-cookbook.png`, `02-cooking.png`, `03-shopping.png`: 1206×2622 RGB PNGs uploaded to ASC.
- `screenshots/contact-sheet.png`: visual overview, not uploaded as an app screenshot.
- `sources/*.svg`: editable compositions with embedded genuine screen captures.
- `raw/*.png`: native simulator screenshots; `screenshots/paywall-review.jpg` is the final opaque subscription review image; `raw/paywall.png` preserves its source.
- `evidence/asc-listing.jpg`, `subscription-prices.jpg`, `privacy-draft.txt`, `review-draft.jpg`, `submission-validation.txt`, `build37-metadata.txt`: saved browser evidence.
- Regenerate compositions from repository root: `node docs/release/ios-2.2.2/render-screenshots.cjs`.

Local session logs: `/tmp/linkdish-release-tests.log`, `/tmp/linkdish-release-typecheck.log`, `/tmp/linkdish-release-export.log`, `/tmp/linkdish-release-preflight.log`, `/tmp/linkdish-release-simulator.log`, `/tmp/linkdish-build37.log`, `/tmp/linkdish-submit37.log`. These are not durable repository artifacts and may contain operational details; do not publish full logs without review.

Final live production check: `/health` returned `{"ok":true}`; `/auth/config` returned `authMode=clerk_beta`, `clerkEnabled=true`, `emailCodeEnabled=true`. These endpoints are reachable, but do not prove every reviewer account or purchase flow works.

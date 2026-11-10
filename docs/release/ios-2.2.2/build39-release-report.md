# iPhone build 39 release preparation — November 10, 2026

## Binary and branch

- Version: **2.2.2 (39)**; bundle identifier `com.linkdish.app`.
- Expo/EAS project: `@linkdish/linkdish`; production API, Clerk and RevenueCat configuration verified by the release preflight/export checks. No server secret keys are included in the app.
- [EAS build](https://expo.dev/accounts/linkdish/projects/linkdish/builds/54291172-78e6-4031-876e-b1bf9d6d7ff2) completed with existing distribution signing credentials.
- [EAS submission](https://expo.dev/accounts/linkdish/projects/linkdish/submissions/0761b876-5c3f-42af-b300-b5fcebce4109) delivered the binary. App Store Connect shows build 39 processed, Ready to Submit, assigned to LinkDish Internal Testers and selected for version 2.2.2.
- The build was produced from `60af0d638381c380f49f5b4a37cc3abcf817fe76`; the subsequent rebase preserved the mobile code tree. Release-document/screenshot commits do not change the uploaded app.
- Mobile branch `codex/ios-approved-url-imports` / [draft PR #140](https://github.com/Robertg761/LinkDish/pull/140) remains **unmerged**. The original user checkout and its local drafts were preserved.

## Backend enforcement

[PR #141](https://github.com/Robertg761/LinkDish/pull/141) is merged and deployed. The dedicated `/extract/ios` route enforces the reviewed source policy through initial URL validation, every redirect, linked HTML fetches and the final returned source URL. It validates public network destinations, checks robots, disables browser/social/video fetchers and bypasses the general extraction cache. Remote website artwork is omitted. Unsupported initial URLs are rejected before billing/source access.

The existing `/extract` route remains for Android/web/older clients. This is not device attestation and does not prevent a modified client from calling another public route.

[PR #142](https://github.com/Robertg761/LinkDish/pull/142) fixes the approved publisher's deterministic parser: explicit title, ingredient and direction sections are accepted without inventing optional fields or relaxing other sites' thresholds. All seven PR checks passed; it is merged and deployed. Deploy API run 42783859445 passed staging verification, canary, promotion and production verification.

## Verification

- Mobile: 527 tests, TypeScript, lint, release preflight, production Hermes export and signed EAS archive passed.
- Backend enforcement: full repository validation and all seven PR checks passed; deployment passed staging, canary and production checks.
- Parser follow-up: 925 extractor tests, workspace types/lint, 109 Vercel handler tests and site checks passed locally. The full workspace run had one timing failure in the unchanged web CommandPalette test; its 16 tests passed on rerun. All seven CI checks passed.
- Simulator: unsupported URL rejection and Gemini consent verified using the new JavaScript bundle embedded in the unchanged native simulator shell. This is UI/flow evidence, not a test of the signed TestFlight archive. The simulator was signed out; reviewer account imports were not consumed.
- Production approved-link test passed: the simulator imported `https://publicdomainrecipes.com/basic-waffles/` with six published ingredients and seven directions, saved it, restarted the app, and reopened the persisted recipe. Remote website artwork was absent. The publisher itself mentions eggs in the directions without listing an egg quantity; LinkDish preserved the published text rather than inventing one.
- Production negative check passed after deployment: `/extract/ios` returned `unsupported_source` and `x-linkdish-source-policy: ios_public_domain_v1` for an unsupported URL, even with a spoofed Android platform header.

## Listing and screenshots

Both English (Canada) and English (U.S.) descriptions/promotional text and the reviewer notes now describe publicdomainrecipes.com-only iPhone link imports, owned/permitted text and photos, Gemini consent, omitted website artwork and Plus Monthly only. Existing reviewer credentials were preserved.

Ten 1206 × 2622 images were uploaded in both locales in `screenshots/upload-order.json` order. The first is a fresh capture of the build 39 import screen. The other nine are genuine build 38 captures of unchanged cookbook/cooking/shopping/planning UI. Raw captures and the renderer are included so the set can be reproduced. Apple preview confirms the revised first image. Header/search promotional artwork remains optional and empty.

Policies are already live and the approved iOS App Privacy labels published. The user explicitly confirmed Apple’s Content Rights declaration on November 10, 2026 and authorized submission. The declaration was saved. Version 2.2.2 (39), LinkDish Plus Monthly and LinkDish Subscriptions were submitted together and are all Waiting for Review. Manual release remains selected.

## Submission and remaining work

- [App Review submission](https://appstoreconnect.apple.com/apps/6826987838/distribution/reviewsubmissions/details/ab006edf-f1ff-4421-aef5-1a53c6f6f933): `ab006edf-f1ff-4421-aef5-1a53c6f6f933`, submitted November 10, 2026 at 12:51 AM Pacific by Flavio Herrera.
- Apple confirmed **3 Items Submitted**. The app 2.2.2 (39), Plus Monthly subscription and subscription group each show **Waiting for Review**.
- The user reported successful physical-device testing and explicitly confirmed the rights declaration for this restricted release. This records the user's declaration; it is not an independent legal guarantee or an Apple approval.
- Await Apple's review and address any feedback. If approved, manual release is still required; this submission does not automatically publish the app.
- Keep mobile PR #140 unmerged until the user authorizes integration. Backend PRs #141/#142 are separately merged/deployed. No additional app edits were made for submission.
- Additional publishers remain disabled until permission/licence evidence and extraction/redirect tests support enabling them.

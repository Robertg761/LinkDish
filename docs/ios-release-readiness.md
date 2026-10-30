# iOS release readiness — 2026-10-30

## Current production configuration

- Expo project: `@linkdish/linkdish`, ID `a2c1318c-39e0-45a3-a114-1f5e88288af1`.
- Bundle ID: `com.linkdish.app`; version `2.0.6`; next build `33`, synchronized in Expo config, native Info.plist, and Xcode project.
- EAS profile: `testflight`, production environment, store distribution, Release configuration, no development client.
- API: `https://api.linkdish.ca`. Live `/auth/config` returns `clerk_beta`, `clerkEnabled: true`, `emailCodeEnabled: true`; `/auth/session` is reachable.
- `apps/mobile/config/production-public-env.json` is the source for the production API, Clerk publishable key, Google client identifiers/callback scheme, and RevenueCat iOS public SDK key. No server credentials belong in this file.
- All six values were synchronized to the EAS production project environment and read back successfully. The native Google callback scheme matches. Production Clerk's Google web client also matches.
- TestFlight no longer overrides these values with staging/development settings. Local export loads the JSON directly; cloud builds use EAS variables and reject any mismatch with the JSON during post-install.
- Local `.env.local` matches the production API/public credentials, disables mocks, and enables the Apple sign-in button. Restart Metro after changing local environment variables.
- Apple sign-in is now enabled in the production Clerk public configuration, the release app, and the native entitlement. Provider setup still needs an actual device sign-in test.
- Mocks, household simulation, and local subscription previews are disabled for release.

## Verification on this configuration

- Four release-environment regression tests pass: local environment precedence, conflicting profile rejection, missing/stale EAS values, and prevention of server credentials in the public file.
- Mobile TypeScript and all 317 mobile tests pass. Release scripts pass Node syntax checks and Prettier; these scripts are excluded from the repository's ESLint configuration.
- Offline release preflight passes locally and with the variables read back from EAS production.
- A clean iOS/Hermes export succeeds. The resulting bundle contains the exact production API, Clerk publishable key, and RevenueCat iOS SDK key. No staging URL, checked debug controls, or detected server-credential patterns remain.
- An initial cached export retained older staging values. The export command now clears Metro's cache and checks the actual resulting bundle. The build command also clears the EAS build cache.
- Live release preflight now passes: production API/session availability, production Google client match, and Apple provider enabled. This is not proof of live Google/Apple sign-in, purchases, or session persistence; those require device testing.

## Remaining release work

1. Generate a fresh production build (next build 33) for device validation. Apple provider enablement is confirmed; no Clerk or Apple credentials were changed by this check.
2. On a physical device, verify Google and Apple sign-in, cancellation, persistence after relaunch, sign-out/relaunch, and account deletion. This custom UI does not collect additional signup fields or MFA; the Clerk configuration must be compatible or those flows need implementation.
3. Verify the RevenueCat key belongs to the intended iOS app, App Store products, Plus/Family entitlements, sandbox purchase, and restore. Key presence and embedding are verified; billing behavior is not.
4. Confirm the App Store Connect app/team record, standard versus custom EULA, privacy disclosures, screenshots, support/privacy URLs, and review access. The existing native privacy manifest requires a full SDK/backend data inventory before public submission.

No deployed backend changes, new signed production build, App Store submission, or tester distribution were performed during this configuration update. A new build is required to install these production settings.

## Commands from the repository root

```sh
corepack pnpm --filter @linkdish/mobile test:ios:release-env
corepack pnpm --filter @linkdish/mobile sync:ios:release-env
corepack pnpm --filter @linkdish/mobile export:ios:testflight
corepack pnpm --filter @linkdish/mobile check:ios:release
```

Edit `production-public-env.json` for future production public-value changes, then run the sync command. Do not reintroduce copies in `eas.json`. Local development uses `.env.local` separately. The sync command updates only public project variables in EAS production and never prints their values. The six synchronized public variables are plaintext because they are intentionally embedded in the app, not server secrets.

The live preflight passes. To generate the production candidate:

```sh
corepack pnpm --filter @linkdish/mobile build:ios:testflight
```

This command checks live configuration, synchronizes public values to EAS, and builds with a cleared cache. It does not submit to App Store Connect. EAS post-install also rejects stale cloud values. Increment the build number in `app.config.ts`, `ios/LinkDish/Info.plist`, and the Xcode project's `CURRENT_PROJECT_VERSION` before each later candidate; dynamic Expo config does not support the local EAS auto-increment used here.

## Previously verified staging build

[EAS build 32](https://expo.dev/accounts/linkdish/projects/linkdish/builds/757869e4-72b7-471c-ab78-315b80a504aa), version 2.0.6, finished successfully and passed local deep/strict signature verification. It uses staging and development Clerk and remains unchanged; it is not the new production configuration. It was signed for Apple team `73UT6LC439`, with TestFlight/Apple sign-in entitlements and `get-task-allow=false`, requiring iOS 17. Only camera/photo permissions remain. Builds 30 and 31 are superseded.

The preceding app preparation passed full repository validation (2,575 tests, lint, TypeScript, and site checks), 20/20 Expo Doctor checks, and CocoaPods synchronization. This included 317 mobile tests with mocked services and a successful live staging recipe import. Earlier fixes covered sign-in cancellation/session activation, sign-out revocation, sensitive auth logging, and privacy/support/subscription disclosures.

The runtime is Expo SDK 57, React Native 0.86.3, Hermes 250829098.0.17, Reanimated 4.5.1, and Worklets 0.10.1, resolving the SDK 56 Hermes memory regression described in [Expo's SDK 57 release notes](https://expo.dev/changelog/sdk-57). Android shares these dependencies and needs its own native rebuild/regression check before its next release.

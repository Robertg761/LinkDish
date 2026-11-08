# Privacy confirmation and policy publication dependency

The app already explicitly names **Google Gemini** and requires consent before real extraction. Denial fails closed; users can reopen AI data-sharing settings. The public policy at https://linkdish.ca/privacy/ must agree with the deployed service.

## Proposed factual policy text (owner must verify before publication)

> When you choose to import a recipe and allow AI processing, LinkDish sends the recipe content needed for that request through its servers to Google Gemini. Depending on the import method, this can include recipe text, content retrieved from a submitted URL, or a recipe image you select or capture. Gemini processes that content to return structured ingredients and cooking instructions. Review imported details for accuracy. You can review your AI data-sharing choice in the app's account settings.

Do **not** add promises about zero retention, no model training, deletion deadlines or geographic processing until the backend owner verifies the actual Google service, paid/free tier, project settings and contract. Specify any retained inputs/outputs and relevant deletion controls truthfully. Confirm whether raw uploaded media is transient or retained. Also reconcile analytics and diagnostic retention with deployed server behavior.

## App/SDK inventory supporting the saved ASC draft

| Data | Observed purpose | Draft label |
| --- | --- | --- |
| Name, email | Clerk account authentication/profile | Linked, app functionality, not tracking |
| User ID | Clerk/backend/RevenueCat account association | Linked, functionality + analytics, not tracking |
| Random installation/session IDs | First-party usage events and request correlation | Linked conservatively, functionality + analytics, not tracking |
| Purchase history | RevenueCat entitlement and subscription state | Linked, functionality + analytics, not tracking |
| Recipe text and selected photos/videos | Import/recipe processing and storage | Linked, functionality, not tracking |
| Support messages | Support workflow | Linked, functionality, not tracking |
| Product interaction | First-party screen/import/action analytics | Linked, functionality + analytics, not tracking |
| Crash/other diagnostics | First-party client_error reporting; app/device metadata | Linked conservatively, functionality, not tracking |

Sentry initialization in this repository is Android-only; don't assume it runs on iOS. RevenueCat's Apple privacy guide does not require location solely from locale/currency. No advertising ID or cross-app advertising tracking flow was found in the inspected iOS implementation; ATT was not added unnecessarily.

The eleven saved categories are Name, Email Address, Photos or Videos, Customer Support, Other User Content, User ID, Device ID, Purchase History, Product Interaction, Crash Data, Other Diagnostic Data. Review deployed provider behavior and any performance metrics before publishing. The native privacy manifest and App Store privacy labels are different declarations; the manifest's empty collected-data list is not proof of no collection.

Owner/backend team: verify the inventory, publish the updated public policy, then finalize/publish the ASC App Privacy draft. This task did not deploy the site or backend.

References:
- https://developer.apple.com/app-store/app-privacy-details/
- https://www.revenuecat.com/docs/platform-resources/apple-platform-resources/apple-app-privacy
- https://developer.apple.com/app-store/review/guidelines/

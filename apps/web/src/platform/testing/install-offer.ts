/**
 * Test-only (never imported by app code): the browser offering to install LinkDish, for tests
 * that render install UI next to the screen under test. Wrap the call in act() once UI is mounted.
 */

import { captureInstallPrompt, resetInstallPromptForTests } from "../install-prompt";

const quietMediaQuery = (query: string): MediaQueryList =>
  ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  }) as MediaQueryList;

/** Chrome's `beforeinstallprompt`, kept by the install store; the cook declines if it's shown. */
export const offerAppInstall = (): void => {
  // Suites that restore every mock after each test leave the setup's matchMedia stub answering
  // undefined, which the install store's standalone check can't read.
  if (!(window.matchMedia("(display-mode: standalone)") as MediaQueryList | undefined)) {
    window.matchMedia = quietMediaQuery;
  }

  captureInstallPrompt();
  resetInstallPromptForTests();

  const offer = new Event("beforeinstallprompt", { cancelable: true });
  Object.assign(offer, {
    prompt: () => Promise.resolve(),
    userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" })
  });
  window.dispatchEvent(offer);
};

// Increment when the provider or disclosed data use changes, so consent is requested again.
export const AI_CONSENT_STORAGE_KEY = "linkdish.aiConsent.gemini.v1";

export class AiConsentDeclinedError extends Error {
  constructor() {
    super(
      "Import canceled. Nothing was sent for AI processing. Allow Gemini processing to try again."
    );
    this.name = "AiConsentDeclinedError";
  }
}

type ConsentHandler = (review: boolean) => Promise<boolean>;
let handler: ConsentHandler | undefined;

export const registerAiConsentHandler = (next: ConsentHandler) => {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
};

export const reviewAiConsent = async (): Promise<void> => {
  await handler?.(true);
};

// Fail closed if the UI is unavailable. All real extraction requests go through this guard.
export const requireAiConsent = async (): Promise<void> => {
  if (!(await handler?.(false))) throw new AiConsentDeclinedError();
};

export const createAiConsentController = (dependencies: {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
  prompt: () => Promise<boolean>;
}) => {
  let pending: Promise<boolean> | undefined;
  // Preserve a denial in memory even if storage is unavailable.
  let choice: boolean | undefined;
  return (review = false): Promise<boolean> => {
    if (pending) return pending;
    pending = (async () => {
      if (!review) {
        if (choice === true) return true;
        if (choice === undefined) {
          const stored = await dependencies.read().catch(() => null);
          if (stored === "allowed") {
            choice = true;
            return true;
          }
        }
      }
      const allowed = await dependencies.prompt();
      choice = allowed;
      await dependencies.write(allowed ? "allowed" : "denied").catch(() => undefined);
      return allowed;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
};

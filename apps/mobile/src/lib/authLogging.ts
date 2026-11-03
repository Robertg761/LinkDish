/** Clerk errors can contain identity details. Keep their payloads out of release logs. */
export const logAuthWarning = (message: string, error: unknown): void => {
  if (process.env.NODE_ENV !== "production") {
    console.warn(message, error);
  }
};

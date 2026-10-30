interface ClerkFlowResult {
  createdSessionId: string | null;
  setActive?: (params: { session: string }) => Promise<void>;
  signIn?: { status: string | null };
  signUp?: { status: string | null };
}

/** A cancelled provider flow must not be treated as an authenticated account. */
export const activateClerkSignIn = async (result: ClerkFlowResult): Promise<boolean> => {
  if (!result.createdSessionId) {
    if (
      result.signUp?.status === "missing_requirements" ||
      result.signIn?.status === "needs_second_factor"
    ) {
      throw new Error("Additional verification is required to complete sign-in.");
    }
    return false;
  }

  if (!result.setActive) {
    throw new Error("The sign-in session could not be activated.");
  }

  await result.setActive({ session: result.createdSessionId });
  return true;
};

export const extractUrlFromSharedText = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  const match = value.match(/https?:\/\/[^\s<>"']+/iu);
  return match?.[0]?.replace(/[),.!?;:]+$/u, "");
};

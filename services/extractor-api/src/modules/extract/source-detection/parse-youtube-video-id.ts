export const parseYouTubeVideoId = (url: string): string | null => {
  const parsedUrl = new URL(url);

  if (parsedUrl.hostname.includes("youtu.be")) {
    return parsedUrl.pathname.replace("/", "") || null;
  }

  if (parsedUrl.pathname.startsWith("/shorts/")) {
    return parsedUrl.pathname.split("/")[2] ?? null;
  }

  return parsedUrl.searchParams.get("v");
};

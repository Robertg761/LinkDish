/* YouTube ids are 11 characters today; a little slack keeps odd-but-valid links working. */
const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{6,20}$/u;
/* /shorts/<id>, /embed/<id>, /live/<id> and the legacy /v/<id> all name one video. */
const youtubePathVideoIdPattern = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{6,20})(?:[/?#]|$)/u;

const asVideoId = (value: string | null | undefined): string | null =>
  value && youtubeVideoIdPattern.test(value) ? value : null;

/**
 * The video id of a YouTube watch, youtu.be, Shorts, embed or live link, or null. Callers
 * check the hostname first (see detectHostedMediaSourceType).
 */
export const parseYouTubeVideoId = (url: string): string | null => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (parsedUrl.hostname.toLowerCase().includes("youtu.be")) {
    return asVideoId(parsedUrl.pathname.split("/")[1]);
  }

  return (
    asVideoId(parsedUrl.searchParams.get("v")) ??
    asVideoId(youtubePathVideoIdPattern.exec(parsedUrl.pathname)?.[1])
  );
};

/** The canonical watch page for a video id; Shorts and embeds are fetched through it. */
export const toYouTubeWatchUrl = (videoId: string): string =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const INSET = 42;
const TEXT_X = 92;
const IMAGE_PANEL_WIDTH = 374;
const IMAGE_PANEL_GAP = 52;
const TITLE_MAX_LINES = 3;
const TITLE_LINE_HEIGHT = 76;
const FOOTER_TEXT = "Made with LinkDish · linkdish.ca";
const FOOTER_Y = CARD_HEIGHT - 82;

const COLORS = {
  accent: "#29443b",
  background: "#f4efe7",
  muted: "#6e685f"
};

export interface ShareCardDetails {
  imageUrl?: string | null;
  sourceHost?: string | null;
  sourceUrl?: string | null;
  title: string;
}

const getHost = ({ sourceHost, sourceUrl }: ShareCardDetails): string => {
  const host = sourceHost?.trim();

  if (host) {
    return host.replace(/^www\./i, "");
  }

  if (!sourceUrl) {
    return "";
  }

  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
};

const fitLineWithEllipsis = (
  context: CanvasRenderingContext2D,
  line: string,
  maxWidth: number
): string => {
  if (context.measureText(line).width <= maxWidth) {
    return line;
  }

  const ellipsis = "...";
  let fitted = line.trimEnd();

  while (fitted.length > 0 && context.measureText(`${fitted}${ellipsis}`).width > maxWidth) {
    fitted = fitted.slice(0, -1).trimEnd();
  }

  return fitted ? `${fitted}${ellipsis}` : ellipsis;
};

const wrapTitle = (
  context: CanvasRenderingContext2D,
  title: string,
  maxWidth: number,
  maxLines: number
): string[] => {
  const words = title.trim().split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let currentLine = "";

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];

    if (!word) {
      continue;
    }

    const candidate = currentLine ? `${currentLine} ${word}` : word;

    if (context.measureText(candidate).width <= maxWidth || !currentLine) {
      currentLine = candidate;
      continue;
    }

    if (lines.length === maxLines - 1) {
      lines.push(
        fitLineWithEllipsis(context, [currentLine, ...words.slice(index)].join(" "), maxWidth)
      );
      return lines;
    }

    lines.push(fitLineWithEllipsis(context, currentLine, maxWidth));
    currentLine = word;
  }

  if (lines.length < maxLines && currentLine) {
    lines.push(fitLineWithEllipsis(context, currentLine, maxWidth));
  }

  return lines.length > 0 ? lines : ["Untitled recipe"];
};

const get2dContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Canvas 2D context is not available.");
  }

  return context;
};

const drawImageCover = (
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number
): void => {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const targetRatio = width / height;
  const sourceRatio = sourceWidth / sourceHeight;
  const cropWidth = sourceRatio > targetRatio ? sourceHeight * targetRatio : sourceWidth;
  const cropHeight = sourceRatio > targetRatio ? sourceHeight : sourceWidth / targetRatio;
  const cropX = (sourceWidth - cropWidth) / 2;
  const cropY = (sourceHeight - cropHeight) / 2;

  context.drawImage(image, cropX, cropY, cropWidth, cropHeight, x, y, width, height);
};

const loadShareCardImage = (imageUrl: string | null | undefined): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    if (!imageUrl) {
      resolve(null);
      return;
    }

    let settled = false;
    const image = new Image();
    const fallbackTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 2500);
    const finish = (loadedImage: HTMLImageElement | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(fallbackTimer);
      resolve(loadedImage);
    };

    image.crossOrigin = "anonymous";
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    image.src = imageUrl;
  });

const loadShareCardFonts = async (): Promise<void> => {
  try {
    await Promise.all([
      document.fonts?.load("600 64px Fraunces"),
      document.fonts?.load("600 italic 34px Fraunces")
    ]);
  } catch {
    // Canvas falls back to Georgia if the display face is not ready.
  }
};

export const drawShareCard = (
  details: ShareCardDetails,
  image: HTMLImageElement | null = null
): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;

  const context = get2dContext(canvas);
  const host = getHost(details);
  const hasImage = Boolean(
    image && (image.naturalWidth || image.width) && (image.naturalHeight || image.height)
  );
  const textX = hasImage ? INSET + IMAGE_PANEL_WIDTH + IMAGE_PANEL_GAP : TEXT_X;
  const textMaxWidth = hasImage
    ? CARD_WIDTH - textX - INSET - 54
    : CARD_WIDTH - INSET * 2 - 100;

  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.strokeStyle = COLORS.accent;
  context.lineWidth = 3;
  context.strokeRect(INSET, INSET, CARD_WIDTH - INSET * 2, CARD_HEIGHT - INSET * 2);

  if (hasImage && image) {
    drawImageCover(context, image, INSET, INSET, IMAGE_PANEL_WIDTH, CARD_HEIGHT - INSET * 2);

    context.fillStyle = "rgba(244, 239, 231, 0.16)";
    context.fillRect(INSET, INSET, IMAGE_PANEL_WIDTH, CARD_HEIGHT - INSET * 2);
  }

  context.fillStyle = COLORS.accent;
  context.font = "700 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillText("LINKDISH", textX, 94);

  context.font = "600 64px Fraunces, Georgia, Cambria, 'Times New Roman', serif";
  const titleLines = wrapTitle(context, details.title, textMaxWidth, TITLE_MAX_LINES);
  let titleY = 178;

  for (const line of titleLines) {
    context.fillText(line, textX, titleY);
    titleY += TITLE_LINE_HEIGHT;
  }

  if (host) {
    context.fillStyle = COLORS.muted;
    context.font = "28px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    context.fillText(host, textX, titleY + 18);
  }

  context.fillStyle = COLORS.accent;
  context.font = "600 italic 34px Fraunces, Georgia, Cambria, 'Times New Roman', serif";
  context.textAlign = "right";
  context.textBaseline = "alphabetic";
  context.fillText("Get cooking.", CARD_WIDTH - 92, FOOTER_Y);

  context.fillStyle = COLORS.muted;
  context.font = "22px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  context.textAlign = "left";
  context.fillText(FOOTER_TEXT, textX, FOOTER_Y);

  return canvas;
};

export const toBlob = (
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number
): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not export share card."));
      },
      type,
      quality
    );
  });

export const createShareCardBlob = async (details: ShareCardDetails): Promise<Blob> => {
  await loadShareCardFonts();
  const image = await loadShareCardImage(details.imageUrl);
  return toBlob(drawShareCard(details, image));
};

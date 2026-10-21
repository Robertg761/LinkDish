import { FallbackProviderError } from "../../fallback/errors.js";

import {
  buildVideoRecipePrompt,
  videoRecipeJsonSchema,
  videoRecipePayloadSchema
} from "./video-recipe-payload.js";

import type { VideoRecipeContext, VideoRecipePayload } from "./video-recipe-payload.js";
import type { RequestDeadline } from "../../deadline.js";

/*
 * Gemini watches the video (frames and audio) and answers in the evidence-carrying shape of
 * video-recipe-payload.ts. YouTube videos are passed by URL and Google fetches them itself; other
 * videos (TikTok) are sent as bytes: inline when small, through the Files API otherwise.
 */
export type VideoRecipeSource =
  | { kind: "youtube"; url: string }
  | { kind: "file"; bytes: Uint8Array<ArrayBuffer>; mimeType: string };

export interface VideoRecipeReadInput {
  source: VideoRecipeSource;
  context: VideoRecipeContext;
  deadline?: RequestDeadline | undefined;
}

export interface VideoRecipeReader {
  readonly available: boolean;
  readonly model: string | null;
  /** Gemini's reading, or null when it gave no usable answer. */
  read(input: VideoRecipeReadInput): Promise<VideoRecipePayload | null>;
}

const apiBase = "https://generativelanguage.googleapis.com";
/* Inline request bodies must stay under 20 MB, and base64 adds a third. */
const maxInlineBytes = 14 * 1024 * 1024;
const fileActivePollMs = 1_000;
/* Deleting an uploaded video waits this long at most, whatever happened to the read. */
const fileDeleteTimeoutMs = 3_000;
/* Time kept back for checking and returning the recipe once Gemini answers. */
const responseReserveMs = 1_500;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toProviderError = async (
  response: Response,
  step: string
): Promise<FallbackProviderError> => {
  await response.body?.cancel().catch(() => undefined);

  return response.status === 429
    ? new FallbackProviderError(`Gemini video ${step} quota exceeded.`, "quota_exceeded")
    : new FallbackProviderError(
        `Gemini video ${step} failed with ${response.status}.`,
        "fallback_failed"
      );
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true }
    );
  });

class GeminiVideoRecipeReader implements VideoRecipeReader {
  public readonly available = true;

  public constructor(
    private readonly apiKey: string,
    public readonly model: string,
    private readonly fetchImplementation: typeof fetch,
    private readonly timeoutMs: number
  ) {}

  /*
   * Uploads a large video and waits until Gemini has processed it. onUploaded gets the file's
   * name as soon as Gemini has it, so the caller can delete it whatever happens next.
   */
  private async uploadFile(
    bytes: Uint8Array<ArrayBuffer>,
    mimeType: string,
    signal: AbortSignal,
    onUploaded: (name: string) => void
  ): Promise<{ fileUri: string; mimeType: string }> {
    const start = await this.fetchImplementation(`${apiBase}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": this.apiKey,
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(bytes.byteLength),
        "x-goog-upload-header-content-type": mimeType
      },
      body: JSON.stringify({ file: { display_name: "linkdish-recipe-video" } }),
      signal
    });

    if (!start.ok) {
      throw await toProviderError(start, "upload");
    }

    const uploadUrl = start.headers.get("x-goog-upload-url");
    await start.body?.cancel().catch(() => undefined);

    if (!uploadUrl?.startsWith(`${apiBase}/`)) {
      throw new FallbackProviderError("Gemini did not return an upload URL.", "fallback_failed");
    }

    const upload = await this.fetchImplementation(uploadUrl, {
      method: "POST",
      headers: {
        "content-length": String(bytes.byteLength),
        "x-goog-upload-offset": "0",
        "x-goog-upload-command": "upload, finalize"
      },
      body: new Blob([bytes], { type: mimeType }),
      signal
    });

    if (!upload.ok) {
      throw await toProviderError(upload, "upload");
    }

    let file = ((await upload.json()) as { file?: unknown }).file;

    if (isRecord(file) && typeof file.name === "string") {
      onUploaded(file.name);
    }

    for (;;) {
      if (!isRecord(file) || typeof file.name !== "string" || typeof file.uri !== "string") {
        throw new FallbackProviderError("Gemini returned no uploaded file.", "fallback_failed");
      }

      if (file.state === "ACTIVE") {
        return { fileUri: file.uri, mimeType };
      }

      if (file.state === "FAILED") {
        throw new FallbackProviderError("Gemini could not process the video.", "fallback_failed");
      }

      await sleep(fileActivePollMs, signal);

      const status = await this.fetchImplementation(`${apiBase}/v1beta/${file.name}`, {
        headers: { "x-goog-api-key": this.apiKey },
        signal
      });

      if (!status.ok) {
        throw await toProviderError(status, "upload status");
      }

      file = await status.json();
    }
  }

  /*
   * Gemini keeps an uploaded video for 48 hours unless it is deleted. Best effort: a failed
   * delete is logged and the file expires on its own.
   */
  private async deleteFile(name: string): Promise<void> {
    try {
      const response = await this.fetchImplementation(`${apiBase}/v1beta/${name}`, {
        method: "DELETE",
        headers: { "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(fileDeleteTimeoutMs)
      });

      await response.body?.cancel().catch(() => undefined);

      if (!response.ok) {
        throw new Error(`Gemini file delete failed with ${response.status}.`);
      }
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "video_recipe_file_delete_failed",
          message: error instanceof Error ? error.message : "unknown"
        })
      );
    }
  }

  private async videoPart(
    source: VideoRecipeSource,
    signal: AbortSignal,
    onUploaded: (name: string) => void
  ) {
    if (source.kind === "youtube") {
      return { fileData: { fileUri: source.url } };
    }

    if (source.bytes.byteLength <= maxInlineBytes) {
      return {
        inlineData: {
          mimeType: source.mimeType,
          data: Buffer.from(source.bytes).toString("base64")
        }
      };
    }

    return {
      fileData: await this.uploadFile(source.bytes, source.mimeType, signal, onUploaded)
    };
  }

  public async read(input: VideoRecipeReadInput): Promise<VideoRecipePayload | null> {
    const timeoutMs = input.deadline
      ? input.deadline.budgetMs(this.timeoutMs, responseReserveMs)
      : this.timeoutMs;

    if (timeoutMs <= 0) {
      throw new FallbackProviderError(
        "Not enough request time left to read the video.",
        "fallback_failed"
      );
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new DOMException("Gemini video read timed out.", "TimeoutError")),
      timeoutMs
    );
    const abortFromDeadline = () => controller.abort(input.deadline?.signal.reason);

    if (input.deadline?.signal.aborted) {
      abortFromDeadline();
    } else {
      input.deadline?.signal.addEventListener("abort", abortFromDeadline, { once: true });
    }

    let uploadedFileName: string | null = null;

    try {
      const videoPart = await this.videoPart(input.source, controller.signal, (name) => {
        uploadedFileName = name;
      });
      const response = await this.fetchImplementation(
        `${apiBase}/v1beta/models/${this.model}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [videoPart, { text: buildVideoRecipePrompt(input.context) }]
              }
            ],
            generationConfig: {
              ...(this.model.startsWith("gemini-2") ? { temperature: 0 } : {}),
              ...(this.model.startsWith("gemini-3")
                ? { thinkingConfig: { thinkingLevel: "low" } }
                : {}),
              mediaResolution: "MEDIA_RESOLUTION_LOW",
              responseMimeType: "application/json",
              responseJsonSchema: videoRecipeJsonSchema
            }
          })
        }
      );

      if (!response.ok) {
        throw await toProviderError(response, "read");
      }

      const body = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      };
      const text = body.candidates?.[0]?.content?.parts
        ?.filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text)
        .join("");

      if (!text) {
        return null;
      }

      let json: unknown;

      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }

      const parsed = videoRecipePayloadSchema.safeParse(json);
      return parsed.success ? parsed.data : null;
    } finally {
      clearTimeout(timeoutId);
      input.deadline?.signal.removeEventListener("abort", abortFromDeadline);

      if (uploadedFileName) {
        await this.deleteFile(uploadedFileName);
      }
    }
  }
}

class UnavailableVideoRecipeReader implements VideoRecipeReader {
  public readonly available = false;
  public readonly model = null;

  public read(): Promise<null> {
    return Promise.resolve(null);
  }
}

export const createGeminiVideoRecipeReader = (options: {
  enabled: boolean;
  apiKey: string | undefined;
  model: string;
  fetchImplementation: typeof fetch;
  timeoutMs: number;
}): VideoRecipeReader =>
  options.enabled && options.apiKey
    ? new GeminiVideoRecipeReader(
        options.apiKey,
        options.model,
        options.fetchImplementation,
        options.timeoutMs
      )
    : new UnavailableVideoRecipeReader();

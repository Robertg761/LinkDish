/**
 * A minimal, read-only ZIP reader for recipe exports (Paprika's .paprikarecipes and Mela's
 * .melarecipes are ZIP archives). It reads the central directory, supports stored and deflated
 * entries (including ZIP64 sizes), and inflates with the browser's DecompressionStream — no
 * dependencies. Decompression is capped so a malicious "zip bomb" can't exhaust memory.
 */
import { DataTransferError } from "./errors";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

export const ZIP_METHOD_STORED = 0;
export const ZIP_METHOD_DEFLATE = 8;

/** Default cap for one decompressed entry (a recipe with an embedded photo is a few MB). */
export const DEFAULT_MAX_ENTRY_BYTES = 48 * 1024 * 1024;
export const DEFAULT_MAX_ZIP_ENTRIES = 10_000;

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; anything else is unsupported. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  encrypted: boolean;
  isDirectory: boolean;
}

const corrupt = (): DataTransferError => new DataTransferError("corrupt_file");

const readUint16 = (view: DataView, offset: number): number => {
  if (offset < 0 || offset + 2 > view.byteLength) {
    throw corrupt();
  }

  return view.getUint16(offset, true);
};

const readUint32 = (view: DataView, offset: number): number => {
  if (offset < 0 || offset + 4 > view.byteLength) {
    throw corrupt();
  }

  return view.getUint32(offset, true);
};

const readUint64 = (view: DataView, offset: number): number => {
  const low = readUint32(view, offset);
  const high = readUint32(view, offset + 4);
  const value = high * 0x1_0000_0000 + low;

  if (!Number.isSafeInteger(value)) {
    throw new DataTransferError("file_too_large");
  }

  return value;
};

const toBytes = (data: ArrayBuffer | Uint8Array): Uint8Array =>
  data instanceof Uint8Array ? data : new Uint8Array(data);

const viewOf = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** True when the data starts like a ZIP archive (a local file header or an empty archive). */
export const isZipData = (data: ArrayBuffer | Uint8Array): boolean => {
  const bytes = toBytes(data);

  if (bytes.length < 4) {
    return false;
  }

  const signature = viewOf(bytes).getUint32(0, true);
  return (
    signature === LOCAL_FILE_HEADER_SIGNATURE || signature === END_OF_CENTRAL_DIRECTORY_SIGNATURE
  );
};

/** True when the data starts with the gzip magic bytes. */
export const isGzipData = (data: ArrayBuffer | Uint8Array): boolean => {
  const bytes = toBytes(data);
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
};

const findEndOfCentralDirectory = (view: DataView): number => {
  const last = view.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE;
  const first = Math.max(0, last - MAX_COMMENT_LENGTH);
  let fallback: number | null = null;

  for (let offset = last; offset >= first; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }

    // The real record's comment runs exactly to the end of the file. The signature can also turn
    // up inside that comment, which would read comment bytes as the directory.
    const commentLength = view.getUint16(offset + 20, true);

    if (offset + END_OF_CENTRAL_DIRECTORY_SIZE + commentLength === view.byteLength) {
      return offset;
    }

    // Some tools leave bytes after the record that it doesn't count: use the last signature
    // when no record fits exactly.
    fallback ??= offset;
  }

  if (fallback == null) {
    throw corrupt();
  }

  return fallback;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const latin1Decoder = new TextDecoder("latin1");

const decodeName = (bytes: Uint8Array): string => {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    // Old archivers wrote names in a legacy code page; latin1 keeps them readable enough.
    return latin1Decoder.decode(bytes);
  }
};

interface Zip64Sizes {
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const readZip64Extra = (
  view: DataView,
  start: number,
  length: number,
  current: Zip64Sizes
): Zip64Sizes => {
  let offset = start;
  const end = start + length;

  while (offset + 4 <= end) {
    const id = readUint16(view, offset);
    const size = readUint16(view, offset + 2);
    let cursor = offset + 4;

    if (id === ZIP64_EXTRA_FIELD_ID) {
      const next = { ...current };
      // The ZIP64 field lists only the values whose 32-bit slots were saturated, in this order.
      if (current.uncompressedSize === UINT32_MAX) {
        next.uncompressedSize = readUint64(view, cursor);
        cursor += 8;
      }

      if (current.compressedSize === UINT32_MAX) {
        next.compressedSize = readUint64(view, cursor);
        cursor += 8;
      }

      if (current.localHeaderOffset === UINT32_MAX) {
        next.localHeaderOffset = readUint64(view, cursor);
      }

      return next;
    }

    offset += 4 + size;
  }

  return current;
};

/**
 * Lists the entries of a ZIP archive from its central directory. Throws a
 * {@link DataTransferError} ("corrupt_file") when the archive can't be read.
 */
export const listZipEntries = (
  data: ArrayBuffer | Uint8Array,
  options: { maxEntries?: number | undefined } = {}
): ZipEntry[] => {
  const bytes = toBytes(data);
  const view = viewOf(bytes);

  if (bytes.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw corrupt();
  }

  const eocd = findEndOfCentralDirectory(view);
  let entryCount = readUint16(view, eocd + 10);
  let directoryOffset = readUint32(view, eocd + 16);

  if (entryCount === UINT16_MAX || directoryOffset === UINT32_MAX) {
    const locator = eocd - 20;

    if (locator >= 0 && readUint32(view, locator) === ZIP64_LOCATOR_SIGNATURE) {
      const zip64Record = readUint64(view, locator + 8);

      if (readUint32(view, zip64Record) !== ZIP64_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
        throw corrupt();
      }

      entryCount = readUint64(view, zip64Record + 32);
      directoryOffset = readUint64(view, zip64Record + 48);
    }
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ZIP_ENTRIES;

  if (entryCount > maxEntries) {
    throw new DataTransferError(
      "file_too_large",
      `That export has more than ${maxEntries.toLocaleString("en-US")} files in it. Try exporting fewer recipes at a time.`
    );
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readUint32(view, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw corrupt();
    }

    const flags = readUint16(view, offset + 8);
    const method = readUint16(view, offset + 10);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const nameStart = offset + 46;

    if (nameStart + nameLength + extraLength > bytes.length) {
      throw corrupt();
    }

    const name = decodeName(bytes.subarray(nameStart, nameStart + nameLength));
    const sizes = readZip64Extra(view, nameStart + nameLength, extraLength, {
      compressedSize: readUint32(view, offset + 20),
      uncompressedSize: readUint32(view, offset + 24),
      localHeaderOffset: readUint32(view, offset + 42)
    });

    entries.push({
      name,
      method,
      ...sizes,
      encrypted: (flags & 0x1) === 0x1,
      isDirectory: name.endsWith("/")
    });

    offset = nameStart + nameLength + extraLength + commentLength;
  }

  return entries;
};

/** Whether this browser can decompress the given format with DecompressionStream. */
export const canDecompress = (format: "gzip" | "deflate-raw"): boolean => {
  if (typeof DecompressionStream === "undefined") {
    return false;
  }

  try {
    new DecompressionStream(format as CompressionFormat);
    return true;
  } catch {
    return false;
  }
};

const concatChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
};

/** Streams `bytes` through a DecompressionStream, stopping once `maxBytes` would be exceeded. */
const decompress = async (
  bytes: Uint8Array,
  format: "gzip" | "deflate-raw",
  maxBytes: number
): Promise<Uint8Array> => {
  if (!canDecompress(format)) {
    throw new DataTransferError("unsupported_browser");
  }

  const stream = new DecompressionStream(format as CompressionFormat);
  const writer = stream.writable.getWriter();
  // Errors surface on the readable side too; these would otherwise be unhandled rejections.
  writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  writer.close().catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      total += value.length;

      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new DataTransferError("file_too_large");
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof DataTransferError) {
      throw error;
    }

    throw corrupt();
  }

  return concatChunks(chunks, total);
};

export const gunzip = (
  data: ArrayBuffer | Uint8Array,
  options: { maxBytes?: number | undefined } = {}
): Promise<Uint8Array> =>
  decompress(toBytes(data), "gzip", options.maxBytes ?? DEFAULT_MAX_ENTRY_BYTES);

export const inflateRaw = (
  data: ArrayBuffer | Uint8Array,
  options: { maxBytes?: number | undefined } = {}
): Promise<Uint8Array> =>
  decompress(toBytes(data), "deflate-raw", options.maxBytes ?? DEFAULT_MAX_ENTRY_BYTES);

/** The (decompressed) contents of one entry. */
export const readZipEntry = async (
  data: ArrayBuffer | Uint8Array,
  entry: ZipEntry,
  options: { maxBytes?: number | undefined } = {}
): Promise<Uint8Array> => {
  const bytes = toBytes(data);
  const view = viewOf(bytes);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ENTRY_BYTES;

  if (entry.encrypted) {
    throw new DataTransferError("password_protected");
  }

  if (readUint32(view, entry.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw corrupt();
  }

  const nameLength = readUint16(view, entry.localHeaderOffset + 26);
  const extraLength = readUint16(view, entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;

  if (end > bytes.length) {
    throw corrupt();
  }

  const compressed = bytes.subarray(start, end);

  if (entry.method === ZIP_METHOD_STORED) {
    if (compressed.length > maxBytes) {
      throw new DataTransferError("file_too_large");
    }

    return compressed;
  }

  if (entry.method === ZIP_METHOD_DEFLATE) {
    return inflateRaw(compressed, { maxBytes });
  }

  throw new DataTransferError(
    "unsupported_file",
    "That export uses a compression method LinkDish can't open. Export it again from the app."
  );
};

/** macOS "Compress" adds resource-fork files that are never recipes. */
export const isJunkZipEntry = (entry: ZipEntry): boolean => {
  const baseName = entry.name.split("/").pop() ?? "";
  return (
    entry.isDirectory ||
    entry.name.startsWith("__MACOSX/") ||
    baseName.startsWith("._") ||
    baseName === ".DS_Store"
  );
};

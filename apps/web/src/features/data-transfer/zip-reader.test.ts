import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTransferError } from "./errors";
import { buildZip, compressBytes, jsonBytes, utf8Bytes } from "./testing/zip-fixtures";
import {
  canDecompress,
  gunzip,
  isGzipData,
  isJunkZipEntry,
  isZipData,
  listZipEntries,
  readZipEntry
} from "./zip-reader";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("zip reader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists and reads stored and deflated entries", async () => {
    const soup = "Tomato soup ".repeat(200);
    const zip = await buildZip([
      { name: "stored.txt", data: utf8Bytes("plain text"), method: "store" },
      { name: "nested/deflated.txt", data: utf8Bytes(soup), method: "deflate" },
      { name: "Crème brûlée.json", data: jsonBytes({ ok: true }), method: "deflate" }
    ]);

    expect(isZipData(zip)).toBe(true);
    const entries = listZipEntries(zip);

    expect(entries.map((entry) => [entry.name, entry.method])).toEqual([
      ["stored.txt", 0],
      ["nested/deflated.txt", 8],
      ["Crème brûlée.json", 8]
    ]);
    expect(entries[1]?.compressedSize).toBeLessThan(entries[1]?.uncompressedSize ?? 0);
    expect(decode(await readZipEntry(zip, entries[0]!))).toBe("plain text");
    expect(decode(await readZipEntry(zip, entries[1]!))).toBe(soup);
    expect(JSON.parse(decode(await readZipEntry(zip, entries[2]!)))).toEqual({ ok: true });
  });

  it("finds the directory behind an archive comment", async () => {
    const zip = await buildZip([{ name: "a.txt", data: utf8Bytes("A") }]);
    const comment = utf8Bytes("exported by a very chatty app");
    const withComment = new Uint8Array(zip.length + comment.length);
    withComment.set(zip);
    withComment.set(comment, zip.length);
    new DataView(withComment.buffer).setUint16(zip.length - 2, comment.length, true);

    expect(listZipEntries(withComment).map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("recognizes gzip data and unpacks it", async () => {
    const gz = await compressBytes(utf8Bytes("hello"), "gzip");

    expect(isGzipData(gz)).toBe(true);
    expect(isZipData(gz)).toBe(false);
    expect(decode(await gunzip(gz))).toBe("hello");
  });

  it("rejects damaged archives with a friendly error", async () => {
    const zip = await buildZip([{ name: "a.txt", data: utf8Bytes("A"), method: "deflate" }]);

    expect(() => listZipEntries(zip.slice(0, zip.length - 30))).toThrow(DataTransferError);

    const entry = listZipEntries(zip)[0]!;
    const broken = zip.slice();
    broken.fill(0xff, 30 + entry.name.length, 30 + entry.name.length + entry.compressedSize);
    await expect(readZipEntry(broken, entry)).rejects.toMatchObject({ code: "corrupt_file" });
    await expect(gunzip(utf8Bytes("not gzip at all"))).rejects.toMatchObject({
      code: "corrupt_file"
    });
  });

  it("refuses password-protected entries", async () => {
    const zip = await buildZip([{ name: "secret.json", data: utf8Bytes("{}"), encrypted: true }]);
    const [entry] = listZipEntries(zip);

    expect(entry?.encrypted).toBe(true);
    await expect(readZipEntry(zip, entry!)).rejects.toMatchObject({ code: "password_protected" });
  });

  it("stops decompressing at the size cap (zip bombs)", async () => {
    const zip = await buildZip([
      { name: "bomb.txt", data: new Uint8Array(200_000), method: "deflate" }
    ]);
    const [entry] = listZipEntries(zip);

    await expect(readZipEntry(zip, entry!, { maxBytes: 50_000 })).rejects.toMatchObject({
      code: "file_too_large"
    });
  });

  it("caps the number of entries", async () => {
    const zip = await buildZip([
      { name: "1.json", data: utf8Bytes("{}") },
      { name: "2.json", data: utf8Bytes("{}") }
    ]);

    expect(() => listZipEntries(zip, { maxEntries: 1 })).toThrow(/more than 1 files/u);
  });

  it("explains when the browser can't decompress", async () => {
    vi.stubGlobal("DecompressionStream", undefined);

    expect(canDecompress("gzip")).toBe(false);
    await expect(gunzip(new Uint8Array([0x1f, 0x8b, 0]))).rejects.toMatchObject({
      code: "unsupported_browser"
    });
  });

  it("skips macOS metadata entries", () => {
    const entry = (name: string) => ({
      name,
      method: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      localHeaderOffset: 0,
      encrypted: false,
      isDirectory: name.endsWith("/")
    });

    expect(isJunkZipEntry(entry("__MACOSX/._Soup.paprikarecipe"))).toBe(true);
    expect(isJunkZipEntry(entry("recipes/._Soup.paprikarecipe"))).toBe(true);
    expect(isJunkZipEntry(entry("recipes/"))).toBe(true);
    expect(isJunkZipEntry(entry(".DS_Store"))).toBe(true);
    expect(isJunkZipEntry(entry("Soup.paprikarecipe"))).toBe(false);
  });
});

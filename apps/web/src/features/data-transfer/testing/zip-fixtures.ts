/**
 * Test-only builders for ZIP/gzip fixtures (never imported by app code). Archives are built in
 * memory with CompressionStream, so tests cover real deflate-raw and gzip data.
 */

const encoder = new TextEncoder();

export const utf8Bytes = (text: string): Uint8Array => encoder.encode(text);

export const jsonBytes = (value: unknown): Uint8Array => utf8Bytes(JSON.stringify(value));

export async function compressBytes(
  bytes: Uint8Array,
  format: "gzip" | "deflate-raw"
): Promise<Uint8Array> {
  const stream = new CompressionStream(format as CompressionFormat);
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>);
  void writer.close();
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    total += value.length;
  }

  const output = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;

  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

export interface ZipFixtureEntry {
  name: string;
  data: Uint8Array;
  method?: "store" | "deflate" | undefined;
  /** Sets the "encrypted" flag (the data is left as-is). */
  encrypted?: boolean | undefined;
}

/** A standards-shaped ZIP archive (local headers, central directory, end record). */
export async function buildZip(entries: readonly ZipFixtureEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8Bytes(entry.name);
    const deflate = entry.method !== "store";
    const payload = deflate ? await compressBytes(entry.data, "deflate-raw") : entry.data;
    const crc = crc32(entry.data);
    const flags = 0x0800 | (entry.encrypted ? 0x1 : 0);

    const local = new Uint8Array(30 + name.length + payload.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, deflate ? 8 : 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, payload.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(payload, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, deflate ? 8 : 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, payload.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const directorySize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;

  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }

  return output;
}

/** One recipe as Paprika writes it inside a .paprikarecipes archive. */
export const paprikaRecipe = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  uid: "9C1A4F10-1111-4B6E-9A2B-000000000001",
  name: "Weeknight Tomato Soup",
  ingredients: "2 Tbsp olive oil\n1 onion, chopped\n1 (28-ounce) can tomatoes\n2 cups stock",
  directions:
    "Soften the onion in the oil.\nAdd the tomatoes and stock and simmer 20 minutes.\nBlend until smooth.",
  servings: "4",
  prep_time: "10 min",
  cook_time: "25 min",
  source: "Serious Eats",
  source_url: "https://www.seriouseats.com/weeknight-tomato-soup",
  notes: "Add a pinch of sugar if the tomatoes are sharp.",
  categories: ["Soup", "Weeknight"],
  rating: 4,
  on_favorites: 1,
  created: "2024-02-03 18:22:11",
  photo_data: "",
  ...overrides
});

/** A Paprika export: every recipe gzip-compressed, then zipped. */
export async function buildPaprikaExport(
  recipes: ReadonlyArray<Record<string, unknown>>,
  options: { method?: "store" | "deflate" | undefined } = {}
): Promise<Uint8Array> {
  const entries: ZipFixtureEntry[] = [];

  for (const recipe of recipes) {
    entries.push({
      name: `${String(recipe.name)}.paprikarecipe`,
      data: await compressBytes(jsonBytes(recipe), "gzip"),
      method: options.method ?? "store"
    });
  }

  return buildZip(entries);
}

/** One Mela recipe (.melarecipe JSON). */
export const melaRecipe = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "mela-1",
  title: "Lemon Ricotta Pancakes",
  text: "Fluffy and bright.",
  ingredients: "# Batter\n1 cup ricotta\n2 eggs\n1 lemon, zested\n3/4 cup flour",
  instructions: "Whisk the ricotta, eggs and zest.\nFold in the flour.\nCook in a buttered pan.",
  yield: "8 pancakes",
  prepTime: "10 min",
  cookTime: "15 min",
  link: "",
  notes: "Great with blueberries.",
  categories: ["Breakfast"],
  favorite: true,
  images: [],
  ...overrides
});

/** The bytes of a File-like object for tests (jsdom's File lacks arrayBuffer()). */
export const fileFromBytes = (bytes: Uint8Array, name: string, type = ""): File =>
  new File([bytes as Uint8Array<ArrayBuffer>], name, { type });

/**
 * A File that claims to be `size` bytes long without holding them, for size checks that must run
 * before anything is read. `arrayBuffer` replaces the File's own; leave it out to take the
 * FileReader path older browsers use.
 */
export const fileOfSize = (
  name: string,
  size: number,
  arrayBuffer?: () => Promise<ArrayBuffer>
): File => {
  const file = new File([], name);
  Object.defineProperty(file, "size", { value: size });
  Object.defineProperty(file, "arrayBuffer", { value: arrayBuffer });
  return file;
};

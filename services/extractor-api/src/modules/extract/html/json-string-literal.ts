/**
 * Reads the JSON string literal whose opening quote is at `quoteIndex` in a larger blob (an
 * inline player response or app state), without parsing the whole blob. Linear scan; returns
 * null for an unterminated or invalid literal.
 */
export const readJsonStringLiteral = (source: string, quoteIndex: number): string | null => {
  if (source[quoteIndex] !== '"') {
    return null;
  }

  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const character = source[index];

    if (character === "\\") {
      index += 1;
      continue;
    }

    if (character === '"') {
      try {
        return JSON.parse(source.slice(quoteIndex, index + 1)) as string;
      } catch {
        return null;
      }
    }
  }

  return null;
};

/** Every string value that follows `"key":"` in a blob, in order (at most `limit`). */
export const findJsonStringValues = (source: string, key: string, limit = 50): string[] => {
  const marker = `"${key}":"`;
  const values: string[] = [];
  let index = source.indexOf(marker);
  /* Each attempt can scan to the end of an unterminated literal, so attempts are bounded too. */
  let attempts = 0;

  while (index !== -1 && values.length < limit && attempts < limit * 2) {
    attempts += 1;
    const value = readJsonStringLiteral(source, index + marker.length - 1);

    if (value !== null) {
      values.push(value);
    }

    index = source.indexOf(marker, index + marker.length);
  }

  return values;
};

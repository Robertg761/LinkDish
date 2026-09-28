import { describe, expect, it } from "vitest";

import { htmlFragmentToLines, htmlFragmentToText } from "./html-text";

const TAG_OPENER = /<[!/?A-Za-z]/u;
const HOSTILE = 100_000;

/** Fastest of three runs: a GC pause cannot fail the check, and quadratic work never is fast. */
const fastestMilliseconds = (run: () => unknown): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      run();
      return performance.now() - started;
    })
  );

describe("htmlFragmentToText", () => {
  it("turns markup into readable text, as before", () => {
    expect(htmlFragmentToText("<p>Mix &amp; bake at 350&deg;F.</p>")).toBe("Mix & bake at 350°F.");
    expect(htmlFragmentToText("Grandma&rsquo;s <em>Lentil</em> Soup")).toBe(
      "Grandma’s Lentil Soup"
    );
    expect(htmlFragmentToText("&lt;p&gt;Serve warm.&lt;/p&gt;")).toBe("Serve warm.");
    expect(htmlFragmentToLines("<ol><li>Soften the onion.</li><li>Add stock.</li></ol>")).toEqual([
      "Soften the onion.",
      "Add stock."
    ]);
  });

  it("keeps comparisons that only look like markup", () => {
    expect(htmlFragmentToText("Cook to < 165°F, then rest > 5 min")).toBe(
      "Cook to < 165°F, then rest > 5 min"
    );
    expect(htmlFragmentToText("Cook to &lt; 165&deg;F &lt;3")).toBe("Cook to < 165°F <3");
  });

  it("leaves no tag that nesting, splitting or entity-encoding would rebuild", () => {
    expect(htmlFragmentToText("<scr<b>ipt>alert(1)</scr</b>ipt> Serve")).toBe("alert(1) Serve");
    expect(htmlFragmentToText("<scr<scr<scr<b>ipt>ipt>ipt>alert(1)")).toBe("alert(1)");
    expect(htmlFragmentToText("&lt;scr&lt;b&gt;ipt&gt;alert(1)")).toBe("alert(1)");
    expect(htmlFragmentToText("Mix well <script src=x")).toBe("Mix well script src=x");
    expect(htmlFragmentToText("&lt;&lt;script&gt;x")).toBe("x");
  });

  it("never returns a tag opener for any mix of markup characters", () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 16_807) % 2_147_483_647;
      return seed / 2_147_483_647;
    };
    const alphabet = ["<", "<", ">", "/", "!", "b", "br", "p", "script", " ", "&lt;", "&gt;", "--"];

    for (let run = 0; run < 3_000; run += 1) {
      const input = Array.from(
        { length: Math.floor(next() * 14) },
        () => alphabet[Math.floor(next() * alphabet.length)] ?? ""
      ).join("");

      expect(TAG_OPENER.test(htmlFragmentToText(input)), JSON.stringify(input)).toBe(false);
      expect(
        htmlFragmentToLines(input).some((line) => TAG_OPENER.test(line)),
        JSON.stringify(input)
      ).toBe(false);
    }
  });

  it("still reads spaced and self-closing block tags as line breaks", () => {
    expect(htmlFragmentToLines("a<br/ >b<br />c<BR\n>d<P CLASS=x>e</p >f")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f"
    ]);
  });

  it("stays linear on long runs of markup characters", () => {
    const inputs = [
      `<br${" ".repeat(HOSTILE)}x`,
      `<p/${" ".repeat(HOSTILE)}x`,
      "<".repeat(HOSTILE),
      "<a".repeat(HOSTILE / 2),
      `<a ${" ".repeat(HOSTILE)}`,
      `${"<a".repeat(HOSTILE / 4)}${">".repeat(HOSTILE / 4)}`,
      `${"&lt;a".repeat(HOSTILE / 8)}${"&gt;".repeat(HOSTILE / 8)}`
    ];

    for (const input of inputs) {
      expect(TAG_OPENER.test(htmlFragmentToText(input))).toBe(false);
      expect(fastestMilliseconds(() => htmlFragmentToText(input))).toBeLessThan(50);
      expect(fastestMilliseconds(() => htmlFragmentToLines(input))).toBeLessThan(50);
    }
  });
});

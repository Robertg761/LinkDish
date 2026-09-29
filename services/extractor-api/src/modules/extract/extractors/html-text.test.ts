import { describe, expect, it } from "vitest";

import { htmlFragmentToLines, htmlFragmentToText } from "./html-text";

const TAG_OPENER = /<[!/?A-Za-z]/u;
const HOSTILE = 100_000;

/*
 * Stripping takes several linear passes over up to half again the input, so on a loaded
 * machine a bare time bound gets tight. The linear-time check holds it against the same call on
 * ordinary markup of the same length instead: linear work on the hostile inputs takes up to
 * about 6 times as long as that, quadratic work thousands of times ("<br" and 40,000 spaces
 * took a second before these patterns were fixed). The limit sits between the two with room
 * for a busy machine, whose time slices can land in the middle of a few-millisecond call.
 */
const MAX_SLOWDOWN = 100;

/**
 * How many times longer `run` takes than `ordinary`: the least of three trials that each time
 * the two back to back, so load slows both alike and a pause in one trial cannot fail a check.
 */
const slowdown = (run: () => unknown, ordinary: () => unknown): number =>
  Math.min(
    ...[0, 1, 2].map(() => {
      const started = performance.now();
      ordinary();
      const ordinaryDone = performance.now();
      run();
      return (performance.now() - ordinaryDone) / (ordinaryDone - started);
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
    expect(htmlFragmentToText("Mix well <script src=x")).toBe("Mix well < script src=x");
    expect(htmlFragmentToText("&lt;&lt;script&gt;x")).toBe("< x");
  });

  it("keeps a less-than sign that is not part of a tag, and the text after it", () => {
    expect(htmlFragmentToText("Heat to <medium, then simmer")).toBe(
      "Heat to < medium, then simmer"
    );
    expect(htmlFragmentToText("Jane Doe <jane@example.com>")).toBe("Jane Doe < jane@example.com>");
    expect(htmlFragmentToText("See <https://example.com/recipe>")).toBe(
      "See < https://example.com/recipe>"
    );
    expect(htmlFragmentToText("Contact &lt;chef@example.com&gt; with questions")).toBe(
      "Contact < chef@example.com> with questions"
    );
    expect(htmlFragmentToText("Keep temp <<b>boiling</b>, stir if > 5 min")).toBe(
      "Keep temp < boiling, stir if > 5 min"
    );
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

    const paragraph = '<p>Stir <b>well</b> &amp; <a href="/x" title="rest">rest</a>.</p>';
    const ordinary = paragraph.repeat(Math.ceil(HOSTILE / paragraph.length));

    for (const input of inputs) {
      expect(TAG_OPENER.test(htmlFragmentToText(input))).toBe(false);
      expect(
        slowdown(
          () => htmlFragmentToText(input),
          () => htmlFragmentToText(ordinary)
        )
      ).toBeLessThan(MAX_SLOWDOWN);
      expect(
        slowdown(
          () => htmlFragmentToLines(input),
          () => htmlFragmentToLines(ordinary)
        )
      ).toBeLessThan(MAX_SLOWDOWN);
    }
  });
});

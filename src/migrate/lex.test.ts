// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { applyEdits, offsetOf, positionOf, tokenize } from "./lex.ts";
import { unifiedDiff } from "./diff.ts";

const kinds = (source: string) =>
  tokenize(source)
    .filter((t) => t.kind !== "ws")
    .map((t) => `${t.kind}:${t.text}`);

describe("lex", () => {
  test("round-trips any input", () => {
    for (const source of [
      'import { a } from "dawg"; // "dawg"\nconst x = `a${b + `c${"d"}`}e`;',
      "const r = a / b / c; const s = /x\\/y[/]/g.test(z);",
      "/* unterminated",
      "'line\nbreak'",
    ])
      expect(
        tokenize(source)
          .map((t) => t.text)
          .join(""),
      ).toBe(source);
  });
  test("strings in template expressions are strings; comments are comments", () => {
    expect(kinds('`a${"dawg"}b`')).toEqual([
      "template:`a${",
      'string:"dawg"',
      "template:}b`",
    ]);
    expect(kinds('// from "dawg"')).toEqual(['comment:// from "dawg"']);
  });
  test("regex versus division", () => {
    expect(kinds("x = a / b / c")).toContain("punct:/");
    expect(kinds("return /dawg/.test(s)")).toContain("regex:/dawg/");
    expect(kinds("f(/a/g)")).toContain("regex:/a/g");
  });
  test("edits and positions", () => {
    expect(
      applyEdits("abcdef", [
        { start: 4, end: 5, text: "E" },
        { start: 0, end: 1, text: "A" },
      ]),
    ).toBe("AbcdEf");
    expect(() =>
      applyEdits("abc", [
        { start: 0, end: 2, text: "" },
        { start: 1, end: 3, text: "" },
      ]),
    ).toThrow();
    expect(positionOf("a\nbc", 3)).toEqual({ line: 2, col: 2 });
    expect(offsetOf("a\nbc", 2, 2)).toBe(3);
    expect(offsetOf("a", 3, 1)).toBe(-1);
  });
});

describe("unifiedDiff", () => {
  test("hunks with removals first, and file creation", () => {
    expect(unifiedDiff("f", "a\nb\nc\n", "a\nB\nc\n")).toBe(
      "--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n",
    );
    expect(unifiedDiff("f", null, "x\n")).toBe(
      "--- /dev/null\n+++ b/f\n@@ -0,0 +1,1 @@\n+x\n",
    );
    expect(unifiedDiff("f", "same", "same")).toBe("");
  });
});

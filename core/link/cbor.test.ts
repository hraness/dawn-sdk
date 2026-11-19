// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test";
import { CBOR_LIMITS, CborError, decodeCbor, encodeCbor } from "./cbor.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
function fault(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CborError) return error.fault;
    throw error;
  }
  return "none";
}

describe("one spelling for every value", () => {
  test("integers take the shortest head", () => {
    expect(hex(encodeCbor(0))).toBe("00");
    expect(hex(encodeCbor(23))).toBe("17");
    expect(hex(encodeCbor(24))).toBe("1818");
    expect(hex(encodeCbor(255))).toBe("18ff");
    expect(hex(encodeCbor(256))).toBe("190100");
    expect(hex(encodeCbor(65536))).toBe("1a00010000");
    expect(hex(encodeCbor(2 ** 32))).toBe("1b0000000100000000");
    expect(hex(encodeCbor(-1))).toBe("20");
    expect(hex(encodeCbor(-25))).toBe("3818");
    expect(hex(encodeCbor(Number.MAX_SAFE_INTEGER))).toBe("1b001fffffffffffff");
  });

  test("a number that is not an integer is the shortest exact float", () => {
    expect(hex(encodeCbor(0.5))).toBe("fa3f000000");
    expect(hex(encodeCbor(-1.5))).toBe("fabfc00000");
    expect(hex(encodeCbor(0.1))).toBe("fb3fb999999999999a");
    for (const value of [0.5, -1.5, 0.1, 1 / 3, 1e-9, 123456.789])
      expect(decodeCbor(encodeCbor(value))).toBe(value);
  });

  test("map keys are numbers ascending, then text by its bytes", () => {
    const map = new Map<number | string, number>([
      ["b", 1],
      [300, 2],
      ["aa", 3],
      [2, 4],
      ["a", 5],
    ]);
    const out = decodeCbor(encodeCbor(map)) as Map<number | string, number>;
    expect([...out.keys()]).toEqual([2, 300, "a", "aa", "b"]);
  });

  test("values round trip", () => {
    const value = [
      null,
      true,
      false,
      0,
      -7,
      "Caf\u{e9}",
      new Uint8Array([1, 2, 3]),
      [[], new Map()],
      new Map<number | string, unknown>([
        [1, "x"],
        ["k", [1.25]],
      ]),
    ];
    const once = encodeCbor(value as never);
    expect(hex(encodeCbor(decodeCbor(once)))).toBe(hex(once));
  });
});

describe("what the writer refuses", () => {
  test("negative zero, NaN and the infinities", () => {
    for (const value of [-0, NaN, Infinity, -Infinity])
      expect(fault(() => encodeCbor(value))).toBe("not_canonical");
  });
  test("text that is not NFC, and a lone surrogate", () => {
    expect(fault(() => encodeCbor("Cafe\u{301}"))).toBe("not_canonical");
    expect(fault(() => encodeCbor("\ud800"))).toBe("not_canonical");
    expect(fault(() => encodeCbor(new Map([["e\u{301}", 1]])))).toBe(
      "not_canonical",
    );
  });
  test("an integer past 2^53 - 1 and nesting past the bound", () => {
    expect(fault(() => encodeCbor(2 ** 53))).toBe("too_large");
    let deep: unknown = 0;
    for (let i = 0; i <= CBOR_LIMITS.depth; i += 1) deep = [deep];
    expect(fault(() => encodeCbor(deep as never))).toBe("too_large");
  });
});

describe("what the reader refuses", () => {
  const cases: [string, string, string][] = [
    ["a head longer than needed (one byte)", "1817", "not_canonical"],
    ["a head longer than needed (two bytes)", "1900ff", "not_canonical"],
    ["a head longer than needed (four bytes)", "1a0000ffff", "not_canonical"],
    [
      "a head longer than needed (eight)",
      "1b00000000ffffffff",
      "not_canonical",
    ],
    ["an integer written as a float", "fa3f800000", "not_canonical"],
    ["a float wider than needed", "fb3fe0000000000000", "not_canonical"],
    ["a half-width float", "f93c00", "malformed"],
    ["negative zero", "fa80000000", "not_canonical"],
    ["NaN", "fa7fc00000", "not_canonical"],
    ["infinity", "fa7f800000", "not_canonical"],
    ["an indefinite array", "9f00ff", "malformed"],
    ["an indefinite text", "7f6161ff", "malformed"],
    ["a tag", "c000", "malformed"],
    ["undefined", "f7", "malformed"],
    ["bytes after the value", "0000", "not_canonical"],
    ["a value cut short", "8201", "malformed"],
    ["text cut short", "6461", "malformed"],
    ["text that is not UTF-8", "62c328", "malformed"],
    ["text that is not NFC", "6365cc81", "not_canonical"],
    ["map keys out of order", "a2020001 00".replace(" ", ""), "not_canonical"],
    ["a map key twice", "a201000100", "not_canonical"],
    [
      "a text key before a number",
      "a2616100 0100".replace(" ", ""),
      "not_canonical",
    ],
    ["text keys out of order", "a2616200616100", "not_canonical"],
    ["a map key that is an array", "a18000", "malformed"],
    ["an integer past 2^53 - 1", "1b0020000000000000", "too_large"],
    ["nothing", "", "malformed"],
  ];
  for (const [name, input, expected] of cases)
    test(name, () => {
      expect(fault(() => decodeCbor(bytes(input)))).toBe(expected);
    });

  test("a length the bytes cannot hold, before anything is made for it", () => {
    // An array of four billion items in five bytes.
    expect(fault(() => decodeCbor(bytes("9affffffff")))).toBe("malformed");
    expect(fault(() => decodeCbor(bytes("baffffffff")))).toBe("malformed");
    expect(fault(() => decodeCbor(bytes("5affffffff")))).toBe("too_large");
    expect(fault(() => decodeCbor(bytes("7affffffff")))).toBe("too_large");
  });

  test("nesting, node count and text length past their bounds", () => {
    const deep = "81".repeat(CBOR_LIMITS.depth + 1) + "00";
    expect(fault(() => decodeCbor(bytes(deep)))).toBe("too_large");
    const limits = { depth: 4, nodes: 5, text: 3 };
    expect(
      fault(() => decodeCbor(bytes("8500000000 00".replace(" ", "")), limits)),
    ).toBe("too_large");
    expect(fault(() => decodeCbor(bytes("6461626364"), limits))).toBe(
      "too_large",
    );
  });
});

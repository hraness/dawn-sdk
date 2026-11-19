// SPDX-License-Identifier: MIT
/** A unified line diff for migration dry runs (LCS, three lines of context). */

function lcsTable(a: readonly string[], b: readonly string[]): Uint32Array[] {
  const rows: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1)
    rows.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      rows[i]![j] =
        a[i] === b[j]
          ? rows[i + 1]![j + 1]! + 1
          : Math.max(rows[i + 1]![j]!, rows[i]![j + 1]!);
  return rows;
}

type Line = Readonly<{
  kind: " " | "-" | "+";
  text: string;
  a: number;
  b: number;
}>;

function diffLines(a: readonly string[], b: readonly string[]): Line[] {
  // Trim the common head and tail first: migrations change few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out: Line[] = [];
  for (let k = 0; k < head; k += 1)
    out.push({ kind: " ", text: a[k]!, a: k, b: k });
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((text, k) =>
      out.push({ kind: "-", text, a: head + k, b: head }),
    );
    midB.forEach((text, k) =>
      out.push({ kind: "+", text, a: head + midA.length, b: head + k }),
    );
  } else {
    const table = lcsTable(midA, midB);
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        out.push({ kind: " ", text: midA[i]!, a: head + i, b: head + j });
        i += 1;
        j += 1;
      } else if (
        i < midA.length &&
        (j >= midB.length || table[i + 1]![j]! >= table[i]![j + 1]!)
      ) {
        // Removals print before additions, as git does.
        out.push({ kind: "-", text: midA[i]!, a: head + i, b: head + j });
        i += 1;
      } else {
        out.push({ kind: "+", text: midB[j]!, a: head + i, b: head + j });
        j += 1;
      }
    }
  }
  for (let k = 0; k < tail; k += 1)
    out.push({
      kind: " ",
      text: a[a.length - tail + k]!,
      a: a.length - tail + k,
      b: b.length - tail + k,
    });
  return out;
}

function split(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `--- a/path` / `+++ b/path` hunks; empty when the texts are equal. */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): string {
  if (before === after) return "";
  const lines = diffLines(split(before), split(after));
  const changed = lines
    .map((line, index) => (line.kind === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";
  const header = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
  const hunks: string[] = [];
  let k = 0;
  while (k < changed.length) {
    const first = changed[k]!;
    let last = first;
    while (
      k + 1 < changed.length &&
      changed[k + 1]! - last <= context * 2 + 1
    ) {
      k += 1;
      last = changed[k]!;
    }
    k += 1;
    const from = Math.max(0, first - context);
    const to = Math.min(lines.length - 1, last + context);
    const slice = lines.slice(from, to + 1);
    const aStart = slice[0]!.a + 1;
    const bStart = slice[0]!.b + 1;
    const aCount = slice.filter((line) => line.kind !== "+").length;
    const bCount = slice.filter((line) => line.kind !== "-").length;
    hunks.push(
      `@@ -${aCount === 0 ? aStart - 1 : aStart},${aCount} +${bCount === 0 ? bStart - 1 : bStart},${bCount} @@\n${slice
        .map((line) => `${line.kind}${line.text}`)
        .join("\n")}\n`,
    );
  }
  return header + hunks.join("");
}

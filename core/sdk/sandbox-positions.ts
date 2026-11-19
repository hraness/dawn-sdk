// SPDX-License-Identifier: MIT
/**
 * Maps a position in transpiled JavaScript back to the TypeScript it came
 * from. `Bun.Transpiler` reprints a module without a source map, but the
 * output is the input's tokens in the same order with the types removed,
 * so an alignment of the two token streams recovers where an engine stack
 * frame points in the author's file. Only used on the error path.
 */

export type Position = { line: number; col: number };

type Token = { key: string; line: number; col: number; offset: number };

/**
 * Insertions plus deletions the alignment searches before giving up (the
 * cost grows with its square). A track file DAWN prints has none; types
 * written by hand rarely add more than a few hundred.
 */
const MAX_EDITS = 2_000;

/**
 * The TypeScript position of the token at or after `at` (1-based line and
 * column in `js`), or `undefined` when the token cannot be placed.
 */
export function mapPosition(
  js: string,
  ts: string,
  at: Position,
): Position | undefined {
  const out = tokens(js);
  const input = tokens(ts);
  const target = offsetOf(js, at);
  if (target === undefined || out.length === 0) return undefined;
  let index = out.findIndex((token) => token.offset >= target);
  if (index < 0) index = out.length - 1;
  const pairs = align(out, input);
  if (pairs === undefined) return undefined;
  // A token the transpiler added (an inlined enum value) has no source;
  // the nearest earlier one that does stands in for it.
  let mapped = -1;
  for (let i = index; i >= 0 && mapped < 0; i -= 1) mapped = pairs[i]!;
  if (mapped < 0) return undefined;
  // QuickJS places a call at its `(`; name the function called instead.
  const callee =
    input[mapped]!.key === "p:(" && input[mapped - 1]?.key.startsWith("id:")
      ? mapped - 1
      : mapped;
  const token = input[callee]!;
  return { line: token.line, col: token.col };
}

/**
 * For each output token, the input token it is (or -1): a longest common
 * subsequence by Myers' diff, after the shared prefix and suffix. Types the
 * transpiler removed are input-only; enum objects it wrote are output-only.
 * `undefined` past `MAX_EDITS`.
 */
function align(
  out: readonly Token[],
  input: readonly Token[],
): Int32Array | undefined {
  const ids = new Map<string, number>();
  const id = (token: Token) => {
    let value = ids.get(token.key);
    if (value === undefined) ids.set(token.key, (value = ids.size));
    return value;
  };
  const a = Int32Array.from(out, id);
  const b = Int32Array.from(input, id);
  const pairs = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs[start] = start;
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    pairs[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return pairs;
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-(d+1), d+1] before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        backtrack(trace, n, m, (i, j) => (pairs[start + i] = start + j));
        return pairs;
      }
    }
  }
  return undefined;
}

function backtrack(
  trace: readonly Int32Array[],
  n: number,
  m: number,
  match: (i: number, j: number) => void,
): void {
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const row = trace[d]!;
    const at = (k: number) => row[k + d + 1]!;
    const k = x - y;
    const previous =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(previous);
    const py = px - previous;
    while (x > px && y > py) {
      x -= 1;
      y -= 1;
      match(x, y);
    }
    x = px;
    y = py;
  }
}

function offsetOf(source: string, at: Position): number | undefined {
  let line = 1;
  let offset = 0;
  while (line < at.line) {
    const next = source.indexOf("\n", offset);
    if (next < 0) return undefined;
    offset = next + 1;
    line += 1;
  }
  return offset + Math.max(0, at.col - 1);
}

const IDENT_START = /[A-Za-z_$\u0080-￿]/;
const IDENT_PART = /[\w$\u0080-￿]/;
/** Tokens after which `/` divides; after anything else it starts a regex. */
const DIVIDES_AFTER =
  /^(?:id:(?!(?:return|typeof|case|do|else|in|instanceof|new|delete|void|throw|yield|await|of)$)|num:|str:|tpl:|re:|p:[)\]}])/;

/**
 * Identifiers, numbers (by value), strings (by cooked value), template
 * chunks, regular expressions and single punctuation characters, with
 * comments and whitespace dropped.
 */
export function tokens(source: string): Token[] {
  const list: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const depth: number[] = [];
  const push = (
    key: string,
    start: number,
    startLine: number,
    startCol: number,
  ) => list.push({ key, line: startLine, col: startCol, offset: start });
  const advanceTo = (end: number) => {
    for (let k = i; k < end; k += 1)
      if (source.charCodeAt(k) === 10) {
        line += 1;
        lineStart = k + 1;
      }
    i = end;
  };
  const template = (start: number, startLine: number, startCol: number) => {
    // `i` is just past a backtick or a closing `}` of a substitution.
    let j = i;
    let chunk = "";
    while (j < source.length) {
      const c = source[j]!;
      if (c === "\\") {
        chunk += source.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === "`") {
        advanceTo(j + 1);
        push(`tpl:${chunk}`, start, startLine, startCol);
        return;
      }
      if (c === "$" && source[j + 1] === "{") {
        advanceTo(j + 2);
        push(`tpl:${chunk}`, start, startLine, startCol);
        depth.push(0);
        return;
      }
      chunk += c;
      j += 1;
    }
    advanceTo(source.length);
  };
  while (i < source.length) {
    const c = source[i]!;
    const start = i;
    const startLine = line;
    const startCol = i - lineStart + 1;
    if (c === "\n" || c === " " || c === "\t" || c === "\r" || c === "\f") {
      advanceTo(i + 1);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      advanceTo(end < 0 ? source.length : end);
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      advanceTo(end < 0 ? source.length : end + 2);
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < source.length && IDENT_PART.test(source[j]!)) j += 1;
      push(`id:${source.slice(i, j)}`, start, startLine, startCol);
      advanceTo(j);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < source.length) {
        const d = source[j]!;
        if (/[\w.]/.test(d)) j += 1;
        else if (
          (d === "+" || d === "-") &&
          /[eE]/.test(source[j - 1]!) &&
          !/^0[xX]/.test(source.slice(i, j))
        )
          j += 1;
        else break;
      }
      const raw = source.slice(i, j).replace(/_/g, "");
      const value = raw.endsWith("n") ? raw : String(Number(raw));
      push(`num:${value}`, start, startLine, startCol);
      advanceTo(j);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n")
        j += source[j] === "\\" ? 2 : 1;
      push(`str:${cook(source.slice(i + 1, j))}`, start, startLine, startCol);
      advanceTo(Math.min(source.length, j + 1));
      continue;
    }
    if (c === "`") {
      advanceTo(i + 1);
      template(start, startLine, startCol);
      continue;
    }
    if (c === "}" && depth.length > 0 && depth[depth.length - 1] === 0) {
      depth.pop();
      advanceTo(i + 1);
      template(start, startLine, startCol);
      continue;
    }
    if (c === "/" && !DIVIDES_AFTER.test(list[list.length - 1]?.key ?? "")) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n") {
        const d = source[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < source.length && IDENT_PART.test(source[j]!)) j += 1;
      push(`re:${source.slice(i, j)}`, start, startLine, startCol);
      advanceTo(j);
      continue;
    }
    if (depth.length > 0) {
      if (c === "{") depth[depth.length - 1]! += 1;
      else if (c === "}") depth[depth.length - 1]! -= 1;
    }
    push(`p:${c}`, start, startLine, startCol);
    advanceTo(i + 1);
  }
  return list;
}

/** A string literal's value, so a requoted or re-escaped literal still matches. */
function cook(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g,
    (_, escape: string) => {
      const head = escape[0]!;
      if (head === "u" && escape[1] === "{")
        return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
      if (head === "u" || head === "x")
        return String.fromCharCode(parseInt(escape.slice(1), 16));
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        b: "\b",
        f: "\f",
        v: "\v",
        "0": "\0",
        "\n": "",
        "\r\n": "",
      };
      return simple[escape] ?? escape;
    },
  );
}

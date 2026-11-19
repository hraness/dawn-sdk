// SPDX-License-Identifier: MIT
/**
 * A small TypeScript/JavaScript (and JSON) tokenizer for codemods. TS 7
 * ships no JS compiler API, so migrations edit tokens in place instead of
 * reprinting: formatting, strings and comments survive untouched.
 *
 * It knows identifiers, numbers, strings, template literal chunks (with
 * `${…}` expressions lexed as code), comments, regex literals and
 * punctuation. Every token carries its exact span; concatenating every
 * token's text reproduces the input.
 */

export type TokenKind =
  | "ws"
  | "comment"
  | "ident"
  | "number"
  | "string"
  | "template"
  | "regex"
  | "punct";

export type Token = Readonly<{
  kind: TokenKind;
  start: number;
  end: number;
  text: string;
}>;

const IDENT_START = /[A-Za-z_$À-￿]/;
const IDENT_PART = /[A-Za-z0-9_$À-￿]/;

/** Keywords after which `/` starts a regex rather than a division. */
const REGEX_AFTER = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  // Brace depth at which each open template expression started.
  const templateStack: number[] = [];
  let braceDepth = 0;
  const push = (kind: TokenKind, start: number, end: number) =>
    tokens.push({ kind, start, end, text: source.slice(start, end) });

  const lastSignificant = (): Token | undefined => {
    for (let k = tokens.length - 1; k >= 0; k -= 1)
      if (tokens[k]!.kind !== "ws" && tokens[k]!.kind !== "comment")
        return tokens[k];
    return undefined;
  };

  /** Scans a template chunk starting at `from` (just after "`" or "}"). */
  const templateChunk = (from: number): number => {
    let j = from;
    while (j < source.length) {
      const c = source[j]!;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return j + 1;
      if (c === "$" && source[j + 1] === "{") {
        templateStack.push(braceDepth);
        return j + 2;
      }
      j += 1;
    }
    return source.length;
  };

  while (i < source.length) {
    const c = source[i]!;
    const start = i;
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") {
      while (i < source.length && /[ \t\n\r﻿]/.test(source[i]!)) i += 1;
      push("ws", start, i);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      push("comment", start, i);
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 2;
      push("comment", start, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i += 1;
      while (i < source.length && source[i] !== c && source[i] !== "\n") {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i = Math.min(source.length, i + 1);
      push("string", start, i);
      continue;
    }
    if (c === "`") {
      i = templateChunk(i + 1);
      push("template", start, i);
      continue;
    }
    if (
      c === "}" &&
      templateStack.length > 0 &&
      templateStack[templateStack.length - 1] === braceDepth
    ) {
      templateStack.pop();
      i = templateChunk(i + 1);
      push("template", start, i);
      continue;
    }
    if (IDENT_START.test(c)) {
      while (i < source.length && IDENT_PART.test(source[i]!)) i += 1;
      push("ident", start, i);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      while (i < source.length && /[0-9A-Za-z_.]/.test(source[i]!)) {
        // An exponent sign belongs to the number.
        if (
          (source[i] === "e" || source[i] === "E") &&
          /[+-]/.test(source[i + 1] ?? "")
        )
          i += 1;
        i += 1;
      }
      push("number", start, i);
      continue;
    }
    if (c === "/") {
      const prev = lastSignificant();
      const regexAllowed =
        prev === undefined ||
        (prev.kind === "punct" && !/^[)\]}]$/.test(prev.text)) ||
        (prev.kind === "ident" && REGEX_AFTER.has(prev.text));
      if (regexAllowed) {
        i += 1;
        let inClass = false;
        while (i < source.length && source[i] !== "\n") {
          const r = source[i]!;
          if (r === "\\") {
            i += 2;
            continue;
          }
          if (r === "[") inClass = true;
          else if (r === "]") inClass = false;
          else if (r === "/" && !inClass) break;
          i += 1;
        }
        i += 1;
        while (i < source.length && /[a-z]/.test(source[i]!)) i += 1;
        push("regex", start, Math.min(i, source.length));
        continue;
      }
    }
    if (c === "{") braceDepth += 1;
    if (c === "}") braceDepth -= 1;
    // Multi-character punctuation does not matter for these codemods.
    i += 1;
    push("punct", start, i);
  }
  return tokens;
}

/** The contents of a string token without its quotes (escapes kept as written). */
export function stringValue(token: Token): string {
  return token.text.slice(1, -1);
}

export type Edit = Readonly<{ start: number; end: number; text: string }>;

/** Applies non-overlapping edits; throws if two overlap. */
export function applyEdits(source: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const edit of sorted) {
    if (edit.start < at) throw new Error("overlapping edits");
    out += source.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + source.slice(at);
}

/** Index of the next token after `index` that is not whitespace or a comment. */
export function nextSignificant(
  tokens: readonly Token[],
  index: number,
): number {
  for (let k = index + 1; k < tokens.length; k += 1)
    if (tokens[k]!.kind !== "ws" && tokens[k]!.kind !== "comment") return k;
  return -1;
}

export function previousSignificant(
  tokens: readonly Token[],
  index: number,
): number {
  for (let k = index - 1; k >= 0; k -= 1)
    if (tokens[k]!.kind !== "ws" && tokens[k]!.kind !== "comment") return k;
  return -1;
}

/** 1-based line and column of an offset. */
export function positionOf(
  source: string,
  offset: number,
): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < offset && k < source.length; k += 1)
    if (source[k] === "\n") {
      line += 1;
      lineStart = k + 1;
    }
  return { line, col: offset - lineStart + 1 };
}

/** Offset of a 1-based line and column, or -1. */
export function offsetOf(source: string, line: number, col: number): number {
  let current = 1;
  let k = 0;
  while (current < line) {
    const next = source.indexOf("\n", k);
    if (next < 0) return -1;
    k = next + 1;
    current += 1;
  }
  const offset = k + col - 1;
  return offset <= source.length ? offset : -1;
}

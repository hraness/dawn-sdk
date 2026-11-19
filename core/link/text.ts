// SPDX-License-Identifier: MIT
/**
 * Two rules for text that came from somewhere else: a link is found in
 * pasted text by one forward pass, never a regular expression, and text from
 * a link is escaped before it is shown.
 */

/** Where one link sits in a text. */
export type FoundLink = Readonly<{ start: number; end: number; link: string }>;

/** Characters a link's fragment is made of: base64url and the dots between. */
function fragmentChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x5f ||
    code === 0x2e
  );
}

/** Characters that end the URL a link is part of: space, controls, quotes, brackets. */
function boundary(code: number): boolean {
  return (
    code <= 0x20 ||
    code === 0x7f ||
    code === 0x22 ||
    code === 0x27 ||
    code === 0x60 ||
    code === 0x3c ||
    code === 0x3e ||
    code === 0x28 ||
    code === 0x29 ||
    code === 0x5b ||
    code === 0x5d ||
    code === 0x7b ||
    code === 0x7d ||
    code === 0xa0 ||
    code === 0x2028 ||
    code === 0x2029
  );
}

function digit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Every DAWN link in `text`, in order: a `#d<digits>.` and the run of
 * fragment characters after it, with the URL in front of it back to the
 * nearest space, quote or bracket. One pass; each character is looked at a
 * fixed number of times, whatever the text. Finding a link says nothing
 * about whether it decodes.
 */
export function findLinks(text: string, limit = 64): FoundLink[] {
  const found: FoundLink[] = [];
  if (typeof text !== "string") return found;
  let word = 0;
  let i = 0;
  while (i < text.length && found.length < limit) {
    const code = text.charCodeAt(i);
    if (boundary(code)) {
      word = i + 1;
      i += 1;
      continue;
    }
    if (code !== 0x23 || text.charCodeAt(i + 1) !== 0x64) {
      i += 1;
      continue;
    }
    let j = i + 2;
    while (j < text.length && digit(text.charCodeAt(j))) j += 1;
    if (j === i + 2 || text.charCodeAt(j) !== 0x2e) {
      // Not a link's fragment. The scan goes on from the next character, and
      // the digits just read are never read by this branch again: the next
      // `#` is at or past them.
      i += 1;
      continue;
    }
    let end = j + 1;
    while (end < text.length && fragmentChar(text.charCodeAt(end))) end += 1;
    // A sentence's full stop is not part of the link.
    while (end > j + 1 && text.charCodeAt(end - 1) === 0x2e) end -= 1;
    found.push(
      Object.freeze({ start: word, end, link: text.slice(word, end) }),
    );
    word = end;
    i = end;
  }
  return found;
}

const BIDI = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069,
]);

/**
 * `text` made safe to print: control characters, bidirectional controls,
 * line separators and lone surrogates become `\u{…}`, and it is cut at
 * `max` characters. A backslash is doubled so the result reads one way.
 */
export function escapeText(text: string, max = 300): string {
  let out = "";
  let count = 0;
  for (const char of String(text)) {
    if (count >= max) return `${out}…`;
    count += 1;
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0xfeff ||
      (code >= 0xd800 && code <= 0xdfff) ||
      BIDI.has(code)
    )
      out += `\\u{${code.toString(16)}}`;
    else out += char;
  }
  return out;
}

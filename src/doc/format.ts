// SPDX-License-Identifier: MIT
/**
 * Score documents (`dawn doc`, docs/design/score-docs.md): Markdown with a
 * YAML head that names the songs a document talks about and the tags it
 * marks them with, `dawn` fences that draw a stretch of a song as a roll
 * with marks on it, and links whose fragment is a place in a song
 * (`[the glide](#bars=18-19&track=lead)`). This file reads the text.
 * Finding the places in a song's score is the viewer's work (DAWN's own is
 * src/doc/resolve.ts).
 *
 * A figure's lines are a small syntax of their own rather than YAML:
 * Bun.YAML reads `bars: 16-24` as 16 and an unquoted `#` as a comment,
 * and a mark is easier to write, and to read, as one line.
 *
 * Every problem has a line number and, where one helps, a hint. The text
 * comes from anyone, so nothing here is trusted: names are checked
 * against patterns, sizes are bounded, and nothing is evaluated.
 */

export const DOC_FORMAT = 1;

export const DOC_LIMITS = {
  /** Bytes of the document. */
  bytes: 1_000_000,
  songs: 16,
  /** Tags a document declares (the built-in ones do not count). */
  tags: 24,
  figures: 64,
  marksPerFigure: 48,
  links: 2_000,
  problems: 100,
  /** Characters of a title, caption, label or note. */
  title: 200,
  label: 24,
  about: 120,
  note: 2_000,
} as const;

// ------------------------------------------------------------ problems

export type Severity = "error" | "warn";

export type Problem = Readonly<{
  /** 1-based line in the document; 0 when the problem has no one line. */
  line: number;
  severity: Severity;
  message: string;
  hint?: string;
}>;

export class Problems {
  readonly list: Problem[] = [];
  #dropped = 0;
  #errors = 0;

  error(line: number, message: string, hint?: string): void {
    this.#push({ line, severity: "error", message, ...(hint ? { hint } : {}) });
  }

  warn(line: number, message: string, hint?: string): void {
    this.#push({ line, severity: "warn", message, ...(hint ? { hint } : {}) });
  }

  /** Every error, kept or dropped: a document past the cap still fails. */
  get errors(): number {
    return this.#errors;
  }

  get dropped(): number {
    return this.#dropped;
  }

  #push(problem: Problem): void {
    if (problem.severity === "error") this.#errors += 1;
    if (this.list.length < DOC_LIMITS.problems) this.list.push(problem);
    else this.#dropped += 1;
  }
}

/** A short, printable form of text from the document, for a message. */
export const quoted = (text: string, max = 40): string => {
  const chars = [...text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")];
  return `"${chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("")}"`;
};

// ------------------------------------------------------------ tags

export type TagLine = "solid" | "dashed" | "dotted" | "none";
export type TagFill = "none" | "well";
export type TagTab = "filled" | "outline" | "plain";

export const TAG_LINES: readonly TagLine[] = [
  "solid",
  "dashed",
  "dotted",
  "none",
];
export const TAG_FILLS: readonly TagFill[] = ["none", "well"];
export const TAG_TABS: readonly TagTab[] = ["filled", "outline", "plain"];

/**
 * The colors a tag can name: `gray`, and the four hues of the palette. A
 * viewer gives each a color that reads on its light ground and its dark one.
 */
export const TAG_INKS = ["gray", "red", "blue", "green", "violet"] as const;
export type TagInk = (typeof TAG_INKS)[number];

/**
 * How a mark is drawn: its box's line, a well behind it, the number's tab,
 * and its color. Each built-in tag has a line, well and tab of its own, so
 * its color is never the only thing that tells it apart. `ink` names a
 * color of the palette, drawn on the box, the well and the tab. A document's
 * own tag may carry a `tone` instead, the author's color, which is drawn as
 * written on the notes the mark covers too.
 */
export type Tag = Readonly<{
  name: string;
  label: string;
  /** What the tag is for, in the legend. */
  about: string;
  line: TagLine;
  fill: TagFill;
  tab: TagTab;
  /** The palette's color for the tag when it has no tone. */
  ink: TagInk;
  /** The author's color (`#rgb` or `#rrggbb`); `dark` replaces it on a dark ground. */
  tone?: string;
  dark?: string;
  builtIn: boolean;
}>;

const builtIn = (
  name: string,
  about: string,
  line: TagLine,
  fill: TagFill,
  tab: TagTab,
  ink: TagInk,
): Tag => ({ name, label: name, about, line, fill, tab, ink, builtIn: true });

/** The tags every document has. Their order is the legend's. */
export const BUILT_IN_TAGS: readonly Tag[] = [
  builtIn("issue", "something wrong", "solid", "none", "filled", "red"),
  builtIn("fix", "what changed, or will", "dashed", "none", "outline", "blue"),
  builtIn(
    "keep",
    "something to keep as it is",
    "solid",
    "none",
    "outline",
    "green",
  ),
  builtIn(
    "ask",
    "a question for the listener",
    "dotted",
    "none",
    "outline",
    "violet",
  ),
  builtIn("note", "a remark", "solid", "none", "plain", "gray"),
  builtIn("focus", "the part to listen to", "none", "well", "plain", "gray"),
];

export const TAG_NAME = /^[a-z][a-z0-9-]{0,23}$/u;
export const SONG_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/iu;
const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** Words a figure line starts with or a place names; no tag may take one. */
export const RESERVED = new Set([
  "song",
  "bars",
  "bar",
  "t",
  "at",
  "section",
  "word",
  "words",
  "pitch",
  "track",
  "tracks",
  "caption",
]);

// ------------------------------------------------------------ the head

export type SongSpec = Readonly<{
  key: string;
  /** As written: a folder (score.json and audio.*) or a score file. */
  path: string;
  /** An audio file as written; null for none; undefined to look beside the score. */
  audio?: string | null;
  title?: string;
  line: number;
}>;

export type DocHead = Readonly<{
  title?: string;
  author?: string;
  date?: string;
  songs: readonly SongSpec[];
  /** Every tag the document can use: the built-in ones, then its own. */
  tags: ReadonlyMap<string, Tag>;
}>;

export type DocSplit = Readonly<{
  /** The YAML between the `---` lines, or null when there is no head. */
  head: string | null;
  /** The line of the head's first YAML line. */
  headLine: number;
  /** The Markdown after the head, with the head's lines left blank so line numbers hold. */
  body: string;
}>;

/** Splits a document into its YAML head and its Markdown body. */
export function splitDoc(text: string): DocSplit {
  const clean = text.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  const lines = clean.split("\n");
  if (lines[0]?.trimEnd() !== "---")
    return { head: null, headLine: 0, body: clean };
  const end = lines.findIndex(
    (line, i) =>
      i > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."),
  );
  if (end < 0) return { head: null, headLine: 0, body: clean };
  return {
    head: lines.slice(1, end).join("\n"),
    headLine: 2,
    body: [
      ...lines.slice(0, end + 1).map(() => ""),
      ...lines.slice(end + 1),
    ].join("\n"),
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const HEAD_KEYS = ["title", "author", "date", "songs", "tags", "dawn"];
const SONG_KEYS = ["score", "audio", "title"];
const TAG_KEYS = [
  "like",
  "label",
  "about",
  "tone",
  "dark",
  "line",
  "fill",
  "tab",
];

/** The line in the head where `key:` first appears at `indent` or deeper. */
function headLineOf(
  head: string,
  headLine: number,
  key: string,
  after = 0,
): number {
  const lines = head.split("\n");
  const pattern = new RegExp(
    `^\\s*["']?${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']?\\s*:`,
    "u",
  );
  for (let i = Math.max(0, after - headLine); i < lines.length; i += 1)
    if (pattern.test(lines[i]!)) return headLine + i;
  return headLine;
}

/**
 * A value YAML was asked for as text. YAML makes numbers, dates, booleans
 * and nulls of unquoted words; each of those is an error that says to
 * quote it, rather than a string the author did not write.
 */
function text(
  value: unknown,
  what: string,
  line: number,
  problems: Problems,
  max: number = DOC_LIMITS.title,
): string | undefined {
  if (typeof value === "string") {
    const chars = [...value.trim()];
    if (chars.length > max) {
      problems.error(line, `${what} is longer than ${max} characters`);
      return chars.slice(0, max).join("");
    }
    return chars.join("");
  }
  problems.error(
    line,
    `${what} must be text`,
    value === null
      ? `quote it; in YAML an unquoted # starts a comment, and an empty value is null`
      : `quote it: YAML read ${quoted(String(value))} as a ${Array.isArray(value) ? "list" : typeof value}`,
  );
  return undefined;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
  line: number,
  problems: Problems,
): T | undefined {
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  problems.error(
    line,
    `${what} must be one of ${allowed.join(", ")}`,
    typeof value === "string" ? `not ${quoted(value)}` : undefined,
  );
  return undefined;
}

function tone(
  value: unknown,
  what: string,
  line: number,
  problems: Problems,
  named = false,
): string | undefined {
  if (typeof value === "string" && COLOR.test(value.trim()))
    return value.trim().toLowerCase();
  if (named && typeof value === "string" && inkName(value)) return undefined;
  problems.error(
    line,
    named
      ? `${what} must be one of ${TAG_INKS.join(", ")} or a color like "#2f7a4f"`
      : `${what} must be a color like "#2f7a4f"`,
    value === null || value === undefined
      ? `quote it: in YAML an unquoted # starts a comment`
      : undefined,
  );
  return undefined;
}

/** The palette color a tag's `tone` names, if it names one. */
function inkName(value: unknown): TagInk | undefined {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (TAG_INKS as readonly string[]).includes(name)
    ? (name as TagInk)
    : undefined;
}

/** Reads and checks the head. The body's figures and links come later. */
export function parseHead(split: DocSplit, problems: Problems): DocHead {
  const tags = new Map<string, Tag>(BUILT_IN_TAGS.map((t) => [t.name, t]));
  if (split.head === null) return { songs: [], tags };
  const { head, headLine } = split;
  let raw: unknown;
  try {
    raw = head.trim() ? Bun.YAML.parse(head) : {};
  } catch (error) {
    problems.error(
      headLine,
      `the head is not YAML: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
      "the head is the YAML between the first two --- lines",
    );
    return { songs: [], tags };
  }
  if (raw === null || raw === undefined) raw = {};
  if (!isObj(raw)) {
    problems.error(
      headLine,
      "the head must be a map of keys (title:, songs:, tags:)",
    );
    return { songs: [], tags };
  }
  const at = (key: string, after = 0) => headLineOf(head, headLine, key, after);

  for (const key of Object.keys(raw))
    if (!HEAD_KEYS.includes(key))
      problems.error(
        at(key),
        `unknown key ${quoted(key)} in the head`,
        `the head knows ${HEAD_KEYS.join(", ")}`,
      );

  if (raw.dawn !== undefined && raw.dawn !== DOC_FORMAT)
    problems.error(
      at("dawn"),
      `this DAWN reads score documents of format ${DOC_FORMAT}`,
      `write dawn: ${DOC_FORMAT}, or leave it out`,
    );

  const title =
    raw.title === undefined
      ? undefined
      : text(raw.title, "title", at("title"), problems);
  const author =
    raw.author === undefined
      ? undefined
      : text(raw.author, "author", at("author"), problems);
  const date =
    raw.date === undefined
      ? undefined
      : text(raw.date, "date", at("date"), problems);

  const songs: SongSpec[] = [];
  if (raw.songs !== undefined) {
    const songsLine = at("songs");
    if (!isObj(raw.songs))
      problems.error(
        songsLine,
        "songs must be a map from a short key to a folder or a score file",
        "songs:\n  klo: out/keep-a-light-on/",
      );
    else {
      const entries = Object.entries(raw.songs);
      if (entries.length > DOC_LIMITS.songs)
        problems.error(songsLine, `more than ${DOC_LIMITS.songs} songs`);
      for (const [key, value] of entries.slice(0, DOC_LIMITS.songs)) {
        const line = at(key, songsLine);
        if (!SONG_KEY.test(key)) {
          problems.error(
            line,
            `song key ${quoted(key)} must be letters, digits, - or _ (at most 32)`,
          );
          continue;
        }
        if (typeof value === "string") {
          const path = text(value, `songs.${key}`, line, problems, 1024);
          if (path) songs.push({ key, path, line });
          continue;
        }
        if (!isObj(value)) {
          text(value, `songs.${key}`, line, problems);
          continue;
        }
        for (const k of Object.keys(value))
          if (!SONG_KEYS.includes(k))
            problems.error(
              line,
              `unknown key ${quoted(k)} in songs.${key}`,
              `a song knows ${SONG_KEYS.join(", ")}`,
            );
        const path =
          value.score === undefined
            ? undefined
            : text(value.score, `songs.${key}.score`, line, problems, 1024);
        if (!path) {
          if (value.score === undefined)
            problems.error(line, `songs.${key} needs score: <file or folder>`);
          continue;
        }
        const audio =
          value.audio === undefined
            ? undefined
            : value.audio === false
              ? null
              : text(value.audio, `songs.${key}.audio`, line, problems, 1024);
        const songTitle =
          value.title === undefined
            ? undefined
            : text(value.title, `songs.${key}.title`, line, problems);
        songs.push({
          key,
          path,
          ...(audio !== undefined ? { audio } : {}),
          ...(songTitle ? { title: songTitle } : {}),
          line,
        });
      }
    }
  }

  if (raw.tags !== undefined) {
    const tagsLine = at("tags");
    if (!isObj(raw.tags))
      problems.error(
        tagsLine,
        "tags must be a map from a tag's name to how it looks",
        'tags:\n  seam: { like: issue, label: seam, tone: "#b3541e" }',
      );
    else {
      let own = 0;
      for (const [name, value] of Object.entries(raw.tags)) {
        const line = at(name, tagsLine);
        const tag = parseTag(name, value, line, tags, problems);
        if (!tag) continue;
        if (!tag.builtIn && (own += 1) > DOC_LIMITS.tags) {
          problems.error(
            line,
            `more than ${DOC_LIMITS.tags} tags of the document's own`,
          );
          break;
        }
        tags.set(name, tag);
      }
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(date ? { date } : {}),
    songs,
    tags,
  };
}

function parseTag(
  name: string,
  value: unknown,
  line: number,
  tags: ReadonlyMap<string, Tag>,
  problems: Problems,
): Tag | undefined {
  if (!TAG_NAME.test(name)) {
    problems.error(
      line,
      `tag name ${quoted(name)} must start with a letter and be lowercase letters, digits or - (at most 24)`,
    );
    return undefined;
  }
  if (RESERVED.has(name)) {
    problems.error(
      line,
      `${quoted(name)} cannot be a tag: a figure line or a place uses the word`,
      `pick another name and give it the label you want: ${name}s: { label: ${name} }`,
    );
    return undefined;
  }
  const spec: Obj =
    value === null || value === undefined ? {} : isObj(value) ? value : {};
  if (!isObj(value) && value !== null && value !== undefined) {
    problems.error(
      line,
      `tags.${name} must be a map (like:, label:, tone:, line:, fill:, tab:, about:)`,
    );
    return undefined;
  }
  for (const k of Object.keys(spec))
    if (!TAG_KEYS.includes(k))
      problems.error(
        line,
        `unknown key ${quoted(k)} in tags.${name}`,
        `a tag knows ${TAG_KEYS.join(", ")}`,
      );
  const own = BUILT_IN_TAGS.find((t) => t.name === name);
  let base: Tag = own ?? BUILT_IN_TAGS.find((t) => t.name === "note")!;
  if (spec.like !== undefined) {
    if (own)
      problems.error(
        line,
        `tags.${name}: a built-in tag cannot be like another`,
      );
    else if (typeof spec.like !== "string" || !tags.has(spec.like))
      problems.error(
        line,
        `tags.${name}.like must name a tag declared above it or a built-in one`,
        `built-in tags: ${BUILT_IN_TAGS.map((t) => t.name).join(", ")}`,
      );
    else base = tags.get(spec.like)!;
  }
  const label =
    spec.label === undefined
      ? own
        ? base.label
        : name
      : text(
          spec.label,
          `tags.${name}.label`,
          line,
          problems,
          DOC_LIMITS.label,
        );
  const about =
    spec.about === undefined
      ? own
        ? base.about
        : spec.like !== undefined
          ? base.about
          : ""
      : text(
          spec.about,
          `tags.${name}.about`,
          line,
          problems,
          DOC_LIMITS.about,
        );
  const lineStyle =
    spec.line === undefined
      ? base.line
      : oneOf(spec.line, TAG_LINES, `tags.${name}.line`, line, problems);
  const fill =
    spec.fill === undefined
      ? base.fill
      : oneOf(spec.fill, TAG_FILLS, `tags.${name}.fill`, line, problems);
  const tab =
    spec.tab === undefined
      ? base.tab
      : oneOf(spec.tab, TAG_TABS, `tags.${name}.tab`, line, problems);
  const named = Object.hasOwn(spec, "tone") ? inkName(spec.tone) : undefined;
  const toneValue = Object.hasOwn(spec, "tone")
    ? tone(spec.tone, `tags.${name}.tone`, line, problems, true)
    : base.tone;
  const darkValue = Object.hasOwn(spec, "dark")
    ? tone(spec.dark, `tags.${name}.dark`, line, problems)
    : Object.hasOwn(spec, "tone")
      ? undefined
      : base.dark;
  if (darkValue && named)
    problems.error(
      line,
      `tags.${name}.dark goes with a tone like "#2f7a4f"`,
      `${named} has its own color on a dark ground`,
    );
  else if (darkValue && !toneValue)
    problems.error(
      line,
      `tags.${name}.dark needs a tone: for the light ground too`,
    );
  if (lineStyle === "none" && fill === "none")
    problems.error(
      line,
      `tags.${name} would draw nothing: line none needs fill well`,
    );
  return {
    name,
    label: label ?? name,
    about: about ?? "",
    line: lineStyle ?? base.line,
    fill: fill ?? base.fill,
    tab: tab ?? base.tab,
    ink: named ?? base.ink,
    ...(toneValue ? { tone: toneValue } : {}),
    ...(darkValue && toneValue ? { dark: darkValue } : {}),
    builtIn: Boolean(own),
  };
}

// ------------------------------------------------------------ places

/**
 * A place in a song, as written. Bars are counted as heard, from 1, and a
 * range is inclusive (`bars 18-19` is two bars); times are seconds of the
 * render. Fields narrow each other: `section "Chorus 1" word "light"` is
 * that word in that section.
 */
export type PlaceSpec = {
  song?: string;
  bars?: readonly [number, number];
  /** [start, end]; end null for a point. */
  t?: readonly [number, number | null];
  section?: string;
  word?: string;
  pitch?: readonly [number, number];
  tracks?: readonly string[];
};

const NOTE_NAMES: Readonly<Record<string, number>> = {
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
  a: 9,
  b: 11,
};

/** `E4`, `C#4`, `Db3`, `F♯2` or a MIDI number; C4 is 60. */
export function parsePitch(text: string): number | undefined {
  const t = text.trim();
  if (/^\d{1,3}$/u.test(t)) {
    const n = Number(t);
    return n <= 127 ? n : undefined;
  }
  const m = /^([a-g])([#♯b♭]?)(-?\d{1,2})$/iu.exec(t);
  if (!m) return undefined;
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] ? -1 : 0;
  const n = (Number(m[3]) + 1) * 12 + NOTE_NAMES[m[1]!.toLowerCase()]! + acc;
  return n >= 0 && n <= 127 ? n : undefined;
}

/** A pitch or a range of them, low to high. */
export function parsePitchRange(text: string): [number, number] | undefined {
  const one = parsePitch(text);
  if (one !== undefined) return [one, one];
  for (const sep of ["..", "–", "—", "-"]) {
    let from = text.indexOf(sep);
    while (from > 0) {
      const a = parsePitch(text.slice(0, from));
      const b = parsePitch(text.slice(from + sep.length));
      if (a !== undefined && b !== undefined)
        return [Math.min(a, b), Math.max(a, b)];
      from = text.indexOf(sep, from + 1);
    }
  }
  return undefined;
}

/** `0:47`, `1:02.5`, `47` or `47.5` (seconds). */
export function parseTime(text: string): number | undefined {
  const t = text.trim();
  const m = /^(?:(\d{1,2}):)?(\d{1,2}|\d{1,4})(\.\d{1,3})?$/u.exec(t);
  if (!m) return undefined;
  const minutes = m[1] === undefined ? 0 : Number(m[1]);
  const seconds = Number(`${m[2]}${m[3] ?? ""}`);
  if (m[1] !== undefined && (m[2]!.length !== 2 || seconds >= 60))
    return undefined;
  return minutes * 60 + seconds;
}

const RANGE_SEPS = ["..", "–", "—", "-"];

/** `0:47`, or `0:47-0:52.5` (also with – or ..). */
export function parseTimeRange(
  text: string,
): [number, number | null] | undefined {
  const one = parseTime(text);
  if (one !== undefined) return [one, null];
  for (const sep of RANGE_SEPS) {
    const i = text.indexOf(sep);
    if (i <= 0) continue;
    const a = parseTime(text.slice(0, i));
    const b = parseTime(text.slice(i + sep.length));
    if (a !== undefined && b !== undefined) return [a, b];
  }
  return undefined;
}

/** `18`, or `18-19` (also with – or ..), from 1. */
export function parseBars(text: string): [number, number] | undefined {
  const m = /^(\d{1,4})(?:\s*(?:-|–|—|\.\.)\s*(\d{1,4}))?$/u.exec(text.trim());
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a >= 1 && b >= 1 ? [a, b] : undefined;
}

type Token = Readonly<{ text: string; quoted: boolean }>;

/**
 * A figure line's words: runs of non-space text, or text in straight or
 * curly double quotes; commas part words as spaces do.
 */
function tokens(text: string): Token[] | string {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/[\s,]/u.test(c)) {
      i += 1;
      continue;
    }
    if (c === '"' || c === "“") {
      const close = c === '"' ? '"' : "”";
      const end = text.indexOf(close, i + 1);
      if (end < 0) return `a quote is not closed`;
      out.push({ text: text.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s,"“]/u.test(text[j]!)) j += 1;
    out.push({ text: text.slice(i, j), quoted: false });
    i = j;
  }
  return out;
}

/** Where a mark's note starts: the first `: ` outside quotes, or a final `:`. */
function noteSplit(text: string): [string, string] {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = '"';
    else if (c === "“") quote = "”";
    else if (c === ":" && (i === text.length - 1 || /\s/u.test(text[i + 1]!)))
      return [text.slice(0, i), text.slice(i + 1).trim()];
  }
  return [text, ""];
}

type PlaceKey = "bars" | "t" | "section" | "word" | "pitch" | "song";
const PLACE_WORDS: Readonly<Record<string, PlaceKey>> = {
  bars: "bars",
  bar: "bars",
  t: "t",
  at: "t",
  section: "section",
  word: "word",
  words: "word",
  pitch: "pitch",
  song: "song",
};

const PLACE_NOUN: Readonly<Record<PlaceKey, string>> = {
  bars: "a bar or a range of bars",
  t: "a time or a range of times",
  section: "a section's name",
  word: "a word to find",
  pitch: "a pitch or a range of pitches",
  song: "a song key",
};

const PLACE_HELP: Readonly<Record<PlaceKey, string>> = {
  bars: "bars 18 or bars 18-19 (as heard, from 1)",
  t: "t 0:47 or t 0:47-0:52.5",
  section: 'section "Chorus 1"',
  word: 'word "light" or word "keep a light on"',
  pitch: "pitch E4, pitch C4-G4 or pitch 60-67",
  song: "song klo",
};

/** Reads one value of a place into `spec`; false when it is not one. */
function setPlace(
  spec: PlaceSpec,
  key: PlaceKey,
  value: string,
  line: number,
  problems: Problems,
): boolean {
  if (key !== "section" && key !== "word" && spec[key] !== undefined) {
    problems.error(line, `${key} is given twice`);
    return false;
  }
  if ((key === "section" || key === "word") && spec[key] !== undefined) {
    problems.error(
      line,
      `${key} is given twice`,
      `quote a name with spaces: ${PLACE_HELP[key]}`,
    );
    return false;
  }
  switch (key) {
    case "bars": {
      const bars = parseBars(value);
      if (!bars) break;
      if (bars[1] < bars[0]) {
        problems.error(line, `bars ${value} runs backwards`);
        return false;
      }
      spec.bars = bars;
      return true;
    }
    case "t": {
      const t = parseTimeRange(value);
      if (!t) break;
      if (t[1] !== null && t[1] <= t[0]) {
        problems.error(line, `t ${value} runs backwards or is empty`);
        return false;
      }
      spec.t = t;
      return true;
    }
    case "pitch": {
      const pitch = parsePitchRange(value);
      if (!pitch) break;
      spec.pitch = pitch;
      return true;
    }
    case "section":
    case "word": {
      const name = value.trim().replace(/\s+/gu, " ");
      if (!name || [...name].length > DOC_LIMITS.title) break;
      spec[key] = name;
      return true;
    }
    case "song":
      if (!SONG_KEY.test(value)) break;
      spec.song = value;
      return true;
  }
  problems.error(
    line,
    `${quoted(value)} is not ${PLACE_NOUN[key]}`,
    `write ${PLACE_HELP[key]}`,
  );
  return false;
}

/**
 * The place in a figure line's words: `bars 18-19 lead pitch E4`. A bare
 * word is a track.
 */
function placeOfTokens(
  words: readonly Token[],
  line: number,
  problems: Problems,
  allowSong: boolean,
): PlaceSpec | undefined {
  const spec: PlaceSpec = {};
  const tracks: string[] = [];
  let ok = true;
  // The key of the value just read: a number after a section's or a word's
  // name is the rest of a name that wanted quotes.
  let after: PlaceKey | undefined;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const key = word.quoted ? undefined : PLACE_WORDS[word.text.toLowerCase()];
    const was = after;
    after = undefined;
    // `track "Lead vocal"`: a track by a name with spaces, as a link's track=.
    if (!word.quoted && /^tracks?$/iu.test(word.text)) {
      const value = words[i + 1];
      if (!value) {
        problems.error(
          line,
          `${word.text} needs a value`,
          'write track lead, or track "Lead vocal"',
        );
        ok = false;
        continue;
      }
      i += 1;
      tracks.push(value.text);
      continue;
    }
    if (!key) {
      if (word.quoted) {
        problems.error(
          line,
          `${quoted(word.text)}: quoted text needs a word before it`,
          `write section ${quoted(word.text)}, word ${quoted(word.text)} or track ${quoted(word.text)}`,
        );
        ok = false;
      } else if (
        (was === "section" || was === "word") &&
        /^\d+$/u.test(word.text)
      ) {
        problems.error(
          line,
          `${quoted(word.text)} after ${was} ${quoted(spec[was] ?? "")} is not a track`,
          `quote a name with spaces: ${was} "${spec[was] ?? ""} ${word.text}"`,
        );
        ok = false;
      } else tracks.push(word.text);
      continue;
    }
    if (key === "song" && !allowSong) {
      problems.error(
        line,
        "a mark is in its figure's song",
        "name the song in the figure: song: <key>",
      );
      ok = false;
      i += 1;
      continue;
    }
    const value = words[i + 1];
    if (!value) {
      problems.error(
        line,
        `${word.text} needs a value`,
        `write ${PLACE_HELP[key]}`,
      );
      ok = false;
      continue;
    }
    i += 1;
    if (!setPlace(spec, key, value.text, line, problems)) ok = false;
    after = key;
  }
  if (tracks.length) spec.tracks = tracks;
  return ok ? spec : undefined;
}

// ------------------------------------------------------------ figures

export type MarkSpec = Readonly<{
  line: number;
  tag: string;
  place: PlaceSpec;
  note: string;
}>;

export type FigureSpec = Readonly<{
  /** The line of the opening fence. */
  line: number;
  song?: string;
  /** The stretch shown: bars, t and section, narrowing each other. */
  window: PlaceSpec;
  /** The tracks shown, in this order; all that play in the stretch when absent. */
  tracks?: readonly string[];
  caption?: string;
  marks: readonly MarkSpec[];
}>;

const HEADER =
  /^(song|bars|bar|t|at|section|tracks|track|caption)\s*:\s*(.*)$/iu;

/**
 * One `dawn` fence's lines. Lines of `key: value` set up the figure
 * (song, bars, t, section, tracks, caption); every other line is a mark,
 * `<tag> <place>: <note>`; a line starting with `#` is a comment.
 */
export function parseFigure(
  body: string,
  fenceLine: number,
  tags: ReadonlyMap<string, Tag>,
  problems: Problems,
): FigureSpec {
  const window: PlaceSpec = {};
  let song: string | undefined;
  let tracks: string[] | undefined;
  let caption: string | undefined;
  const marks: MarkSpec[] = [];
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  for (const [i, raw] of lines.entries()) {
    const line = fenceLine ? fenceLine + 1 + i : 0;
    const text = raw.trim();
    if (!text || text.startsWith("#")) continue;
    const header = HEADER.exec(text);
    if (header) {
      const key = header[1]!.toLowerCase();
      const value = header[2]!.trim();
      if (key === "caption") {
        if (caption !== undefined)
          problems.error(line, "caption is given twice");
        caption = [...value].slice(0, DOC_LIMITS.title).join("");
        continue;
      }
      if (!value) {
        problems.error(line, `${key} needs a value`);
        continue;
      }
      if (key === "song") {
        if (song !== undefined) problems.error(line, "song is given twice");
        else if (!SONG_KEY.test(value))
          problems.error(
            line,
            `${quoted(value)} is not a song key`,
            "a key from songs: in the head",
          );
        else song = value;
        continue;
      }
      if (key === "tracks" || key === "track") {
        const list = tokens(value);
        if (typeof list === "string") problems.error(line, list);
        else if (tracks !== undefined)
          problems.error(line, "tracks is given twice");
        else tracks = list.map((t) => t.text).filter(Boolean);
        continue;
      }
      const placeKey = PLACE_WORDS[key]!;
      const unquoted =
        placeKey === "section" ? value.replace(/^["“](.*)["”]$/u, "$1") : value;
      setPlace(window, placeKey, unquoted, line, problems);
      continue;
    }
    if (marks.length >= DOC_LIMITS.marksPerFigure) {
      problems.error(
        line,
        `more than ${DOC_LIMITS.marksPerFigure} marks in one figure`,
      );
      break;
    }
    const mark = parseMark(text, line, tags, problems);
    if (mark) marks.push(mark);
  }
  return {
    line: fenceLine,
    ...(song ? { song } : {}),
    window,
    ...(tracks ? { tracks } : {}),
    ...(caption ? { caption } : {}),
    marks,
  };
}

function parseMark(
  text: string,
  line: number,
  tags: ReadonlyMap<string, Tag>,
  problems: Problems,
): MarkSpec | undefined {
  const [placeText, rawNote] = noteSplit(text);
  const words = tokens(placeText);
  if (typeof words === "string") {
    problems.error(line, words);
    return undefined;
  }
  const first = words[0];
  if (!first || first.quoted) {
    problems.error(
      line,
      "a mark starts with its tag",
      "issue bars 18-19 lead: what is wrong",
    );
    return undefined;
  }
  const tag = first.text.toLowerCase();
  if (!tags.has(tag)) {
    const known = [...tags.keys()].join(", ");
    // `bars 18: a note` is a mark without its tag; `bars 18` alone, a
    // figure's line without its colon.
    if (PLACE_WORDS[tag] && rawNote)
      problems.error(
        line,
        "a mark starts with its tag",
        `write it as <tag> ${first.text} …: <note>, for example issue ${first.text} …`,
      );
    else if (HEADER.test(`${first.text}:`))
      problems.error(
        line,
        `${quoted(first.text)} sets up the figure and needs a colon`,
        `write ${first.text.toLowerCase()}: <value>`,
      );
    else if (PLACE_WORDS[tag])
      problems.error(
        line,
        "a mark starts with its tag",
        `write it as <tag> ${first.text} …: <note>, for example issue ${first.text} …`,
      );
    else
      problems.error(
        line,
        `unknown tag ${quoted(first.text)}`,
        `tags here: ${known}; a document declares its own under tags: in the head`,
      );
    return undefined;
  }
  const place = placeOfTokens(words.slice(1), line, problems, false);
  if (!place) return undefined;
  const note = [...rawNote].slice(0, DOC_LIMITS.note).join("");
  return { line, tag, place, note };
}

// ------------------------------------------------------------ links

/**
 * A link's fragment as a place, or undefined when it is an ordinary
 * anchor (no `=` in it). `#bars=18-19&track=lead`, `#t=0:47`,
 * `#song=klo&section=Chorus+1`, `#word=a+light&track=vox`.
 */
export function parseLinkPlace(
  href: string,
  line: number,
  problems: Problems,
): PlaceSpec | null | undefined {
  if (!href.startsWith("#") || !href.includes("=")) return undefined;
  const decode = (s: string) => decodeURIComponent(s.replace(/\+/gu, " "));
  const spec: PlaceSpec = {};
  let ok = true;
  for (const pair of href.slice(1).split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    let rawKey: string;
    let value: string;
    // A comma parts tracks; a comma in a track's own id is written %2C.
    let list: string[];
    try {
      rawKey = decode(eq < 0 ? pair : pair.slice(0, eq));
      value = decode(rawValue);
      list = rawValue.split(",").map((v) => decode(v).trim());
    } catch {
      problems.error(
        line,
        `the place ${quoted(href, 60)} has a broken %-escape`,
        "write a % in a place as %25",
      );
      return null;
    }
    const key = rawKey.toLowerCase();
    if (key === "track" || key === "tracks") {
      spec.tracks = [...(spec.tracks ?? []), ...list.filter(Boolean)];
      continue;
    }
    const placeKey = PLACE_WORDS[key];
    if (!placeKey) {
      problems.error(
        line,
        `unknown key ${quoted(rawKey)} in the place ${quoted(href, 60)}`,
        "a place knows song, bars, t, section, word, pitch and track",
      );
      ok = false;
      continue;
    }
    if (!setPlace(spec, placeKey, value, line, problems)) ok = false;
  }
  return ok ? spec : null;
}

/** A place as a link fragment, the way `parseLinkPlace` reads it. */
export function placeFragment(spec: PlaceSpec): string {
  const parts: string[] = [];
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/gu, "+");
  if (spec.song) parts.push(`song=${enc(spec.song)}`);
  if (spec.section) parts.push(`section=${enc(spec.section)}`);
  if (spec.bars)
    parts.push(
      `bars=${spec.bars[0] === spec.bars[1] ? spec.bars[0] : `${spec.bars[0]}-${spec.bars[1]}`}`,
    );
  if (spec.t)
    parts.push(
      `t=${formatClock(spec.t[0])}${spec.t[1] === null ? "" : `-${formatClock(spec.t[1])}`}`,
    );
  if (spec.word) parts.push(`word=${enc(spec.word)}`);
  if (spec.pitch)
    parts.push(
      `pitch=${spec.pitch[0] === spec.pitch[1] ? spec.pitch[0] : `${spec.pitch[0]}-${spec.pitch[1]}`}`,
    );
  if (spec.tracks?.length)
    parts.push(`track=${spec.tracks.map(enc).join(",")}`);
  return `#${parts.join("&")}`;
}

/** Seconds as `m:ss`, with tenths when they are not whole. */
export function formatClock(seconds: number): string {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${frac ? `.${frac}` : ""}`;
}

/** Locates the opening lines of `dawn` fences, in order, for line numbers. */
export function figureLines(body: string): number[] {
  const out: number[] = [];
  const lines = body.split("\n");
  let open: { char: string; size: number } | null = null;
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/^(?:\s{0,3}>)*\s*/u, "");
    const m = /^(`{3,}|~{3,})\s*([^\s`]*)/u.exec(line);
    if (open) {
      if (m && m[1]![0] === open.char && m[1]!.length >= open.size && !m[2])
        open = null;
      continue;
    }
    if (!m) continue;
    open = { char: m[1]![0]!, size: m[1]!.length };
    if (m[2]!.toLowerCase() === "dawn") out.push(i + 1);
  }
  return out;
}

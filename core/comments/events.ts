// SPDX-License-Identifier: MIT
/**
 * A project's comments (docs/design/project-trace.md, "Comments").
 *
 * `comments.jsonl` is append-only, one event a line. A comment's state is
 * the fold of its lines in file order. This module is the lines and the
 * fold: it reads text and returns text, and touches no file, so the site
 * can use it as well as the CLI.
 *
 * A line this reader cannot use (not JSON, a newer `v`, a kind it does not
 * know, a field out of bounds) is skipped and kept: nothing here rewrites
 * the file, so a line a newer dawn wrote is still there for it.
 */

export const COMMENTS_FILE = "comments.jsonl";
export const COMMENT_LINE_VERSION = 1;

export const COMMENT_LIMITS = Object.freeze({
  /** Characters in a comment's text. The link's bound. */
  text: 4096,
  /** Comments that are not deleted. The desktop's bound. */
  live: 2000,
  /** Characters in an author's handle or an agent's name. */
  author: 64,
  /** Note rows in one anchor. The desktop's bound. */
  notes: 240,
  /** Characters in one line. */
  line: 65_536,
  /** Characters in a track id or a section name kept in an anchor. */
  name: 128,
  /** Values and nesting in an older anchor's retained JSON. */
  anchorValues: 4096,
  anchorDepth: 16,
});

export const COMMENT_KINDS = [
  "add",
  "edit",
  "resolve",
  "reopen",
  "delete",
] as const;
export type CommentKind = (typeof COMMENT_KINDS)[number];

export type CommentActor = Readonly<{
  kind: "person" | "agent" | "engine";
  name?: string;
}>;

/** `[start tick, length in ticks, pitch]` on the anchor's track. */
export type AnchorNote = readonly [tick: number, length: number, pitch: number];

/**
 * Where a comment points. Every field is optional; none is a comment on the
 * song. Everything but `rev` is read in the revision `rev` names. A comment
 * has one track or none.
 */
export type CommentAnchor = Readonly<{
  /** The revision digest the comment was written against. */
  rev?: string;
  track?: string;
  section?: string;
  /** A first bar and a bar past the last, from 0. */
  bars?: readonly [number, number];
  /** A first tick and a tick past the last. */
  ticks?: readonly [number, number];
  notes?: readonly AnchorNote[];
  /** What an older file said that has no place here, kept as it was. */
  was?: Readonly<Record<string, unknown>>;
}>;

/** A suggested rename a comment carries, as the desktop wrote it. */
export type CommentRename = Readonly<
  { track: string; to: string } | { section: number; to: string }
>;

export type CommentEvent = Readonly<{
  v: 1;
  /** 128 bits, base64url: the event's id, and for `add` the comment's. */
  id: string;
  kind: CommentKind;
  /** The writer's clock, UTC, ISO 8601. For display. */
  at: string;
  author?: string;
  actor?: CommentActor;
  /** `add`, `edit`. */
  text?: string;
  /** `add`: the first comment of the thread this one replies in. */
  thread?: string;
  /** `add`. */
  anchor?: CommentAnchor;
  /** `add`. */
  rename?: CommentRename;
  /** `edit`, `resolve`, `reopen`, `delete`: the comment it is about. */
  of?: string;
}>;

export type CommentState = "open" | "resolved" | "deleted";

export type Comment = Readonly<{
  id: string;
  /** Empty once the comment is deleted. */
  text: string;
  author?: string;
  actor?: CommentActor;
  at: string;
  /** When the text was last changed. */
  edited?: string;
  /** The first comment of its thread; absent on a first comment. */
  thread?: string;
  state: CommentState;
  /** Who resolved it and when, while it is resolved. */
  resolved?: Readonly<{ at: string; author?: string }>;
  anchor: CommentAnchor;
  rename?: CommentRename;
}>;

export type SkippedLine = Readonly<{
  /** From 1. */
  line: number;
  reason: string;
}>;

export type FoldedComments = Readonly<{
  /** Every comment, deleted ones too, in the order they were added. */
  comments: readonly Comment[];
  /** Lines that were not used. They stay in the file. */
  skipped: readonly SkippedLine[];
  /** Comments past the bound on live ones, not shown. */
  over: number;
}>;

const ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const DIGEST = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export const isCommentId = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function pairProblem(value: unknown, name: string): string | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !isCount(value[0]) ||
    !isCount(value[1]) ||
    value[1] <= value[0]
  )
    return `${name} is a first and a past-the-last, in order`;
  return undefined;
}

/** Retained foreign JSON stays bounded before any encoder visits it. */
function retainedProblem(value: unknown): string | undefined {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (
      ++count > COMMENT_LIMITS.anchorValues ||
      depth > COMMENT_LIMITS.anchorDepth
    )
      return "was has more values or nesting than an anchor holds";
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (typeof value === "number" && Number.isFinite(value)) continue;
    if (typeof value !== "object" || value === null)
      return "was holds JSON values";
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return "was holds JSON values";
    const values = Array.isArray(value) ? value : Object.values(value);
    if (values.length > COMMENT_LIMITS.anchorValues - count - pending.length)
      return "was has more values or nesting than an anchor holds";
    for (const item of values) pending.push({ value: item, depth: depth + 1 });
  }
  return undefined;
}

/** Why `anchor` is not one, or undefined when it is. */
export function anchorProblem(anchor: unknown): string | undefined {
  if (!isObject(anchor)) return "an anchor is an object";
  const { rev, track, section, bars, ticks, notes, was } = anchor;
  if (rev !== undefined && (typeof rev !== "string" || !DIGEST.test(rev)))
    return "rev is a revision digest";
  for (const [name, value] of [
    ["track", track],
    ["section", section],
  ] as const)
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.length === 0 ||
        value.length > COMMENT_LIMITS.name)
    )
      return `${name} is a name of 1 to ${COMMENT_LIMITS.name} characters`;
  if (bars !== undefined) {
    const problem = pairProblem(bars, "bars");
    if (problem) return problem;
  }
  if (ticks !== undefined) {
    const problem = pairProblem(ticks, "ticks");
    if (problem) return problem;
  }
  if (notes !== undefined) {
    if (!Array.isArray(notes) || notes.length === 0)
      return "notes is a list of rows";
    if (notes.length > COMMENT_LIMITS.notes)
      return `an anchor holds at most ${COMMENT_LIMITS.notes} notes`;
    if (track === undefined) return "notes are on a track: name it";
    for (const row of notes as unknown[])
      if (
        !Array.isArray(row) ||
        row.length !== 3 ||
        !isCount(row[0]) ||
        !isCount(row[1]) ||
        !isCount(row[2]) ||
        row[2] > 127
      )
        return "a note row is [start tick, length, pitch]";
  }
  if (was !== undefined) {
    if (!isObject(was)) return "was is an object";
    const problem = retainedProblem(was);
    if (problem) return problem;
  }
  return undefined;
}

function actorProblem(actor: unknown): string | undefined {
  if (!isObject(actor)) return "actor is an object";
  if (
    actor.kind !== "person" &&
    actor.kind !== "agent" &&
    actor.kind !== "engine"
  )
    return "actor.kind is person, agent or engine";
  if (
    actor.name !== undefined &&
    (typeof actor.name !== "string" ||
      actor.name.length === 0 ||
      actor.name.length > COMMENT_LIMITS.author)
  )
    return "actor.name is a short name";
  return undefined;
}

function renameProblem(rename: unknown): string | undefined {
  if (!isObject(rename) || typeof rename.to !== "string")
    return "rename names a track or a section and what to call it";
  if (rename.to.length > COMMENT_LIMITS.name) return "rename.to is too long";
  const track = typeof rename.track === "string";
  const section = isCount(rename.section);
  if (track === section) return "rename names a track or a section";
  return undefined;
}

/** Why `event` is not a line this reader uses, or undefined when it is. */
export function eventProblem(event: unknown): string | undefined {
  if (!isObject(event)) return "not an object";
  if (event.v !== COMMENT_LINE_VERSION)
    return `line version ${JSON.stringify(event.v) ?? "missing"}, not ${COMMENT_LINE_VERSION}`;
  if (!isCommentId(event.id)) return "id is 16 bytes in base64url";
  if (
    typeof event.kind !== "string" ||
    !(COMMENT_KINDS as readonly string[]).includes(event.kind)
  )
    return `a kind this dawn does not know: ${String(event.kind).slice(0, 24)}`;
  if (
    typeof event.at !== "string" ||
    !TIME.test(event.at) ||
    !Number.isFinite(Date.parse(event.at))
  )
    return "at is a UTC time";
  if (
    event.author !== undefined &&
    (typeof event.author !== "string" ||
      event.author.length === 0 ||
      event.author.length > COMMENT_LIMITS.author)
  )
    return `author is a handle of 1 to ${COMMENT_LIMITS.author} characters`;
  if (event.actor !== undefined) {
    const problem = actorProblem(event.actor);
    if (problem) return problem;
  }
  const text = event.kind === "add" || event.kind === "edit";
  if (text) {
    if (typeof event.text !== "string") return `${event.kind} has text`;
    if ([...event.text].length > COMMENT_LIMITS.text)
      return `text is longer than ${COMMENT_LIMITS.text} characters`;
  }
  if (event.kind === "add") {
    if (event.thread !== undefined && !isCommentId(event.thread))
      return "thread is a comment's id";
    if (event.anchor !== undefined) {
      const problem = anchorProblem(event.anchor);
      if (problem) return problem;
    }
    if (event.rename !== undefined) {
      const problem = renameProblem(event.rename);
      if (problem) return problem;
    }
  } else if (!isCommentId(event.of)) return `${event.kind} says which comment`;
  return undefined;
}

/** One line of the file, with its newline. Keys in one order, so the same event is the same bytes. */
export function eventLine(event: CommentEvent): string {
  const problem = eventProblem(event);
  if (problem) throw new Error(`not a comment line: ${problem}`);
  const anchor = event.anchor;
  const ordered: Record<string, unknown> = {
    v: event.v,
    id: event.id,
    kind: event.kind,
    at: event.at,
    author: event.author,
    actor: event.actor
      ? { kind: event.actor.kind, name: event.actor.name }
      : undefined,
    of: event.of,
    thread: event.thread,
    text: event.text,
    anchor:
      anchor && Object.keys(anchor).length > 0
        ? {
            rev: anchor.rev,
            track: anchor.track,
            section: anchor.section,
            bars: anchor.bars,
            ticks: anchor.ticks,
            notes: anchor.notes,
            was: anchor.was,
          }
        : undefined,
    rename: event.rename,
  };
  const line = JSON.stringify(ordered);
  if (line.length > COMMENT_LIMITS.line)
    throw new Error("not a comment line: longer than a line may be");
  return `${line}\n`;
}

export type ParsedLines = Readonly<{
  events: readonly CommentEvent[];
  skipped: readonly SkippedLine[];
}>;

/** The events in `text`, and the lines that are not events this reader uses. */
export function parseCommentLines(text: string): ParsedLines {
  const events: CommentEvent[] = [];
  const skipped: SkippedLine[] = [];
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    const skip = (reason: string) => skipped.push({ line: index + 1, reason });
    if (line.length > COMMENT_LIMITS.line)
      return skip("longer than a line may be");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return skip("not JSON");
    }
    const problem = eventProblem(value);
    if (problem) return skip(problem);
    events.push(value as CommentEvent);
  });
  return { events, skipped };
}

/**
 * The comments `events` add up to, in file order. An id seen twice is used
 * once: the first line wins, so a retry or a merge that kept both copies
 * changes nothing. A reply to a reply joins the same thread. `delete` is
 * soft: the comment stays, with no text, so its replies keep a parent.
 * An `edit` or a `delete` counts only from the comment's own author (no
 * author on both is the same author); `resolve` and `reopen` from anyone.
 */
export function foldComments(parsed: ParsedLines): FoldedComments {
  const seen = new Set<string>();
  const byId = new Map<string, Comment>();
  const order: string[] = [];
  const skipped = [...parsed.skipped];
  let live = 0;
  let over = 0;
  for (const event of parsed.events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.kind === "add") {
      if (live >= COMMENT_LIMITS.live) {
        over += 1;
        continue;
      }
      const parent =
        event.thread === undefined ? undefined : byId.get(event.thread);
      const thread =
        event.thread === undefined
          ? undefined
          : (parent?.thread ?? event.thread);
      byId.set(event.id, {
        id: event.id,
        text: event.text ?? "",
        ...(event.author !== undefined ? { author: event.author } : {}),
        ...(event.actor !== undefined ? { actor: event.actor } : {}),
        at: event.at,
        ...(thread !== undefined ? { thread } : {}),
        state: "open",
        anchor: event.anchor ?? {},
        ...(event.rename !== undefined ? { rename: event.rename } : {}),
      });
      order.push(event.id);
      live += 1;
      continue;
    }
    const comment = byId.get(event.of!);
    // An event about a comment that is not here, or is deleted, does nothing.
    if (!comment || comment.state === "deleted") continue;
    // Only its author edits or deletes a comment; anyone resolves or reopens.
    if (
      (event.kind === "edit" || event.kind === "delete") &&
      event.author !== comment.author
    )
      continue;
    if (event.kind === "edit")
      byId.set(comment.id, {
        ...comment,
        text: event.text ?? "",
        edited: event.at,
      });
    else if (event.kind === "resolve") {
      if (comment.state === "resolved") continue;
      byId.set(comment.id, {
        ...comment,
        state: "resolved",
        resolved: {
          at: event.at,
          ...(event.author !== undefined ? { author: event.author } : {}),
        },
      });
    } else if (event.kind === "reopen") {
      const { resolved: _resolved, ...rest } = comment;
      byId.set(comment.id, { ...rest, state: "open" });
    } else {
      const { resolved: _resolved, rename: _rename, ...rest } = comment;
      byId.set(comment.id, { ...rest, text: "", state: "deleted" });
      live -= 1;
    }
  }
  return {
    comments: order.map((id) => byId.get(id)!),
    skipped,
    over,
  };
}

/** `foldComments(parseCommentLines(text))`. */
export const readComments = (text: string): FoldedComments =>
  foldComments(parseCommentLines(text));

/** Comments that are not deleted. */
export const liveComments = (folded: FoldedComments): readonly Comment[] =>
  folded.comments.filter((comment) => comment.state !== "deleted");

/** A new id from 16 random bytes. */
export function commentId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error("a comment id is 16 bytes");
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

/** The 16 bytes of an id. */
export function commentIdBytes(id: string): Uint8Array {
  if (!isCommentId(id)) throw new Error("not a comment id");
  const text = atob(id.replace(/-/gu, "+").replace(/_/gu, "/"));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/**
 * The one comment `word` names: a whole id, or the start of one that only
 * one comment has. Returns the comment, or why there is not exactly one.
 */
export function findComment(
  folded: FoldedComments,
  word: string,
):
  | { ok: true; comment: Comment }
  | { ok: false; reason: "none" | "several"; matches: readonly string[] } {
  const exact = folded.comments.find((comment) => comment.id === word);
  if (exact) return { ok: true, comment: exact };
  const matches =
    word.length >= 4
      ? folded.comments.filter((comment) => comment.id.startsWith(word))
      : [];
  if (matches.length === 1) return { ok: true, comment: matches[0]! };
  return {
    ok: false,
    reason: matches.length === 0 ? "none" : "several",
    matches: matches.slice(0, 8).map((comment) => comment.id),
  };
}

// SPDX-License-Identifier: MIT
/**
 * 0002-comments-jsonl: the desktop's `comments.json` (`dawn.comments/v1`,
 * one file written whole) becomes `comments.jsonl` (one event a line,
 * append-only), per docs/design/project-trace.md, "Moving comments.json".
 *
 * The plan is a pure function of the files: ids are derived, not random, so
 * two clones that migrate the same file write the same lines and their
 * merge is one copy.
 *
 * Held: it is not in MIGRATIONS, so `dawn check`, `dawn sync` and a plain
 * `dawn migrate` do not know it. It turns on with the desktop that reads
 * the new file; until then `dawn migrate --only 0002-comments-jsonl` runs it.
 */
import { createHash } from "node:crypto";
import {
  COMMENT_LIMITS,
  COMMENTS_FILE,
  type CommentAnchor,
  type CommentEvent,
  type CommentRename,
  commentId,
  commentIdBytes,
  eventLine,
  parseCommentLines,
} from "../../core/comments/events.ts";
import type { FileOp, Migration, ProjectFiles } from "./types.ts";

export const OLD_COMMENTS_FILE = "comments.json";
export const OLD_COMMENTS_SCHEMA = "dawn.comments/v1";
/** The desktop's bounds, applied the way its reader applies them. */
const OLD_MAX_TEXT = 4000;
const OLD_MAX_COMMENTS = 2000;

const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const NO_TIME = "1970-01-01T00:00:00Z";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** Why the step has nothing to do with the old file, or that it is ready. */
export type OldCommentsStanding =
  "none" | "unreadable" | "other-schema" | "ready";

function readOld(files: ProjectFiles): {
  standing: OldCommentsStanding;
  raw: string | null;
  song: string;
  list: readonly unknown[];
} {
  const none = { raw: null, song: "", list: [] };
  if (!files.exists(OLD_COMMENTS_FILE)) return { standing: "none", ...none };
  const raw = files.read(OLD_COMMENTS_FILE);
  if (raw === null) return { standing: "unreadable", ...none };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { standing: "unreadable", ...none };
  }
  if (!isObject(value) || !Array.isArray(value.comments))
    return { standing: "unreadable", ...none };
  if (value.schema !== OLD_COMMENTS_SCHEMA)
    return { standing: "other-schema", ...none };
  return {
    standing: "ready",
    raw,
    song: text(value.song) ?? "",
    list: value.comments,
  };
}

/** Where the project's `comments.json` stands, for the command to say. */
export function oldCommentsStanding(files: ProjectFiles): OldCommentsStanding {
  return readOld(files).standing;
}

function derived(...parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  parts.forEach((part, index) => {
    if (index > 0) hash.update("\0");
    hash.update(part);
  });
  return commentId(new Uint8Array(hash.digest().subarray(0, 16)));
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/**
 * The new anchor for an old one. Bars count from 1 in the old file and from
 * 0 here. One track carries over; several become no track, with what the
 * old anchor had under `was`. Times and notes in seconds stay under `was`:
 * turning them into ticks needs the tempo map of the day, which nobody has.
 */
function anchorOf(old: unknown): CommentAnchor {
  if (!isObject(old)) return old === undefined ? {} : { was: { anchor: old } };
  const anchor: {
    track?: string;
    section?: string;
    bars?: readonly [number, number];
    was?: Json;
  } = {};
  const was: Json = {};
  for (const key of ["t0", "t1"])
    if (typeof old[key] === "number") was[key] = old[key];

  const bars = isObject(old.bars) ? old.bars : undefined;
  const from = bars && isObject(bars.from) ? bars.from : undefined;
  const to = bars && isObject(bars.to) ? bars.to : undefined;
  const first = count(from?.bar);
  const last = count(to?.bar);
  if (first !== undefined && first >= 1 && last !== undefined && last >= 1) {
    const start = first - 1;
    // An end on a bar's first beat is the bar before it, whole.
    const onBar = typeof to!.beat !== "number" || to!.beat <= 1;
    const past = Math.max(start + 1, onBar ? last - 1 : last);
    anchor.bars = [start, past];
  }
  if (bars) was.bars = bars;

  const sections = Array.isArray(old.sections)
    ? old.sections.filter((name): name is string => typeof name === "string")
    : [];
  if (
    sections.length === 1 &&
    sections[0]!.length > 0 &&
    sections[0]!.length <= COMMENT_LIMITS.name
  )
    anchor.section = sections[0]!;
  else if (sections.length > 0) was.sections = sections;

  const tracks = Array.isArray(old.tracks) ? old.tracks.filter(isObject) : [];
  const ids = tracks
    .map((track) => text(track.id))
    .filter((id): id is string => id !== undefined);
  const all = old.all_tracks === true;
  if (
    !all &&
    ids.length === 1 &&
    ids[0]!.length > 0 &&
    ids[0]!.length <= COMMENT_LIMITS.name
  )
    anchor.track = ids[0]!;
  // Names are kept either way: a comment whose place has gone says them.
  if (tracks.length > 0) was.tracks = tracks;
  if (all) was.all_tracks = true;

  if (Array.isArray(old.notes) && old.notes.length > 0) was.notes = old.notes;
  if (typeof old.note_count === "number" && old.note_count > 0)
    was.note_count = old.note_count;
  if (Object.keys(was).length > 0) anchor.was = was;
  return anchor;
}

function renameOf(old: unknown): CommentRename | undefined {
  if (!isObject(old)) return undefined;
  const to = text(old.to);
  if (to === undefined || to.length > COMMENT_LIMITS.name) return undefined;
  if (typeof old.track === "string") return { track: old.track, to };
  const section = count(old.section);
  return section === undefined ? undefined : { section, to };
}

/** The lines for the old file's comments, in the file's order. */
export function linesFromOldComments(
  song: string,
  list: readonly unknown[],
): CommentEvent[] {
  const events: CommentEvent[] = [];
  const seen = new Set<string>();
  list.slice(0, OLD_MAX_COMMENTS).forEach((entry, index) => {
    if (!isObject(entry)) return;
    const raw = text(entry.text);
    if (raw === undefined) return;
    // As the desktop reads it: trimmed, and no longer than its bound.
    const words = [...raw.trim()].slice(0, OLD_MAX_TEXT).join("");
    if (words === "") return;
    let old = text(entry.id) ?? `c${index + 1}`;
    if (seen.has(old)) old = `${old}-${index}`;
    seen.add(old);
    const created = text(entry.created) ?? "";
    const id = derived("dawn.comment/v1", song, old, created, raw);
    const at =
      TIME.test(created) && Number.isFinite(Date.parse(created))
        ? created
        : NO_TIME;
    const rename = renameOf(entry.rename);
    events.push({
      v: 1,
      id,
      kind: "add",
      at,
      text: words,
      anchor: anchorOf(entry.anchor),
      ...(rename ? { rename } : {}),
    });
    if (entry.status === "addressed") {
      const when = text(entry.addressed);
      events.push({
        v: 1,
        id: derived("dawn.comment/v1", "resolved", commentIdBytes(id)),
        kind: "resolve",
        at:
          when !== undefined &&
          TIME.test(when) &&
          Number.isFinite(Date.parse(when))
            ? when
            : at,
        of: id,
      });
    }
  });
  return events;
}

function plan(files: ProjectFiles): readonly FileOp[] {
  const old = readOld(files);
  // Not there, not readable, or not this schema: left where it is.
  if (old.standing !== "ready" || old.raw === null) return [];
  const before = files.exists(COMMENTS_FILE) ? files.read(COMMENTS_FILE) : null;
  // A comments.jsonl too large to read is not one to append to blind.
  if (files.exists(COMMENTS_FILE) && before === null) return [];
  const have = new Set<string>();
  if (before !== null)
    for (const event of parseCommentLines(before).events) have.add(event.id);
  let added = "";
  for (const event of linesFromOldComments(old.song, old.list))
    if (!have.has(event.id)) added += eventLine(event);
  const ops: FileOp[] = [];
  if (added !== "") {
    const head =
      before === null || before === "" || before.endsWith("\n")
        ? (before ?? "")
        : `${before}\n`;
    ops.push({
      op: "write",
      path: COMMENTS_FILE,
      before,
      after: head + added,
    });
  }
  ops.push({ op: "delete", path: OLD_COMMENTS_FILE, before: old.raw });
  return ops;
}

export const migration0002: Migration = Object.freeze({
  id: "0002-comments-jsonl",
  introducedIn: "0.54.0",
  title: "comments.json becomes comments.jsonl, one event a line",
  plan,
});

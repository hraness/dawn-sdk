// SPDX-License-Identifier: MIT
/**
 * Comments in a link, and back (docs/design/project-link.md, "Comment
 * rows"). A link carries each comment's folded state, not the lines that
 * made it: one row a comment, with one target.
 *
 * A retained anchor preserves names, bar ranges and older placement data
 * when the target alone cannot carry them. A row does not keep a suggested
 * rename, the actor, who resolved a comment and when, or when it was edited.
 */
import type { LinkComment, LinkTarget } from "../link/index.ts";
import type { TrackScore } from "../score.ts";
import { barStartTick } from "../tempo.ts";
import {
  type Comment,
  type CommentAnchor,
  type CommentEvent,
  type FoldedComments,
  commentId,
  commentIdBytes,
  eventLine,
} from "./events.ts";

/** Comments one link holds (core/link's bound). */
export const LINK_COMMENTS = 1024;

const toBase64url = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
};
const fromBase64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/gu, "+").replace(/_/gu, "/")), (char) =>
    char.charCodeAt(0),
  );

const fold = (name: string) => name.trim().replace(/\s+/gu, " ").toLowerCase();

function targetOf(anchor: CommentAnchor, score: TrackScore): LinkTarget {
  const track =
    anchor.track !== undefined &&
    score.tracks.some((item) => item.id === anchor.track)
      ? anchor.track
      : null;
  if (track !== null && anchor.notes && anchor.notes.length > 0) {
    const rows = [...anchor.notes]
      .map((row) => [row[0], row[1], row[2]] as const)
      .sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1])
      .filter(
        (row, index, list) =>
          index === 0 || row.join(":") !== list[index - 1]!.join(":"),
      );
    return [track, rows];
  }
  let range = anchor.ticks;
  if (!range && anchor.bars)
    range = [
      barStartTick(score, anchor.bars[0]),
      barStartTick(score, anchor.bars[1]),
    ];
  if (!range && anchor.section !== undefined) {
    const section = score.sections.find(
      (item) => fold(item.name) === fold(anchor.section!),
    );
    if (section)
      range = [
        barStartTick(score, section.startBar),
        barStartTick(score, section.startBar + section.bars),
      ];
  }
  if (range && range[1] > range[0]) return [track, [range[0], range[1]]];
  return track;
}

export type LinkedComments = Readonly<{
  rows: readonly LinkComment[];
  /** Live comments in the project. */
  live: number;
  /** Live comments that are not in `rows`, and why. */
  left: number;
  reason?: string;
}>;

/**
 * The rows for a project's comments, for a link of `score` whose revision
 * is `revision`. Deleted comments are left out unless a carried reply needs
 * its parent. Past the link's bound whole threads are left out: resolved
 * ones first, oldest first, then the oldest open ones.
 */
export function commentsForLink(
  folded: FoldedComments,
  score: TrackScore,
  revision: string,
): LinkedComments {
  const byId = new Map(folded.comments.map((item) => [item.id, item]));
  // A merged file can put replies before parents: follow the complete fold.
  const roots = new Map<string, Comment | undefined>();
  const firstOf = (comment: Comment): Comment | undefined => {
    const seen = new Set<string>();
    const path: string[] = [];
    let next: Comment | undefined = comment;
    let first: Comment | undefined;
    while (next) {
      if (roots.has(next.id)) {
        first = roots.get(next.id);
        break;
      }
      if (seen.has(next.id)) break;
      seen.add(next.id);
      path.push(next.id);
      if (next.thread === undefined) {
        first = next;
        break;
      }
      next = byId.get(next.thread);
    }
    for (const id of path) roots.set(id, first);
    return first;
  };
  const live = folded.comments.filter(
    (comment) => comment.state !== "deleted",
  ).length;
  let orphaned = 0;
  let empty = 0;
  // Threads in file order: a first comment and its replies.
  const threads = new Map<string, Comment[]>();
  for (const comment of folded.comments) {
    const first = firstOf(comment);
    if (!first) {
      if (comment.state !== "deleted") orphaned += 1;
      continue;
    }
    if (comment.state !== "deleted" && comment.text === "") empty += 1;
    const key = first.id;
    const list = threads.get(key);
    if (list) list.push(comment);
    else threads.set(key, [comment]);
  }
  type Thread = {
    key: string;
    items: Comment[];
    open: boolean;
    at: string;
    /** Its place in the file: later is newer when the clocks agree. */
    index: number;
  };
  const kept: Thread[] = [];
  for (const [key, grouped] of threads) {
    const root = byId.get(key);
    const all =
      root && root.thread === undefined
        ? [root, ...grouped.filter((item) => item.id !== key)]
        : grouped;
    // A live first comment with no words cannot be carried as a parent.
    // Leave its whole thread out rather than promote one of its replies.
    if (all[0]!.state !== "deleted" && all[0]!.text === "") {
      empty += all.filter(
        (item) => item.state !== "deleted" && item.text !== "",
      ).length;
      continue;
    }
    // A comment with no words is not one a link can hold.
    const items = all.filter(
      (item) => item.state !== "deleted" && item.text !== "",
    );
    if (items.length === 0) continue;
    const first = all[0]!;
    // A deleted first comment stays as a row so its replies have a parent.
    const rows = first.state === "deleted" ? [first, ...items] : items;
    kept.push({
      key,
      items: rows,
      index: kept.length,
      open: items.some((item) => item.state === "open"),
      at: items.reduce(
        (latest, item) => (item.at > latest ? item.at : latest),
        "",
      ),
    });
  }
  const size = (list: readonly Thread[]) =>
    list.reduce((sum, thread) => sum + thread.items.length, 0);
  let chosen = kept;
  if (size(kept) > LINK_COMMENTS) {
    // Open before resolved, newer before older, whole threads only.
    const ranked = [...kept].sort(
      (a, b) =>
        Number(b.open) - Number(a.open) ||
        (a.at < b.at ? 1 : a.at > b.at ? -1 : b.index - a.index),
    );
    const take = new Set<string>();
    let count = 0;
    for (const thread of ranked) {
      if (count + thread.items.length > LINK_COMMENTS) continue;
      take.add(thread.key);
      count += thread.items.length;
    }
    chosen = kept.filter((thread) => take.has(thread.key));
  }
  const rows: LinkComment[] = [];
  let carried = 0;
  for (const thread of chosen) {
    const first = thread.items[0]!;
    for (const comment of thread.items) {
      if (comment.state !== "deleted") carried += 1;
      const isFirst = comment === first;
      const { rev } = comment.anchor;
      const seconds = Math.floor(Date.parse(comment.at) / 1000);
      const target = targetOf(comment.anchor, score);
      const { rev: _rev, ...original } = comment.anchor;
      const retain =
        comment.anchor.section !== undefined ||
        comment.anchor.bars !== undefined ||
        comment.anchor.was !== undefined ||
        (comment.anchor.track !== undefined &&
          !score.tracks.some((track) => track.id === comment.anchor.track));
      // A comment on the whole song, or a reply, points at nothing a
      // revision could change, so an unrecorded one is not worth a field.
      const plain = rev === undefined && target === null && !retain;
      rows.push({
        id: commentIdBytes(comment.id),
        target,
        text: comment.state === "deleted" ? "" : comment.text.normalize("NFC"),
        ...(comment.author !== undefined ? { author: comment.author } : {}),
        ...(Number.isSafeInteger(seconds) && seconds > 0
          ? { time: seconds }
          : {}),
        ...(isFirst ? {} : { thread: commentIdBytes(first.id) }),
        ...(comment.state !== "open" ? { state: comment.state } : {}),
        ...(retain ? { anchor: original } : {}),
        ...(rev === revision || plain
          ? {}
          : {
              revision:
                rev === undefined ? new Uint8Array(0) : fromBase64url(rev),
            }),
      });
    }
  }
  const left = live - carried;
  const reasons: string[] = [];
  if (orphaned > 0)
    reasons.push(
      `${orphaned} replies have no first comment in this file; their threads cannot travel`,
    );
  if (empty > 0)
    reasons.push(
      `${empty} comments have no text or need a first comment with no text`,
    );
  if (left > orphaned + empty)
    reasons.push(
      `a link holds ${LINK_COMMENTS.toLocaleString("en-US")} comments; whole threads were left out, resolved ones first, then the oldest`,
    );
  return {
    rows,
    live,
    left,
    ...(left > 0
      ? {
          reason: reasons.join("; "),
        }
      : {}),
  };
}

async function derivedId(kind: string, id: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`dawn.comment/v1\0${kind}\0`);
  const bytes = new Uint8Array(head.length + id.length);
  bytes.set(head);
  bytes.set(id, head.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return commentId(hash.slice(0, 16));
}

const isoOf = (seconds: number | undefined) =>
  new Date((seconds ?? 0) * 1000).toISOString().replace(/\.000Z$/u, "Z");

/** The anchor a row's target and revision stand for. */
export function anchorOfRow(
  row: LinkComment,
  revision: string,
  score?: TrackScore,
): CommentAnchor {
  const rev =
    row.revision === undefined
      ? revision
      : row.revision.length === 0
        ? undefined
        : toBase64url(row.revision);
  const target = row.target;
  const base = rev === undefined ? {} : { rev };
  if (row.anchor !== undefined) return { ...row.anchor, ...base };
  if (target === null) return base;
  if (typeof target === "string") return { ...base, track: target };
  const [track, second, third] = target as readonly [
    string | null,
    number | readonly unknown[],
    number?,
  ];
  const named = track === null ? {} : { track };
  if (typeof second === "number") {
    if (third === undefined)
      return { ...base, ...named, ticks: [second, second + 1] };
    const found = score?.notes.filter(
      (note) =>
        note.trackId === track &&
        note.startTick === second &&
        note.pitch === third,
    );
    return {
      ...base,
      ...named,
      notes:
        found && found.length > 0
          ? found.map(
              (note) =>
                [note.startTick, note.durationTicks, note.pitch] as const,
            )
          : [[second, 0, third]],
    };
  }
  if (Array.isArray(second[0]))
    return {
      ...base,
      ...named,
      notes: (second as readonly (readonly number[])[]).map(
        (row) => [row[0]!, row[1]!, row[2]!] as const,
      ),
    };
  return {
    ...base,
    ...named,
    ticks: [second[0] as number, second[1] as number],
  };
}

/**
 * The text of a `comments.jsonl` for the comments a link carries. The same
 * link gives the same text: the ids of the `resolve` and `delete` lines are
 * derived from the comment's id.
 */
export async function commentLinesFromLink(
  rows: readonly LinkComment[],
  revision: string,
  score?: TrackScore,
): Promise<string> {
  let text = "";
  for (const row of rows) {
    const id = commentId(row.id);
    const at = isoOf(row.time);
    const add: CommentEvent = {
      v: 1,
      id,
      kind: "add",
      at,
      ...(row.author !== undefined ? { author: row.author } : {}),
      ...(row.thread !== undefined ? { thread: commentId(row.thread) } : {}),
      text: row.text,
      anchor: anchorOfRow(row, revision, score),
    };
    text += eventLine(add);
    const state = row.state ?? "open";
    if (state !== "open")
      text += eventLine({
        v: 1,
        id: await derivedId(state, row.id),
        kind: state === "resolved" ? "resolve" : "delete",
        at,
        // A delete counts only from the comment's author.
        ...(state === "deleted" && row.author !== undefined
          ? { author: row.author }
          : {}),
        of: id,
      });
  }
  return text;
}

// SPDX-License-Identifier: MIT
/** `comments.jsonl`: lines in, folded comments out. */
import { describe, expect, test } from "bun:test";
import {
  COMMENT_LIMITS,
  type CommentEvent,
  commentId,
  commentIdBytes,
  eventLine,
  eventProblem,
  findComment,
  isCommentId,
  liveComments,
  parseCommentLines,
  readComments,
} from "./events.ts";

const id = (n: number) => commentId(new Uint8Array(16).fill(n));
const AT = "2026-11-14T12:00:00Z";
const add = (n: number, more: Partial<CommentEvent> = {}): CommentEvent => ({
  v: 1,
  id: id(n),
  kind: "add",
  at: AT,
  text: `comment ${n}`,
  ...more,
});
const about = (
  n: number,
  kind: CommentEvent["kind"],
  of: number,
  more: Partial<CommentEvent> = {},
): CommentEvent => ({ v: 1, id: id(n), kind, at: AT, of: id(of), ...more });
const file = (...events: CommentEvent[]) => events.map(eventLine).join("");

describe("ids", () => {
  test("an id is 16 bytes in base64url, 22 characters", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, i) => 250 - i * 7);
    const text = commentId(bytes);
    expect(text).toHaveLength(22);
    expect(isCommentId(text)).toBe(true);
    expect(commentIdBytes(text)).toEqual(bytes);
    expect(isCommentId("c1")).toBe(false);
    expect(isCommentId(`${text}A`)).toBe(false);
    expect(() => commentId(new Uint8Array(8))).toThrow("16 bytes");
    const canonical = commentId(new Uint8Array(16));
    const alias = canonical.slice(0, -1) + "B";
    expect(isCommentId(alias)).toBe(false);
    expect(() => commentIdBytes(alias)).toThrow("not a comment id");
  });
});

describe("lines", () => {
  test("the same event is the same bytes, whatever order its keys came in", () => {
    const one = eventLine({
      v: 1,
      id: id(1),
      kind: "add",
      at: AT,
      author: "ada",
      text: "too busy",
      anchor: { rev: "r".repeat(42) + "s", track: "hats", bars: [8, 12] },
    });
    const two = eventLine({
      anchor: { bars: [8, 12], track: "hats", rev: "r".repeat(42) + "s" },
      text: "too busy",
      author: "ada",
      at: AT,
      kind: "add",
      id: id(1),
      v: 1,
    });
    expect(two).toBe(one);
    expect(one.endsWith("\n")).toBe(true);
    expect(one.slice(0, -1)).not.toContain("\n");
    expect(parseCommentLines(one).events).toHaveLength(1);
  });

  test("a line that does not parse is skipped, counted, and the rest is read", () => {
    const text = [
      eventLine(add(1)).trimEnd(),
      "{ not json",
      JSON.stringify({ v: 2, id: id(2), kind: "add", at: AT, text: "later" }),
      JSON.stringify({ v: 1, id: id(3), kind: "pin", at: AT }),
      JSON.stringify({ v: 1, id: "c7", kind: "add", at: AT, text: "old id" }),
      "",
      `${eventLine(add(4)).trimEnd()}\r`,
      // A line cut short by a crash.
      eventLine(add(5)).slice(0, 40),
    ].join("\n");
    const read = readComments(text);
    expect(read.comments.map((comment) => comment.id)).toEqual([id(1), id(4)]);
    expect(read.skipped.map((line) => line.line)).toEqual([2, 3, 4, 5, 8]);
    expect(read.skipped[0]!.reason).toBe("not JSON");
    expect(read.skipped[1]!.reason).toContain("line version 2");
    expect(read.skipped[2]!.reason).toContain("pin");
  });

  test("the caps: text, author, notes, one track for notes, line length", () => {
    const refused: [Partial<CommentEvent>, string][] = [
      [{ text: "x".repeat(COMMENT_LIMITS.text + 1) }, "longer than"],
      [{ author: "a".repeat(COMMENT_LIMITS.author + 1) }, "handle"],
      [{ author: "" }, "handle"],
      [{ at: "yesterday" }, "UTC"],
      [{ at: "2026-99-99T12:00:00Z" }, "UTC"],
      [{ anchor: { rev: "B".repeat(43) } }, "digest"],
      [
        {
          anchor: { was: { rows: Array(COMMENT_LIMITS.anchorValues).fill(0) } },
        },
        "values",
      ],
      [{ anchor: { was: { value: Number.NaN } } }, "JSON"],
      [{ anchor: { bars: [4, 4] } }, "bars"],
      [{ anchor: { notes: [[0, 480, 60]] } }, "name it"],
      [{ anchor: { track: "a", notes: [[0, 480, 128]] } }, "note row"],
      [
        {
          anchor: {
            track: "a",
            notes: Array.from(
              { length: COMMENT_LIMITS.notes + 1 },
              (_, i) => [i, 1, 60] as const,
            ),
          },
        },
        "at most",
      ],
      [{ thread: "c1" }, "thread"],
    ];
    for (const [change, message] of refused)
      expect(eventProblem({ ...add(1), ...change })).toContain(message);
    // Characters, not UTF-16 units: 4,096 of anything fit.
    expect(
      eventProblem(add(1, { text: "🎹".repeat(COMMENT_LIMITS.text) })),
    ).toBeUndefined();
    expect(eventProblem(about(2, "resolve", 1))).toBeUndefined();
    expect(
      eventProblem({ ...about(2, "resolve", 1), of: undefined }),
    ).toContain("which comment");
    expect(() => eventLine({ ...add(1), at: "now" })).toThrow("UTC");
    const long = JSON.stringify(add(1, { text: "x".repeat(4000) }));
    const padded = `${long.slice(0, -1)},"pad":"${"y".repeat(COMMENT_LIMITS.line)}"}`;
    expect(readComments(`${padded}\n`).skipped[0]!.reason).toContain("longer");
  });
});

describe("the fold", () => {
  test("add, edit, resolve, reopen and delete, in file order", () => {
    const read = readComments(
      file(
        add(1, { author: "ada" }),
        add(2, { author: "ana", thread: id(1) }),
        about(3, "edit", 1, { author: "ada", text: "comment 1, edited" }),
        about(4, "resolve", 1, { author: "ana", at: "2026-11-14T13:00:00Z" }),
        add(5),
        about(6, "resolve", 5),
        about(7, "reopen", 5),
      ),
    );
    expect(read.skipped).toEqual([]);
    const [first, reply, other] = read.comments;
    expect(first).toMatchObject({
      id: id(1),
      text: "comment 1, edited",
      state: "resolved",
      edited: AT,
      resolved: { at: "2026-11-14T13:00:00Z", author: "ana" },
    });
    expect(reply).toMatchObject({ thread: id(1), state: "open" });
    expect(other!.state).toBe("open");
    expect(other!.resolved).toBeUndefined();
  });

  test("an id seen twice is used once: the first line wins", () => {
    const read = readComments(
      file(
        add(1, { text: "first" }),
        add(1, { text: "second" }),
        about(2, "resolve", 1),
        // The same resolve again, as a union merge leaves it.
        about(2, "resolve", 1),
        // An id that was a resolve cannot come back as a reopen.
        { ...about(2, "reopen", 1) },
      ),
    );
    expect(read.comments).toHaveLength(1);
    expect(read.comments[0]).toMatchObject({
      text: "first",
      state: "resolved",
    });
  });

  test("two clones' lines merged in either order fold to the same comments", () => {
    const base = [add(1, { author: "ada" })];
    const mine = [
      add(2, { author: "ada", thread: id(1) }),
      about(3, "resolve", 1),
    ];
    const theirs = [add(4, { author: "ana" }), about(5, "resolve", 1)];
    const state = (events: CommentEvent[]) =>
      readComments(file(...events))
        .comments.map((c) => `${c.id}:${c.state}:${c.text}`)
        .sort();
    expect(state([...base, ...mine, ...theirs])).toEqual(
      state([...base, ...theirs, ...mine]),
    );
  });

  test("delete is soft: the row stays, with no text, and replies keep their parent", () => {
    const read = readComments(
      file(
        add(1, { author: "ada", rename: { track: "bass", to: "Sub" } }),
        add(2, { thread: id(1) }),
        about(3, "delete", 1, { author: "ada" }),
        // Nothing reaches a deleted comment.
        about(4, "edit", 1, { author: "ada", text: "back" }),
        about(5, "reopen", 1),
      ),
    );
    expect(read.comments).toHaveLength(2);
    expect(read.comments[0]).toMatchObject({ state: "deleted", text: "" });
    expect(read.comments[0]!.rename).toBeUndefined();
    expect(read.comments[1]!.thread).toBe(id(1));
    expect(liveComments(read).map((comment) => comment.id)).toEqual([id(2)]);
  });

  test("only the author edits or deletes; anyone resolves", () => {
    const read = readComments(
      file(
        add(1, { author: "ada" }),
        about(2, "delete", 1, { author: "ana" }),
        about(3, "edit", 1, { text: "mine now" }),
        about(4, "resolve", 1, { author: "ana" }),
        // No author on both is the same author.
        add(5),
        about(6, "delete", 5),
      ),
    );
    expect(read.comments[0]).toMatchObject({
      text: "comment 1",
      state: "resolved",
    });
    expect(read.comments[1]!.state).toBe("deleted");
  });

  test("threads are one level: a reply to a reply joins the first comment", () => {
    const read = readComments(
      file(add(1), add(2, { thread: id(1) }), add(3, { thread: id(2) })),
    );
    expect(read.comments.map((comment) => comment.thread)).toEqual([
      undefined,
      id(1),
      id(1),
    ]);
  });

  test("an event about a comment that is not here does nothing", () => {
    const read = readComments(file(about(1, "resolve", 9), add(2)));
    expect(read.comments.map((comment) => comment.state)).toEqual(["open"]);
  });

  test("past 2,000 live comments the rest are counted, not folded", () => {
    const events: CommentEvent[] = [];
    const nth = (n: number) => {
      const bytes = new Uint8Array(16);
      new DataView(bytes.buffer).setUint32(0, n);
      return commentId(bytes);
    };
    for (let n = 0; n < COMMENT_LIMITS.live + 3; n += 1)
      events.push({ v: 1, id: nth(n), kind: "add", at: AT, text: "x" });
    const read = readComments(file(...events));
    expect(read.comments).toHaveLength(COMMENT_LIMITS.live);
    expect(read.over).toBe(3);
  });

  test("a comment is found by its id or the start of one", () => {
    const read = readComments(file(add(1), add(2)));
    expect(findComment(read, id(2))).toMatchObject({ ok: true });
    expect(findComment(read, id(2).slice(0, 6))).toMatchObject({ ok: true });
    expect(findComment(read, "zzzz")).toMatchObject({
      ok: false,
      reason: "none",
    });
    expect(findComment(read, id(1).slice(0, 2))).toMatchObject({ ok: false });
  });
});

// SPDX-License-Identifier: MIT
/** Comments into a link's rows and back into lines. */
import { describe, expect, test } from "bun:test";
import { createScore } from "../score.ts";
import { placeAnchor } from "./place.ts";
import { fixtureScore } from "../link/fixture.ts";
import { decodeLink, encodeLink } from "../link/index.ts";
import {
  type Comment,
  type CommentEvent,
  commentId,
  eventLine,
  readComments,
} from "./events.ts";
import {
  LINK_COMMENTS,
  anchorOfRow,
  commentLinesFromLink,
  commentsForLink,
} from "./link.ts";

const nth = (n: number) => {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(0, n);
  bytes[15] = 1;
  return commentId(bytes);
};
const at = (n: number) =>
  new Date(1_794_000_000_000 + n * 1000).toISOString().replace(".000Z", "Z");
const add = (n: number, more: Partial<CommentEvent> = {}): CommentEvent => ({
  v: 1,
  id: nth(n),
  kind: "add",
  at: at(n),
  text: `comment ${n}`,
  ...more,
});
const about = (
  n: number,
  kind: CommentEvent["kind"],
  of: number,
  more: Partial<CommentEvent> = {},
): CommentEvent => ({
  v: 1,
  id: nth(n),
  kind,
  at: at(n),
  of: nth(of),
  ...more,
});
const fold = (...events: CommentEvent[]) =>
  readComments(events.map(eventLine).join(""));

const score = fixtureScore();
const bare = await encodeLink(score);
if (!bare.ok) throw new Error(bare.message);
const REV = bare.revision;
const OTHER = "A".repeat(43);

/** What a fold says, without what a link does not keep. */
const said = (text: string) =>
  readComments(text).comments.map((c) => ({
    id: c.id,
    text: c.text,
    author: c.author,
    at: c.at,
    thread: c.thread,
    state: c.state,
    anchor: c.anchor,
  }));

describe("comments in a link", () => {
  test("every kind of anchor goes out and comes back", async () => {
    const folded = fold(
      add(1, { author: "ada" }),
      add(2, { author: "ana", anchor: { rev: REV, track: "lead" } }),
      add(3, { anchor: { rev: REV, track: "kick", bars: [0, 1] } }),
      add(4, { anchor: { rev: REV, ticks: [480, 960] } }),
      add(5, {
        anchor: {
          rev: REV,
          track: "lead",
          // Out of order and with one twice: a set of notes has one spelling.
          notes: [
            [480, 240, 65],
            [0, 480, 62],
            [0, 240, 62],
            [480, 240, 65],
          ],
        },
      }),
      add(6, { anchor: { rev: OTHER, track: "lead", bars: [1, 2] } }),
      // No revision recorded: not known to be this score.
      add(7, { anchor: { bars: [0, 2] } }),
      add(8, { thread: nth(1), author: "ana" }),
      about(9, "resolve", 2, { author: "ada" }),
    );
    const linked = commentsForLink(folded, score, REV);
    expect(linked).toMatchObject({ live: 8, left: 0 });
    expect(linked.reason).toBeUndefined();
    const made = await encodeLink({ score, comments: linked.rows });
    if (!made.ok) throw new Error(made.message);
    // Comments do not move the revision; they do move the digest.
    expect(made.revision).toBe(REV);
    expect(made.digest).not.toBe(REV);
    const read = await decodeLink(made.fragment);
    if (!read.ok) throw new Error(read.message);
    expect(read.comments).toHaveLength(8);

    const anchors = read.comments.map((row) => anchorOfRow(row, read.revision));
    // Rows are a thread at a time: the reply follows its first comment.
    expect(anchors).toEqual([
      { rev: REV },
      { rev: REV },
      { rev: REV, track: "lead" },
      { rev: REV, track: "kick", bars: [0, 1] },
      { rev: REV, ticks: [480, 960] },
      {
        rev: REV,
        track: "lead",
        notes: [
          [0, 240, 62],
          [0, 480, 62],
          [480, 240, 65],
        ],
      },
      { rev: OTHER, track: "lead", bars: [1, 2] },
      { bars: [0, 2] },
    ]);

    const text = await commentLinesFromLink(read.comments, read.revision);
    const back = said(text);
    expect(back.map((c) => c.state)).toEqual([
      "open",
      "open",
      "resolved",
      "open",
      "open",
      "open",
      "open",
      "open",
    ]);
    expect(back[1]).toMatchObject({ thread: nth(1), author: "ana" });
    expect(back[0]).toMatchObject({
      author: "ada",
      at: at(1),
      text: "comment 1",
    });

    // What came back goes out as the same link: a fixed point.
    const again = commentsForLink(readComments(text), score, REV);
    const second = await encodeLink({ score, comments: again.rows });
    expect(second.ok && second.fragment).toBe(made.fragment);
    // And the same link gives the same file, byte for byte.
    expect(await commentLinesFromLink(read.comments, read.revision)).toBe(text);
  });

  test("a missing section keeps its original place", () => {
    const sectioned = fold(
      add(1, { anchor: { rev: REV, section: "nowhere" } }),
    );
    // The target stays compatible; retained placement keeps the lost section.
    const row = commentsForLink(sectioned, score, REV).rows[0]!;
    expect(row.target).toBeNull();
    expect(placeAnchor(anchorOfRow(row, REV, score), score, REV)).toMatchObject(
      { state: "lost", was: { section: "nowhere" } },
    );
  });

  test("a track that is gone keeps its original name and bars", () => {
    const folded = fold(
      add(1, { anchor: { rev: OTHER, track: "gone", bars: [0, 1] } }),
    );
    const row = commentsForLink(folded, score, REV).rows[0]!;
    expect(row.target).toEqual([null, [0, 1920]]);
    expect(row.revision).toHaveLength(32);
    expect(placeAnchor(anchorOfRow(row, REV, score), score, REV)).toMatchObject(
      { state: "lost", was: { track: "gone", bars: [0, 1] } },
    );
  });

  test("lost and migrated multi-track placement survives encode, decode and open", async () => {
    const anchors = [
      { rev: OTHER, track: "old-bass", bars: [0, 1] as const },
      { rev: OTHER, section: "Old chorus", bars: [1, 2] as const },
      {
        bars: [0, 1] as const,
        was: {
          tracks: [
            { id: "a", name: "Bass" },
            { id: "b", name: "Keys" },
          ],
          notes: [{ t: 0.5, length: 0.2, pitch: 60 }],
        },
      },
    ];
    const linked = commentsForLink(
      fold(...anchors.map((anchor, i) => add(i + 1, { anchor }))),
      score,
      REV,
    );
    const made = await encodeLink({ score, comments: linked.rows });
    if (!made.ok) throw new Error(made.message);
    const read = await decodeLink(made.fragment);
    if (!read.ok) throw new Error(read.message);
    const opened = readComments(
      await commentLinesFromLink(read.comments, read.revision, read.score),
    );
    expect(opened.comments.map((comment) => comment.anchor)).toEqual(anchors);
    const places = opened.comments.map((comment) =>
      placeAnchor(comment.anchor, read.score, read.revision),
    );
    expect(places.map((place) => place.state)).toEqual([
      "lost",
      "lost",
      "moved",
    ]);
    expect(places[0]!.words).toContain("old-bass");
    expect(places[1]!.words).toContain("Old chorus");
    expect(places[2]!.was?.names).toEqual(["Bass", "Keys"]);
  });

  test("a retained range in 7/8 keeps ticks and seconds", async () => {
    const odd = createScore({
      tempoBpm: 120,
      bars: 4,
      beatsPerBar: 7,
      time: { meter: [{ bar: 0, beatsPerBar: 7, beatUnit: 8 }] },
      tracks: [{ id: "bass", name: "Bass", instrument: "synth" }],
    });
    const bare = await encodeLink(odd);
    if (!bare.ok) throw new Error(bare.message);
    const linked = commentsForLink(
      fold(
        add(1, { anchor: { rev: bare.revision, track: "bass", bars: [1, 3] } }),
      ),
      odd,
      bare.revision,
    );
    const made = await encodeLink({ score: odd, comments: linked.rows });
    if (!made.ok) throw new Error(made.message);
    const read = await decodeLink(made.fragment);
    if (!read.ok) throw new Error(read.message);
    expect(
      placeAnchor(
        anchorOfRow(read.comments[0]!, read.revision, read.score),
        read.score,
        read.revision,
      ),
    ).toMatchObject({
      state: "exact",
      ticks: [1680, 5040],
      seconds: [1.75, 5.25],
    });
  });

  test("a deleted comment is carried only as the parent of a carried reply", async () => {
    const folded = fold(
      add(1, { author: "ada" }),
      add(2, { thread: nth(1) }),
      about(3, "delete", 1, { author: "ada" }),
      add(4, { author: "ada" }),
      about(5, "delete", 4, { author: "ada" }),
    );
    const linked = commentsForLink(folded, score, REV);
    expect(linked).toMatchObject({ live: 1, left: 0 });
    expect(linked.rows.map((row) => [row.state ?? "open", row.text])).toEqual([
      ["deleted", ""],
      ["open", "comment 2"],
    ]);
    const text = await commentLinesFromLink(linked.rows, REV);
    const back = readComments(text);
    expect(back.skipped).toEqual([]);
    expect(back.comments.map((c) => c.state)).toEqual(["deleted", "open"]);
    expect(back.comments[1]!.thread).toBe(nth(1));
  });

  test("past 1,024 whole threads are left out: resolved first, then the oldest", () => {
    const events: CommentEvent[] = [];
    // Thread 1 is the oldest and open, with a reply.
    events.push(add(1), add(2, { thread: nth(1) }));
    // 10 resolved, then enough open ones to pass the bound by 5.
    for (let n = 10; n < 20; n += 1) events.push(add(n));
    const open = LINK_COMMENTS - 2 + 5;
    for (let n = 100; n < 100 + open; n += 1) events.push(add(n));
    for (let n = 10; n < 20; n += 1) events.push(about(5000 + n, "resolve", n));
    const linked = commentsForLink(fold(...events), score, REV);
    expect(linked.live).toBe(2 + 10 + open);
    expect(linked.rows.length).toBeLessThanOrEqual(LINK_COMMENTS);
    expect(linked.left).toBe(linked.live - linked.rows.length);
    expect(linked.reason).toContain("1,024");
    const ids = new Set(linked.rows.map((row) => commentId(row.id)));
    // No resolved comment made it, and the newest open ones all did.
    for (let n = 10; n < 20; n += 1) expect(ids.has(nth(n))).toBe(false);
    expect(ids.has(nth(100 + open - 1))).toBe(true);
    // A thread is in whole or out whole.
    expect(ids.has(nth(1))).toBe(ids.has(nth(2)));
    // Rows stay in file order, a thread at a time.
    const order = linked.rows.map((row) => commentId(row.id));
    const inFile = events.filter((e) => e.kind === "add").map((e) => e.id);
    expect(order).toEqual(inFile.filter((id) => ids.has(id)));
  });

  test("older target forms open as the nearest anchor", () => {
    const id = new Uint8Array(16).fill(3);
    expect(anchorOfRow({ id, target: ["kick", 480], text: "x" }, REV)).toEqual({
      rev: REV,
      track: "kick",
      ticks: [480, 481],
    });
    expect(
      anchorOfRow({ id, target: ["lead", 0, 62], text: "x" }, REV, score),
    ).toEqual({
      rev: REV,
      track: "lead",
      notes: [
        [0, 240, 62],
        [0, 480, 62],
      ],
    });
    expect(
      anchorOfRow(
        { id, target: null, text: "x", revision: new Uint8Array(0) },
        REV,
      ),
    ).toEqual({});
  });
});

test("a merged reply before its first comment keeps the thread in a link", () => {
  const linked = commentsForLink(
    fold(add(2, { thread: nth(1) }), add(1)),
    score,
    REV,
  );
  expect(linked.rows.map((row) => commentId(row.id))).toEqual([nth(1), nth(2)]);
  expect(linked.rows[1]!.thread).toEqual(linked.rows[0]!.id);
});

test("a retained missing section with no recorded revision stays unrecorded", async () => {
  const linked = commentsForLink(
    fold(add(1, { anchor: { section: "Gone" } })),
    score,
    REV,
  );
  const made = await encodeLink({ score, comments: linked.rows });
  if (!made.ok) throw new Error(made.message);
  const read = await decodeLink(made.fragment);
  if (!read.ok) throw new Error(read.message);
  expect(anchorOfRow(read.comments[0]!, read.revision, read.score)).toEqual({
    section: "Gone",
  });
});

test("orphan replies and missing-root reply chains are counted and left out", () => {
  const linked = commentsForLink(
    fold(add(1, { thread: nth(99) }), add(2, { thread: nth(1) }), add(3)),
    score,
    REV,
  );
  expect(linked.rows.map((row) => commentId(row.id))).toEqual([nth(3)]);
  expect(linked).toMatchObject({ live: 3, left: 2 });
  expect(linked.reason).toContain("2 replies have no first comment");
});

test("out-of-order reply chains still name the actual first comment", () => {
  const linked = commentsForLink(
    fold(add(3, { thread: nth(2) }), add(2, { thread: nth(1) }), add(1)),
    score,
    REV,
  );
  expect(linked.rows.map((row) => commentId(row.id))).toEqual([
    nth(1),
    nth(3),
    nth(2),
  ]);
  expect(linked.rows.slice(1).map((row) => row.thread)).toEqual([
    linked.rows[0]!.id,
    linked.rows[0]!.id,
  ]);
});

test("an empty live parent cannot turn its reply into a new root", () => {
  const linked = commentsForLink(
    fold(add(1, { text: "" }), add(2, { thread: nth(1) })),
    score,
    REV,
  );
  expect(linked.rows).toEqual([]);
  expect(linked).toMatchObject({ live: 2, left: 2 });
  expect(linked.reason).toContain("2 comments");
  expect(linked.reason).toContain("no text");
});

test("a long merged tombstone chain is resolved in linear visits", () => {
  const count = 2001;
  let visits = 0;
  const comments = Array.from(
    { length: count },
    (_, index) =>
      new Proxy<Comment>(
        {
          id: nth(index + 1),
          text: index === count - 1 ? "Root" : "",
          at: at(index),
          state: index === count - 1 ? "open" : "deleted",
          anchor: {},
          ...(index < count - 1 ? { thread: nth(index + 2) } : {}),
        },
        {
          get(target, key, receiver) {
            if (key === "thread") visits += 1;
            return Reflect.get(target, key, receiver);
          },
        },
      ),
  );
  const linked = commentsForLink(
    { comments, skipped: [], over: 0 },
    score,
    REV,
  );
  expect(linked.rows).toHaveLength(1);
  expect(commentId(linked.rows[0]!.id)).toBe(nth(count));
  expect(visits).toBeLessThan(count * 8);
});

test("a cyclic reply chain is counted and cannot become a root", () => {
  const linked = commentsForLink(
    fold(add(1, { thread: nth(2) }), add(2, { thread: nth(1) })),
    score,
    REV,
  );
  expect(linked.rows).toEqual([]);
  expect(linked.left).toBe(2);
});

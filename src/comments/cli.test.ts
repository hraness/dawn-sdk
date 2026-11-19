// SPDX-License-Identifier: MIT
/** `dawn comments` against real project folders. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMENTS_FILE,
  COMMENT_LIMITS,
  commentId,
  eventLine,
  readComments,
} from "../../core/comments/events.ts";
import { fixtureScore } from "../../core/link/fixture.ts";
import { createScore, type TrackScore } from "../../core/score.ts";
import { printProject } from "../../core/sdk/print.ts";
import { revisionOfScore } from "../link/revision.ts";
import { initProject } from "../project/init.ts";
import { COMMENTS_SCHEMA, runCommentsCommand } from "./cli.ts";
import { appendCommentEvent, readCommentsFile } from "./file.ts";

const root = await mkdtemp(join(tmpdir(), "dawn-comments-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let made = 0;
async function project(score: TrackScore = fixtureScore()): Promise<string> {
  const dir = join(root, `p${(made += 1)}`);
  await initProject(dir, { agentDocs: false });
  await writeScore(dir, score);
  return dir;
}
async function writeScore(dir: string, score: TrackScore) {
  for (const file of printProject(score).files) {
    await mkdir(join(dir, file.path, ".."), { recursive: true });
    await writeFile(join(dir, file.path), file.text);
  }
}

let clock = 0;
let ids = 0;
const nextId = () => {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(0, (ids += 1));
  bytes[15] = 7;
  return commentId(bytes);
};
async function run(dir: string, argv: readonly string[], author?: string) {
  let out = "";
  let err = "";
  const code = await runCommentsCommand(
    ["comments", ...argv],
    dir,
    { write: (text) => (out += text) },
    { write: (text) => (err += text) },
    {
      author: async () => author,
      now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, (clock += 1))),
      id: nextId,
    },
  );
  return { code, out, err };
}
async function json(dir: string, argv: readonly string[], author?: string) {
  const result = await run(dir, [...argv, "--json"], author);
  expect(result.out.trim().split("\n")).toHaveLength(1);
  return { ...result, value: JSON.parse(result.out) };
}
const lines = async (dir: string) =>
  (await readFile(join(dir, COMMENTS_FILE), "utf8")).split("\n").slice(0, -1);

describe("dawn comments", () => {
  test("add stamps the revision and says where the comment lands", async () => {
    const dir = await project();
    const revision = await revisionOfScore(fixtureScore());
    const added = await json(
      dir,
      ["add", "  Too bright  ", "--track", "lead", "--bars", "0,1"],
      "ana",
    );
    expect(added.code).toBe(0);
    expect(added.value).toMatchObject({
      schema: COMMENTS_SCHEMA,
      ok: true,
      changed: true,
      revision,
      comment: {
        text: "Too bright",
        author: "ana",
        at: "2026-11-14T12:00:01Z",
        state: "open",
        own: true,
        replies: [],
        anchor: { rev: revision, track: "lead", bars: [0, 1] },
        now: {
          state: "exact",
          basis: "revision",
          earlier: false,
          track: { id: "lead", name: "Caf\u{e9} lead" },
          ticks: [0, 1920],
          seconds: [0, 2.5],
          bars: [0, 1],
          plays: [[0, 2.5]],
          notes: [],
          words: "Caf\u{e9} lead, bar 1",
        },
      },
    });
    const written = await lines(dir);
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toEqual({
      v: 1,
      id: added.value.comment.id,
      kind: "add",
      at: "2026-11-14T12:00:01Z",
      author: "ana",
      text: "Too bright",
      anchor: { rev: revision, track: "lead", bars: [0, 1] },
    });
  });

  test("a thread: reply, edit, resolve, reopen, delete, one line each", async () => {
    const dir = await project();
    const first = (await json(dir, ["add", "Slower?"], "ada")).value.comment;
    // A reply to a reply joins the first comment's thread.
    const reply = (
      await json(dir, ["reply", first.id.slice(0, 8), "Yes"], "ana")
    ).value.comment;
    expect(reply.thread).toBe(first.id);
    const second = (await json(dir, ["reply", reply.id, "By how much?"], "ada"))
      .value.comment;
    expect(second.thread).toBe(first.id);
    // A reply is about what its thread is about.
    expect(second.now.words).toBe("the song");

    const edited = await json(dir, ["edit", first.id, "Slower, by 4?"], "ada");
    expect(edited.value.comment).toMatchObject({
      text: "Slower, by 4?",
      edited: "2026-11-14T12:00:05Z",
    });
    // Anyone resolves, and it says who.
    const resolved = await json(dir, ["resolve", first.id], "ana");
    expect(resolved.value.comment).toMatchObject({
      state: "resolved",
      resolved: { author: "ana" },
      replies: [reply.id, second.id],
    });
    // The same again changes nothing and writes nothing.
    const again = await json(dir, ["resolve", first.id], "ada");
    expect(again.value).toMatchObject({ ok: true, changed: false });
    expect((await json(dir, ["reopen", first.id])).value.comment.state).toBe(
      "open",
    );
    const deleted = await json(dir, ["delete", first.id], "ada");
    expect(deleted.value.comment).toMatchObject({ state: "deleted", text: "" });
    expect(await lines(dir)).toHaveLength(7);

    // The deleted comment is still listed: its replies need a parent.
    const list = (await json(dir, [], "ana")).value;
    expect(list.counts).toEqual({ open: 2, resolved: 0, deleted: 1 });
    expect(list.comments.map((c: { state: string }) => c.state)).toEqual([
      "deleted",
      "open",
      "open",
    ]);
    expect(list.comments.map((c: { own: boolean }) => c.own)).toEqual([
      false,
      true,
      false,
    ]);
    const text = await run(dir, []);
    expect(text.out).toContain("(deleted)");
    expect(text.out).toContain("2 open, 0 resolved, 1 deleted");
  });

  test("list: revision, the song, and each comment's place now", async () => {
    const dir = await project();
    const revision = await revisionOfScore(fixtureScore());
    await run(dir, [
      "add",
      "This one",
      "--track",
      "lead",
      "--note",
      "480,240,65",
    ]);
    await run(dir, ["add", "Whole kick", "--track", "kick"]);
    const list = (await json(dir, ["list"])).value;
    expect(list).toMatchObject({
      schema: COMMENTS_SCHEMA,
      ok: true,
      file: true,
      revision,
      author: null,
      counts: { open: 2, resolved: 0, deleted: 0 },
      over: 0,
      skipped: [],
      song: {
        ticksPerBeat: 480,
        beatsPerBar: 4,
        bars: 2,
        ticks: 3840,
        seconds: 5,
      },
    });
    expect(list.comments[0].now).toMatchObject({
      state: "exact",
      ticks: [480, 720],
      seconds: [0.625, 0.9375],
      notes: [[480, 240, 65]],
    });

    // The score changes: the note is gone and the kick is renamed.
    const next = createScore({
      ...fixtureScore().toJSON(),
      tracks: fixtureScore()
        .toJSON()
        .tracks!.map((track) =>
          track.id === "kick" ? { ...track, name: "Big kick" } : track,
        ),
      notes: fixtureScore()
        .toJSON()
        .notes!.filter((note) => note.id !== "c"),
    });
    await writeScore(dir, next);
    const later = (await json(dir, ["list"])).value;
    expect(later.revision).toBe(await revisionOfScore(next));
    expect(later.revision).not.toBe(revision);
    // Lost is said, with what it had; it is still listed and answerable.
    expect(later.comments[0].now).toMatchObject({
      state: "lost",
      earlier: true,
      ticks: null,
      seconds: null,
      track: { id: "lead" },
      was: { track: "lead", notes: 1 },
    });
    expect(later.comments[0].now.words).toContain("on an earlier version");
    expect(later.comments[1].now).toMatchObject({
      state: "exact",
      basis: "content",
      earlier: true,
      track: { id: "kick", name: "Big kick" },
    });
    const reply = await json(dir, ["reply", later.comments[0].id, "Gone now"]);
    expect(reply.code).toBe(0);
    const text = await run(dir, []);
    expect(text.out).toContain("on an earlier version (lead, 1 note)");
  });

  test("no file is no comments, and nothing is written by reading", async () => {
    const dir = await project();
    const list = await json(dir, []);
    expect(list.value).toMatchObject({ ok: true, file: false, comments: [] });
    expect((await run(dir, [])).out).toBe("no comments\n");
    expect((await readCommentsFile(dir)).exists).toBe(false);
  });

  test("score: the revision and every note's start and length in ticks", async () => {
    const dir = await project();
    const report = (await json(dir, ["score"])).value;
    expect(report).toEqual({
      schema: "dawn.comments-score/v1",
      ok: true,
      revision: await revisionOfScore(fixtureScore()),
      ticksPerBeat: 480,
      beatsPerBar: 4,
      bars: 2,
      ticks: 3840,
      seconds: 5,
      tracks: [
        { id: "lead", name: "Caf\u{e9} lead" },
        { id: "kick", name: "Kick" },
        { id: "rest", name: "Nothing yet" },
      ],
      sections: [],
      notes: {
        lead: [
          [0, 240, 62],
          [0, 480, 62],
          [480, 240, 65],
          [960, 240, 69],
        ],
        kick: [
          [0, 120, 36],
          [480, 120, 36],
        ],
        rest: [],
      },
    });
  });

  test("every refusal has a reason and a hint, in text and in JSON", async () => {
    const dir = await project();
    const mine = (await json(dir, ["add", "Mine"], "ada")).value.comment;
    const before = await lines(dir);
    const cases: [readonly string[], string | undefined, string][] = [
      [["add", "x", "--track", "nope"], "ada", "no_such_track"],
      [["add", "x", "--section", "Bridge"], "ada", "no_such_section"],
      [["add", "x", "--bars", "2,4"], "ada", "bad_range"],
      [["add", "x", "--bars", "1,1"], "ada", "bad_range"],
      [["add", "x", "--ticks", "0,99999"], "ada", "bad_range"],
      [["add", "x", "--note", "0,480,62"], "ada", "notes_need_a_track"],
      [
        ["add", "x", "--track", "lead", "--note", "1,2,3"],
        "ada",
        "no_such_note",
      ],
      [["add", "   "], "ada", "no_text"],
      [["add", "x".repeat(COMMENT_LIMITS.text + 1)], "ada", "too_long"],
      [["add", "x", "--id", "c7"], "ada", "bad_id"],
      [["reply", "zzzzzz", "x"], "ada", "no_such_comment"],
      [["resolve", "zzzzzz"], "ada", "no_such_comment"],
      // Only the author edits or deletes.
      [["edit", mine.id, "Yours"], "ana", "not_yours"],
      [["delete", mine.id], "ana", "not_yours"],
      [["delete", mine.id], undefined, "not_yours"],
    ];
    for (const [argv, author, code] of cases) {
      const result = await json(dir, argv, author);
      expect(result.code).toBe(1);
      expect(result.value).toMatchObject({
        schema: COMMENTS_SCHEMA,
        ok: false,
        code,
      });
      expect(result.value.reason.length).toBeGreaterThan(8);
      expect(result.value.hint.length).toBeGreaterThan(8);
      const text = await run(dir, argv, author);
      expect(text.code).toBe(1);
      expect(text.out).toBe("");
      expect(text.err).toBe(`${result.value.reason} · ${result.value.hint}\n`);
    }
    // Not one of them wrote a line.
    expect(await lines(dir)).toEqual(before);

    await run(dir, ["delete", mine.id], "ada");
    const gone = await json(dir, ["resolve", mine.id], "ada");
    expect(gone.value).toMatchObject({ ok: false, code: "deleted" });

    const outside = await json(root, ["list"]);
    expect(outside.value).toMatchObject({ ok: false, code: "not_a_project" });

    const usage = await run(dir, ["pin", "x"]);
    expect(usage.code).toBe(2);
    expect(usage.err).toContain("usage: dawn comments");
    expect((await run(dir, ["add"])).code).toBe(2);
    for (const argv of [["pin", "x"], ["add"], ["list", "--unknown"]]) {
      const result = await json(dir, argv);
      expect(result.code).toBe(2);
      expect(result.value).toMatchObject({ ok: false, code: "usage" });
      expect(result.value.reason).toBeTruthy();
      expect(result.value.hint).toBeTruthy();
    }
    expect((await run(dir, ["add", "x", "--bars"])).code).toBe(2);
    expect(
      (await run(dir, ["reply", mine.id, "x", "--bars", "0,1"])).code,
    ).toBe(2);
    const help = await run(dir, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: dawn comments");
  });

  test("a project that does not evaluate still lists, and says why add cannot", async () => {
    const dir = await project();
    await run(dir, ["add", "Before it broke", "--bars", "0,1"]);
    await writeFile(join(dir, "song.ts"), "export default (;\n");
    const list = await json(dir, []);
    expect(list.code).toBe(0);
    expect(list.value).toMatchObject({ revision: null, song: null });
    expect(list.value.comments[0].now).toBeNull();
    expect((await run(dir, [])).err).toContain("does not evaluate");
    const add = await json(dir, ["add", "x"]);
    expect(add.value).toMatchObject({ ok: false, code: "does_not_evaluate" });
    // Resolving needs no score.
    expect((await json(dir, ["resolve", list.value.comments[0].id])).code).toBe(
      0,
    );
  });

  test("--id makes a retry the same comment; --agent says who wrote it", async () => {
    const dir = await project();
    const id = commentId(new Uint8Array(16).fill(9));
    const first = await json(dir, [
      "add",
      "Once",
      "--id",
      id,
      "--agent",
      "Claude",
    ]);
    expect(first.value).toMatchObject({ changed: true });
    expect(first.value.comment.actor).toEqual({
      kind: "agent",
      name: "Claude",
    });
    const retry = await json(dir, ["add", "Once", "--id", id]);
    expect(retry.value).toMatchObject({ ok: true, changed: false });
    expect(await lines(dir)).toHaveLength(1);
    const person = await json(dir, ["add", "By hand", "--person"]);
    expect(person.value.comment.actor).toEqual({ kind: "person" });
    expect(
      (await run(dir, ["add", "x", "--person", "--agent", "a"])).code,
    ).toBe(2);
  });

  test("a line that does not parse is kept where it is and counted", async () => {
    const dir = await project();
    await run(dir, ["add", "First"]);
    const path = join(dir, COMMENTS_FILE);
    const junk = '{"v":9,"kind":"from the future"}\n{ torn';
    await writeFile(path, (await readFile(path, "utf8")) + junk);
    const added = await run(dir, ["add", "Second"]);
    expect(added.code).toBe(0);
    const text = await readFile(path, "utf8");
    // The torn line got its newline; nothing before it was rewritten.
    expect(text).toContain(`${junk}\n{"v":1`);
    const list = await json(dir, []);
    expect(list.value.comments).toHaveLength(2);
    expect(list.value.skipped.map((s: { line: number }) => s.line)).toEqual([
      2, 3,
    ]);
    expect((await run(dir, [])).err).toContain("2 lines of comments.jsonl");
  });

  test("the 2,000th comment is the last", async () => {
    const dir = await project();
    let text = "";
    for (let n = 0; n < COMMENT_LIMITS.live; n += 1)
      text += eventLine({
        v: 1,
        id: nextId(),
        kind: "add",
        at: "2026-11-14T00:00:00Z",
        text: "x",
      });
    await writeFile(join(dir, COMMENTS_FILE), text);
    const full = await json(dir, ["add", "One more"]);
    expect(full.value).toMatchObject({ ok: false, code: "too_many" });
    // Resolving and deleting still work at the bound.
    const first = readComments(text).comments[0]!;
    expect((await json(dir, ["delete", first.id])).code).toBe(0);
    expect((await json(dir, ["add", "Room now"])).code).toBe(0);
  });

  test("text from a file is printed escaped", async () => {
    const dir = await project();
    await run(dir, ["add", "red \u001b[31malert\u0007"]);
    const text = await run(dir, []);
    expect(text.out).not.toContain("\u001b");
    expect(text.out).not.toContain("\u0007");
  });
});

describe("appendCommentEvent", () => {
  test("many writers at once: every line whole, none lost", async () => {
    const dir = await project();
    const script = join(root, "writer.ts");
    await writeFile(
      script,
      `import { appendCommentEvent } from ${JSON.stringify(join(import.meta.dir, "file.ts"))};
import { commentId } from ${JSON.stringify(join(import.meta.dir, "../../core/comments/events.ts"))};
const [dir, who] = process.argv.slice(2);
for (let n = 0; n < 100; n += 1) {
  const bytes = new Uint8Array(16);
  bytes[0] = Number(who);
  bytes[1] = n;
  await appendCommentEvent(dir!, { v: 1, id: commentId(bytes), kind: "add", at: "2026-11-14T00:00:00Z", text: "w" + who + " " + "x".repeat(900) });
}
`,
    );
    const writers = [1, 2, 3, 4].map((who) =>
      Bun.spawn([process.execPath, script, dir, String(who)], {
        stdout: "ignore",
        stderr: "inherit",
      }),
    );
    for (const writer of writers) expect(await writer.exited).toBe(0);
    const read = await readCommentsFile(dir);
    expect(read.folded.skipped).toEqual([]);
    expect(read.folded.comments).toHaveLength(400);
  });

  test("makes the file, and never rewrites what is there", async () => {
    const dir = await project();
    const id = commentId(new Uint8Array(16).fill(1));
    await appendCommentEvent(dir, {
      v: 1,
      id,
      kind: "add",
      at: "2026-11-14T00:00:00Z",
      text: "a",
    });
    const first = await readFile(join(dir, COMMENTS_FILE), "utf8");
    await appendCommentEvent(dir, {
      v: 1,
      id: commentId(new Uint8Array(16).fill(2)),
      kind: "resolve",
      at: "2026-11-14T00:00:01Z",
      of: id,
    });
    const second = await readFile(join(dir, COMMENTS_FILE), "utf8");
    expect(second.startsWith(first)).toBe(true);
    expect(second.split("\n")).toHaveLength(3);
  });
});

test("a caller's event id makes edit retries idempotent too", async () => {
  const dir = await project();
  const added = (await json(dir, ["add", "First"], "ada")).value.comment;
  const id = commentId(new Uint8Array(16).fill(199));
  const first = await json(
    dir,
    ["edit", added.id, "Second", "--id", id],
    "ada",
  );
  expect(first.value.changed).toBe(true);
  const retry = await json(dir, ["edit", added.id, "Third", "--id", id], "ada");
  expect(retry.value.changed).toBe(false);
  expect(retry.value.comment.text).toBe("Second");
});

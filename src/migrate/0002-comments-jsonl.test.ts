// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMENTS_FILE,
  commentId,
  eventLine,
  readComments,
} from "../../core/comments/events.ts";
import type { CommandRunner } from "../process/runner.ts";
import { checkProject } from "../project/check.ts";
import { syncProject } from "../project/sync.ts";
import {
  OLD_COMMENTS_FILE,
  linesFromOldComments,
  migration0002,
  oldCommentsStanding,
} from "./0002-comments-jsonl.ts";
import { runMigrateCommand } from "./cli.ts";
import { defaultMigrationContext } from "./context.ts";
import { diskFiles, overlay } from "./files.ts";
import { HELD_MIGRATIONS, MIGRATIONS } from "./index.ts";
import { copyFixture, snapshotTree } from "./migrate-fixtures.ts";
import {
  applyPlan,
  planMigrations,
  planProject,
  undoMigration,
} from "./run.ts";
import type { FileOp, MigrationContext } from "./types.ts";

const ID = "0002-comments-jsonl";
const FIXTURES = join(import.meta.dir, "fixtures", ID);
const CONTEXT: MigrationContext = Object.freeze({
  dawnVersion: "0.54.0",
  sdkSource: 'export const SDK_VERSION = "1.60.0";\n',
  sdkTsconfig: "{}\n",
  agentsBlock: "<!-- dawn:begin -->\n# dawn project\n<!-- dawn:end -->\n",
});
const NOW = new Date("2026-11-14T00:00:00Z");
const dirs: string[] = [];
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "dawn-step-0002-"));
  dirs.push(dir);
  copyFixture(join(FIXTURES, "before"), dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const plan = (dir: string) =>
  planMigrations(diskFiles(dir), CONTEXT, [migration0002]);
const pathOf = (op: FileOp) => (op.op === "rename" ? op.to : op.path);
const isState = (path: string) => path.startsWith(".dawn");
const noGit: CommandRunner = {
  which: () => undefined,
  run: async () => ({ code: 1, stdout: "", stderr: "", killed: false }),
};
async function migrate(dir: string, argv: readonly string[]) {
  let out = "";
  let err = "";
  const code = await runMigrateCommand(
    ["migrate", ...argv],
    dir,
    { write: (text) => (out += text) },
    { write: (text) => (err += text) },
    { context: CONTEXT, runner: noGit, now: NOW },
  );
  return { code, out, err };
}
const old = (comments: unknown[], more: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schema: "dawn.comments/v1", song: "Paper Boats", comments, ...more }, null, 2)}\n`;
const anchor = {
  t0: 0,
  t1: 4,
  bars: { from: { bar: 1, beat: 1 }, to: { bar: 3, beat: 1 } },
  sections: [],
  all_tracks: true,
  tracks: [],
  note_count: 0,
  notes: [],
};
const entry = (n: number, more: Record<string, unknown> = {}) => ({
  id: `c${n}`,
  status: "open",
  created: "2026-11-10T09:00:00Z",
  text: `comment ${n}`,
  anchor,
  ...more,
});

describe(ID, () => {
  test("before → after", async () => {
    const dir = project();
    const planned = plan(dir);
    expect(planned.pending.map((m) => m.id)).toEqual([ID]);
    await applyPlan(dir, planned, NOW);
    expect(snapshotTree(dir, isState)).toEqual(
      snapshotTree(join(FIXTURES, "after")),
    );
    expect(existsSync(join(dir, OLD_COMMENTS_FILE))).toBe(false);
  });

  test("what each kind of comment becomes", () => {
    const dir = project();
    const read = readComments(
      (
        plan(dir).ops.find(
          (op) => op.op === "write" && op.path === COMMENTS_FILE,
        ) as { after: string }
      ).after,
    );
    expect(read.skipped).toEqual([]);
    const [song, addressed, rename, notes, several] = read.comments;
    // No author, no revision: the old file has neither.
    for (const comment of read.comments) {
      expect(comment.author).toBeUndefined();
      expect(comment.anchor.rev).toBeUndefined();
    }
    // Bars count from 1 in the old file and from 0 here.
    expect(song!.anchor).toMatchObject({ bars: [0, 16] });
    expect(song!.anchor.track).toBeUndefined();
    expect(addressed).toMatchObject({
      state: "resolved",
      at: "2026-11-10T09:05:00Z",
      resolved: { at: "2026-11-11T18:30:00Z" },
      text: "Too busy under the vocal.\nHalve it?",
      anchor: { track: "hats", section: "B", bars: [8, 12] },
    });
    expect(rename!.rename).toEqual({ track: "bass", to: "Sub" });
    // Notes in seconds cannot become ticks: kept as they were, under `was`.
    expect(notes!.anchor).toMatchObject({
      track: "bass",
      section: "B",
      bars: [8, 9],
      was: {
        t0: 16,
        t1: 17.25,
        note_count: 2,
        notes: [
          { track: "bass", t: 16, dur: 0.5, pitch: 43 },
          { track: "bass", t: 16.75, dur: 0.5, pitch: 46 },
        ],
      },
    });
    expect(notes!.anchor.notes).toBeUndefined();
    expect(notes!.text).toBe("この二つの音は長すぎる。");
    // Several tracks: no track, its bar range, and what it had under `was`.
    expect(several!.anchor.track).toBeUndefined();
    expect(several!.anchor.section).toBeUndefined();
    expect(several!.anchor).toMatchObject({
      bars: [4, 8],
      was: {
        sections: ["A", "B"],
        tracks: [
          { id: "kick", name: "Kick" },
          { id: "bass", name: "Bass" },
        ],
      },
    });
    // The fold has as many open and addressed comments as the old file.
    const before = JSON.parse(
      readFileSync(join(dir, OLD_COMMENTS_FILE), "utf8"),
    ) as { comments: { status: string }[] };
    const count = (status: string) =>
      before.comments.filter((c) => c.status === status).length;
    expect(read.comments.filter((c) => c.state === "open")).toHaveLength(
      count("open"),
    );
    expect(read.comments.filter((c) => c.state === "resolved")).toHaveLength(
      count("addressed"),
    );
  });

  test("planning its own output gives no edits", async () => {
    const dir = project();
    const planned = plan(dir);
    expect(plan(dir).ops).toEqual(planned.ops);
    expect(
      migration0002.plan(overlay(diskFiles(dir), planned.ops), CONTEXT),
    ).toEqual([]);
    await applyPlan(dir, planned, NOW);
    expect(plan(dir).ops).toEqual([]);
    expect(migration0002.plan(diskFiles(dir), CONTEXT)).toEqual([]);
  });

  test("the same file planned twice, and in two folders, gives the same bytes", () => {
    const one = project();
    const two = project();
    expect(plan(one).ops).toEqual(plan(one).ops);
    expect(plan(two).ops).toEqual(plan(one).ops);
    // Ids are derived from the song, the old id, the time and the text.
    const lines = linesFromOldComments("Paper Boats", [entry(1)]);
    expect(linesFromOldComments("Paper Boats", [entry(1)])).toEqual(lines);
    const other = [
      linesFromOldComments("Other", [entry(1)]),
      linesFromOldComments("Paper Boats", [entry(2, { text: "comment 1" })]),
      linesFromOldComments("Paper Boats", [entry(1, { text: "changed" })]),
      linesFromOldComments("Paper Boats", [
        entry(1, { created: "2026-11-10T09:00:01Z" }),
      ]),
    ];
    for (const list of other) expect(list[0]!.id).not.toBe(lines[0]!.id);
  });

  test("--apply then --undo restores comments.json byte for byte", async () => {
    const dir = project();
    const before = snapshotTree(dir, isState);
    const dry = await migrate(dir, ["--only", ID]);
    expect(dry.code).toBe(3);
    expect(dry.out).toContain(`1 pending: ${ID}`);
    expect(snapshotTree(dir, isState)).toEqual(before);
    const applied = await migrate(dir, ["--only", ID, "--apply"]);
    expect(applied.code).toBe(0);
    expect(snapshotTree(dir, isState)).toEqual(
      snapshotTree(join(FIXTURES, "after")),
    );
    const again = await migrate(dir, ["--only", ID]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already applied here");
    expect(undoMigration(dir)?.migrations).toEqual([ID]);
    expect(snapshotTree(dir, isState)).toEqual(before);
  });

  test("held: check, sync and a plain dawn migrate do not know it", async () => {
    expect(MIGRATIONS.map((m) => m.id)).not.toContain(ID);
    expect(HELD_MIGRATIONS.map((m) => m.id)).toEqual([ID]);
    const dir = project();
    const context = await defaultMigrationContext();
    expect(planProject(dir, context).pending).toEqual([]);
    const plain = await migrate(dir, []);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain("up to date");
    const report = await checkProject(dir);
    expect(
      report.diagnostics.filter((d) =>
        /migrat|comments\.json/iu.test(d.message),
      ),
    ).toEqual([]);
    const sync = await syncProject(dir, { context });
    expect(sync.status).not.toBe("needs-migrate");
    expect(existsSync(join(dir, OLD_COMMENTS_FILE))).toBe(true);
    expect(existsSync(join(dir, COMMENTS_FILE))).toBe(false);
    const list = await migrate(dir, ["--list"]);
    expect(list.out).toContain(`${ID}  (held)`);
    const unknown = await migrate(dir, ["--only", "0009-nothing"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("no migration with the id");
    expect((await migrate(dir, ["--only"])).code).toBe(2);
  });

  test("no file, an unreadable file and another schema are left where they are", async () => {
    const dir = project();
    const path = join(dir, OLD_COMMENTS_FILE);
    const cases: [string | null, string, string, number][] = [
      [null, "none", "no comments.json", 0],
      ["{ not json", "unreadable", "not readable", 1],
      ['{"schema":"dawn.comments/v1"}\n', "unreadable", "not readable", 1],
      [
        old([entry(1)], { schema: "dawn.comments/v2" }),
        "other-schema",
        "newer schema",
        1,
      ],
    ];
    for (const [text, standing, said, code] of cases) {
      if (text === null) rmSync(path);
      else writeFileSync(path, text);
      expect(oldCommentsStanding(diskFiles(dir))).toBe(
        standing as ReturnType<typeof oldCommentsStanding>,
      );
      expect(plan(dir).ops).toEqual([]);
      const result = await migrate(dir, ["--only", ID, "--apply"]);
      expect(result.code).toBe(code);
      expect(result.out).toContain(said);
      if (text !== null) expect(readFileSync(path, "utf8")).toBe(text);
      expect(existsSync(join(dir, COMMENTS_FILE))).toBe(false);
    }
  });

  test("both files present: lines already there are not added again", async () => {
    const dir = project();
    const planned = plan(dir);
    const whole = (
      planned.ops.find(
        (op) => op.op === "write" && op.path === COMMENTS_FILE,
      ) as {
        after: string;
      }
    ).after;
    const lines = whole.split("\n").slice(0, -1);
    // A clone that already has the first three lines and one of its own,
    // and whose file was cut off before its last newline.
    const mine = eventLine({
      v: 1,
      id: commentId(new Uint8Array(16).fill(4)),
      kind: "add",
      at: "2026-11-13T00:00:00Z",
      author: "ana",
      text: "Written after the move",
    }).trimEnd();
    const have = [...lines.slice(0, 3), mine].join("\n");
    writeFileSync(join(dir, COMMENTS_FILE), have);
    await applyPlan(dir, plan(dir), NOW);
    const after = readFileSync(join(dir, COMMENTS_FILE), "utf8");
    expect(after).toBe(`${have}\n${lines.slice(3).join("\n")}\n`);
    expect(existsSync(join(dir, OLD_COMMENTS_FILE))).toBe(false);
    const read = readComments(after);
    expect(read.skipped).toEqual([]);
    expect(read.comments).toHaveLength(6);

    // Everything already there: only the old file goes.
    const full = project();
    writeFileSync(join(full, COMMENTS_FILE), whole);
    const ops = plan(full).ops.filter((op) => pathOf(op) !== "dawn.json");
    expect(ops.map((op) => op.op)).toEqual(["delete"]);
  });

  test("an empty list, the 2,000 bound and the 4,000 character bound", async () => {
    const dir = project();
    const path = join(dir, OLD_COMMENTS_FILE);
    writeFileSync(path, old([]));
    const none = plan(dir).ops.filter((op) => pathOf(op) !== "dawn.json");
    expect(none.map((op) => [op.op, pathOf(op)])).toEqual([
      ["delete", OLD_COMMENTS_FILE],
    ]);

    const many = Array.from({ length: 2003 }, (_, n) =>
      entry(n + 1, n % 2 === 0 ? { status: "addressed" } : {}),
    );
    writeFileSync(path, old(many));
    const planned = plan(dir);
    const written = planned.ops.find(
      (op) => op.op === "write" && op.path === COMMENTS_FILE,
    ) as { after: string };
    const read = readComments(written.after);
    expect(read.skipped).toEqual([]);
    expect(read.over).toBe(0);
    // The desktop reads 2,000 and so does the step.
    expect(read.comments).toHaveLength(2000);
    expect(read.comments.filter((c) => c.state === "resolved")).toHaveLength(
      1000,
    );
    expect(new Set(read.comments.map((c) => c.id)).size).toBe(2000);
    // An addressed comment with no time of its own resolves at its created time.
    expect(read.comments[0]!.resolved).toEqual({ at: "2026-11-10T09:00:00Z" });

    const long = "長".repeat(4000);
    const [at4000] = linesFromOldComments("s", [entry(1, { text: long })]);
    expect(at4000!.text).toBe(long);
    const [past] = linesFromOldComments("s", [
      entry(1, { text: `  ${long}more\n` }),
    ]);
    expect([...past!.text!]).toHaveLength(4000);
  });

  test("entries the desktop would not show, and ones it would repair", () => {
    const lines = linesFromOldComments("s", [
      entry(1),
      // The same id again: the desktop renames it, so both are kept.
      entry(1, { text: "second c1" }),
      // No id: numbered by its place.
      { ...entry(0), id: undefined, text: "no id" },
      // No text: not a comment.
      { ...entry(9), text: undefined },
      { ...entry(9), text: "   " },
      "not an object",
      // No time: 1970, which says nobody knows.
      entry(5, { created: "last week" }),
      // An anchor with nothing usable: on the song, with what it said kept.
      entry(6, { anchor: "the loud bit" }),
      // An end inside a bar includes that bar; one bar is one bar.
      entry(7, {
        anchor: {
          ...anchor,
          bars: { from: { bar: 2, beat: 3 }, to: { bar: 4, beat: 2.5 } },
        },
      }),
      entry(8, {
        anchor: {
          ...anchor,
          bars: { from: { bar: 3, beat: 1 }, to: { bar: 3, beat: 1 } },
        },
      }),
      entry(10, { rename: { section: 2, to: "Bridge" } }),
    ]);
    expect(lines.map((line) => line.text)).toEqual([
      "comment 1",
      "second c1",
      "no id",
      "comment 5",
      "comment 6",
      "comment 7",
      "comment 8",
      "comment 10",
    ]);
    expect(new Set(lines.map((line) => line.id)).size).toBe(8);
    expect(lines[3]!.at).toBe("1970-01-01T00:00:00Z");
    expect(lines[4]!.anchor).toEqual({ was: { anchor: "the loud bit" } });
    expect(lines[5]!.anchor!.bars).toEqual([1, 4]);
    expect(lines[6]!.anchor!.bars).toEqual([2, 3]);
    expect(lines[7]!.rename).toEqual({ section: 2, to: "Bridge" });
    // Every line is one the reader takes.
    expect(readComments(lines.map(eventLine).join("")).skipped).toEqual([]);
  });
});

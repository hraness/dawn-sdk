// SPDX-License-Identifier: MIT
/**
 * `dawn comments`: a project's comments (docs/design/project-trace.md).
 *
 * The desktop drives this same surface and does not fold the file itself,
 * so `--json` on `list` carries everything a comment needs to be drawn:
 * where its anchor lands in the current score in ticks and in seconds, the
 * track's name now, and whether that place is exact, moved or lost. Every
 * refusal has a reason and a hint.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  COMMENT_LIMITS,
  COMMENTS_FILE,
  type AnchorNote,
  type Comment,
  type CommentActor,
  type CommentAnchor,
  type CommentEvent,
  type FoldedComments,
  commentId,
  findComment,
  isCommentId,
} from "../../core/comments/events.ts";
import { type Place, placeAnchor } from "../../core/comments/place.ts";
import { escapeText } from "../../core/link/text.ts";
import type { TrackScore } from "../../core/score.ts";
import { barStartTick, loopTicksOf, secondsAtTick } from "../../core/tempo.ts";
import { evaluateProject } from "../../core/sdk/eval.ts";
import { revisionOfScore } from "../link/revision.ts";
import { isProject } from "../project/init.ts";
import { appendCommentEvent, readCommentsFile } from "./file.ts";

type Output = { write(text: string): unknown };

export const COMMENTS_SCHEMA = "dawn.comments-cli/v1";

export const COMMENTS_USAGE = `usage: dawn comments [list] [--all] [--dir <project>] [--json]
       dawn comments add "<text>" [--track <id>] [--section <name>]
                         [--bars <first>,<past>] [--ticks <first>,<past>]
                         [--note <tick>,<length>,<pitch>]... [--id <id>]
       dawn comments reply <id> "<text>"
       dawn comments edit <id> "<text>"
       dawn comments resolve|reopen|delete <id>
       dawn comments score

Comments live in ${COMMENTS_FILE}, one event a line, append-only. An <id> is a
comment's id or the start of one. Bars and ticks are a first and one past
the last, from 0, as sections count them: --bars 8,12 is bars 9 to 12.
A comment has one track or none. Anyone resolves or reopens; only the
author edits or deletes, and a deleted comment keeps its replies.
--person or --agent <name> says who is writing; the author is the account
dawn login saved. score prints the written score's revision, tracks,
sections and note rows in ticks: what an anchor names.`;

export type CommentRefusal = Readonly<{
  schema: typeof COMMENTS_SCHEMA;
  ok: false;
  code: string;
  reason: string;
  hint: string;
}>;

export type CommentView = Comment &
  Readonly<{
    /** True when the caller may edit and delete it. */
    own: boolean;
    /** Ids of its replies, in order. Present on a first comment. */
    replies?: readonly string[];
    /** Where it lands in the current score; null when the project does not evaluate. */
    now: Place | null;
  }>;

export type CommentsDeps = Readonly<{
  /** The account's handle; undefined when nobody is logged in. */
  author?: () => Promise<string | undefined>;
  now?: () => Date;
  id?: () => string;
  evaluate?: typeof evaluateProject;
}>;

const VALUE_OPTIONS = new Set([
  "--dir",
  "--track",
  "--section",
  "--bars",
  "--ticks",
  "--note",
  "--id",
  "--agent",
]);
const FLAGS = new Set(["--json", "--all", "--person"]);
const VERBS = [
  "list",
  "add",
  "reply",
  "edit",
  "resolve",
  "reopen",
  "delete",
  "score",
] as const;
type Verb = (typeof VERBS)[number];

type Args = Readonly<{
  verb: Verb;
  words: readonly string[];
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, readonly string[]>;
}>;

function parse(
  rest: readonly string[],
):
  | { kind: "help" }
  | { kind: "error"; problem: string }
  | (Args & { kind: "run" }) {
  if (rest.some((arg) => arg === "--help" || arg === "-h"))
    return { kind: "help" };
  const words: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (FLAGS.has(arg)) flags.add(arg);
    else if (VALUE_OPTIONS.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined)
        return { kind: "error", problem: `${arg} needs a value` };
      i += 1;
      values.set(arg, [...(values.get(arg) ?? []), value]);
    } else if (arg.startsWith("--"))
      return {
        kind: "error",
        problem: `unknown option · ${escapeText(arg, 40)}`,
      };
    else words.push(arg);
  }
  for (const [name, list] of values)
    if (name !== "--note" && list.length > 1)
      return { kind: "error", problem: `${name} was given twice` };
  let verb: Verb = "list";
  if (words.length > 0) {
    if (!(VERBS as readonly string[]).includes(words[0]!))
      return {
        kind: "error",
        problem: `no such thing to do with comments · ${escapeText(words[0]!, 40)}`,
      };
    verb = words.shift() as Verb;
  }
  return { kind: "run", verb, words, flags, values };
}

const refusal = (
  code: string,
  reason: string,
  hint: string,
): CommentRefusal => ({
  schema: COMMENTS_SCHEMA,
  ok: false,
  code,
  reason,
  hint,
});

function numbers(text: string, count: number): number[] | undefined {
  const parts = text.split(",");
  if (parts.length !== count) return undefined;
  const out = parts.map((part) =>
    /^\d{1,12}$/u.test(part.trim()) ? Number(part.trim()) : NaN,
  );
  return out.some((value) => !Number.isSafeInteger(value)) ? undefined : out;
}

/** The anchor the options ask for, checked against the score. */
function anchorFrom(
  args: Args,
  score: TrackScore,
  revision: string | undefined,
): CommentAnchor | CommentRefusal {
  const one = (name: string) => args.values.get(name)?.[0];
  const anchor: {
    rev?: string;
    track?: string;
    section?: string;
    bars?: readonly [number, number];
    ticks?: readonly [number, number];
    notes?: AnchorNote[];
  } = {};
  if (revision !== undefined) anchor.rev = revision;
  const track = one("--track");
  if (track !== undefined) {
    if (!score.tracks.some((item) => item.id === track))
      return refusal(
        "no_such_track",
        `no track with the id ${escapeText(track, 64)}`,
        `the tracks are ${score.tracks.map((item) => escapeText(item.id, 64)).join(", ") || "none yet"}`,
      );
    anchor.track = track;
  }
  const section = one("--section");
  if (section !== undefined) {
    const fold = (name: string) =>
      name.trim().replace(/\s+/gu, " ").toLowerCase();
    const found = score.sections.find(
      (item) => fold(item.name) === fold(section),
    );
    if (!found)
      return refusal(
        "no_such_section",
        `no section named ${escapeText(section, 64)}`,
        score.sections.length > 0
          ? `the sections are ${score.sections.map((item) => escapeText(item.name, 64)).join(", ")}`
          : "this song has no sections; use --bars",
      );
    anchor.section = found.name;
  }
  const end = loopTicksOf(score);
  for (const name of ["--bars", "--ticks"] as const) {
    const text = one(name);
    if (text === undefined) continue;
    const pair = numbers(text, 2);
    const limit = name === "--bars" ? score.bars : end;
    if (!pair || pair[1]! <= pair[0]! || pair[1]! > limit)
      return refusal(
        "bad_range",
        `${name} ${escapeText(text, 40)} is not a range in this song`,
        `a first and one past the last, from 0, up to ${limit}: ${name} 0,${Math.min(limit, name === "--bars" ? 4 : score.ticksPerBeat * 4)}`,
      );
    anchor[name === "--bars" ? "bars" : "ticks"] = [pair[0]!, pair[1]!];
  }
  const notes = args.values.get("--note") ?? [];
  if (notes.length > 0) {
    if (anchor.track === undefined)
      return refusal(
        "notes_need_a_track",
        "notes are on a track",
        "say which: --track <id>",
      );
    if (notes.length > COMMENT_LIMITS.notes)
      return refusal(
        "too_many_notes",
        `a comment names at most ${COMMENT_LIMITS.notes} notes`,
        "name the bars instead: --bars <first>,<past>",
      );
    const have = new Set<string>();
    for (const note of score.notes)
      if (note.trackId === anchor.track)
        have.add(`${note.startTick}:${note.durationTicks}:${note.pitch}`);
    const rows: AnchorNote[] = [];
    for (const text of notes) {
      const row = numbers(text, 3);
      if (!row || !have.has(row.join(":")))
        return refusal(
          "no_such_note",
          `no note ${escapeText(text, 40)} on ${escapeText(anchor.track, 64)}`,
          "a note is <start tick>,<length in ticks>,<pitch>; dawn comments score --json lists them",
        );
      rows.push([row[0]!, row[1]!, row[2]!]);
    }
    anchor.notes = rows;
  }
  return anchor;
}

const isRefusal = (value: unknown): value is CommentRefusal =>
  typeof value === "object" &&
  value !== null &&
  (value as { ok?: unknown }).ok === false;

function views(
  folded: FoldedComments,
  score: TrackScore | undefined,
  revision: string | undefined,
  me: string | undefined,
): CommentView[] {
  const replies = new Map<string, string[]>();
  for (const comment of folded.comments) {
    if (comment.thread === undefined) continue;
    const list = replies.get(comment.thread);
    if (list) list.push(comment.id);
    else replies.set(comment.thread, [comment.id]);
  }
  const byId = new Map(folded.comments.map((item) => [item.id, item]));
  return folded.comments.map((comment) => {
    // A reply is about what its thread is about.
    const anchor =
      comment.thread !== undefined && Object.keys(comment.anchor).length === 0
        ? (byId.get(comment.thread)?.anchor ?? comment.anchor)
        : comment.anchor;
    return {
      ...comment,
      own: comment.author === me,
      ...(comment.thread === undefined
        ? { replies: replies.get(comment.id) ?? [] }
        : {}),
      now: score ? placeAnchor(anchor, score, revision) : null,
    };
  });
}

function textLine(view: CommentView, indent: string): string {
  const state =
    view.state === "open"
      ? "open    "
      : view.state === "resolved"
        ? "resolved"
        : "deleted ";
  const who = view.author ? escapeText(view.author, 64) : "-";
  const where =
    view.thread === undefined
      ? ` · ${view.now ? escapeText(view.now.words, 160) : "place unknown"}`
      : "";
  const text =
    view.state === "deleted"
      ? "(deleted)"
      : escapeText(view.text.split("\n")[0] ?? "", 200);
  return `${indent}${view.id.slice(0, 8)}  ${state}  ${who}  ${view.at.slice(0, 10)}${where} · ${text}\n`;
}

export async function runCommentsCommand(
  argv: readonly string[],
  cwd: string,
  out: Output,
  err: Output,
  deps: CommentsDeps = {},
): Promise<number> {
  const json = argv.includes("--json");
  const usage = (reason: string) => {
    const value = refusal(
      "usage",
      reason,
      "dawn comments --help lists the commands and their options",
    );
    if (json) out.write(`${JSON.stringify(value)}\n`);
    else
      err.write(
        `${reason} · ${COMMENTS_USAGE.split("\n")[0]} · ${value.hint}\n`,
      );
    return 2;
  };
  const parsed = parse(argv.slice(1));
  if (parsed.kind === "help") {
    out.write(`${COMMENTS_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") return usage(parsed.problem);
  const args = parsed;
  const wants: Record<Verb, number> = {
    list: 0,
    score: 0,
    add: 1,
    reply: 2,
    edit: 2,
    resolve: 1,
    reopen: 1,
    delete: 1,
  };
  if (args.words.length !== wants[args.verb])
    return usage(
      args.words.length < wants[args.verb]
        ? `dawn comments ${args.verb} needs ${wants[args.verb] === 1 ? (args.verb === "add" ? "the text" : "an id") : "an id and the text"}`
        : `unexpected argument · ${escapeText(args.words[wants[args.verb]]!, 40)}`,
    );
  if (args.flags.has("--person") && args.values.has("--agent"))
    return usage("--person or --agent, not both");

  const refuse = (value: CommentRefusal) => {
    if (json) out.write(`${JSON.stringify(value)}\n`);
    else err.write(`${value.reason} · ${value.hint}\n`);
    return 1;
  };
  const project = resolve(cwd, args.values.get("--dir")?.[0] ?? ".");
  if (!(await isProject(project)))
    return refuse(
      refusal(
        "not_a_project",
        "not a dawn project (no dawn.json here)",
        "run it in a project, or name one: --dir <project>",
      ),
    );
  let disk;
  try {
    disk = await readCommentsFile(project);
  } catch (error) {
    return refuse(
      refusal(
        "unreadable",
        `${COMMENTS_FILE} could not be read: ${escapeText((error as Error).message, 200)}`,
        "nothing was changed",
      ),
    );
  }
  const folded = disk.folded;
  const me = await deps.author?.();
  const evaluated = await (deps.evaluate ?? evaluateProject)(project);
  const score = evaluated.ok ? evaluated.score : undefined;
  const revision = score ? await revisionOfScore(score) : undefined;
  const doesNotEvaluate = () =>
    refusal(
      "does_not_evaluate",
      "the project does not evaluate, so there is no score to point into",
      "dawn check says why",
    );

  if (args.verb === "score") {
    if (!score) return refuse(doesNotEvaluate());
    const end = loopTicksOf(score);
    const notes: Record<string, [number, number, number][]> = {};
    for (const track of score.tracks) notes[track.id] = [];
    for (const note of score.notes)
      notes[note.trackId]?.push([
        note.startTick,
        note.durationTicks,
        note.pitch,
      ]);
    const report = {
      schema: "dawn.comments-score/v1",
      ok: true,
      revision: revision ?? null,
      ticksPerBeat: score.ticksPerBeat,
      beatsPerBar: score.beatsPerBar,
      bars: score.bars,
      ticks: end,
      seconds: secondsAtTick(score, end),
      tracks: score.tracks.map((track) => ({ id: track.id, name: track.name })),
      sections: score.sections.map((section) => ({
        name: section.name,
        startBar: section.startBar,
        bars: section.bars,
        ticks: [
          barStartTick(score, section.startBar),
          barStartTick(score, section.startBar + section.bars),
        ],
      })),
      notes,
    };
    if (json) out.write(`${JSON.stringify(report)}\n`);
    else
      out.write(
        `revision ${revision ?? "unknown"} · ${score.tracks.length} tracks, ${score.notes.length} notes, ${score.bars} bars, ${end} ticks · --json lists the note rows\n`,
      );
    return 0;
  }

  if (args.verb === "list") {
    const all = views(folded, score, revision, me);
    const shown = args.flags.has("--all")
      ? all
      : all.filter(
          (view) => view.state !== "deleted" || (view.replies?.length ?? 0) > 0,
        );
    const counts = { open: 0, resolved: 0, deleted: 0 };
    for (const view of all) counts[view.state] += 1;
    if (json)
      out.write(
        `${JSON.stringify({
          schema: COMMENTS_SCHEMA,
          ok: true,
          file: disk.exists,
          revision: revision ?? null,
          author: me ?? null,
          counts,
          over: folded.over,
          skipped: folded.skipped,
          song: score
            ? {
                ticksPerBeat: score.ticksPerBeat,
                beatsPerBar: score.beatsPerBar,
                bars: score.bars,
                ticks: loopTicksOf(score),
                seconds: secondsAtTick(score, loopTicksOf(score)),
              }
            : null,
          comments: shown,
        })}\n`,
      );
    else {
      const byId = new Map(shown.map((view) => [view.id, view]));
      for (const view of shown) {
        if (view.thread !== undefined && byId.has(view.thread)) continue;
        out.write(textLine(view, ""));
        for (const id of view.replies ?? []) {
          const reply = byId.get(id);
          if (reply) out.write(textLine(reply, "  "));
        }
      }
      if (shown.length === 0) out.write("no comments\n");
      else
        out.write(
          `${counts.open} open, ${counts.resolved} resolved${counts.deleted > 0 ? `, ${counts.deleted} deleted` : ""}\n`,
        );
      if (!score)
        err.write(
          "the project does not evaluate, so where each comment lands is not known · dawn check says why\n",
        );
      if (folded.skipped.length > 0)
        err.write(
          `${folded.skipped.length} ${folded.skipped.length === 1 ? "line" : "lines"} of ${COMMENTS_FILE} could not be read and ${folded.skipped.length === 1 ? "was" : "were"} left as ${folded.skipped.length === 1 ? "it is" : "they are"} (line ${folded.skipped[0]!.line}: ${escapeText(folded.skipped[0]!.reason, 120)})\n`,
        );
      if (folded.over > 0)
        err.write(
          `${folded.over} comments past the ${COMMENT_LIMITS.live.toLocaleString("en-US")} a project holds are not shown · delete some\n`,
        );
    }
    return 0;
  }

  // Everything below writes one line.
  const now = (deps.now ?? (() => new Date()))();
  const at = now.toISOString().replace(/\.\d{3}Z$/u, "Z");
  let id = (deps.id ?? (() => commentId(randomBytes(16))))();
  const given = args.values.get("--id")?.[0];
  if (given !== undefined) {
    if (!isCommentId(given))
      return refuse(
        refusal(
          "bad_id",
          "--id is not a comment id",
          "16 random bytes in base64url, 22 characters; leave it out and dawn makes one",
        ),
      );
    id = given;
  }
  const agent = args.values.get("--agent")?.[0];
  if (
    agent !== undefined &&
    (agent.length === 0 || agent.length > COMMENT_LIMITS.author)
  )
    return usage(
      `--agent is a name of 1 to ${COMMENT_LIMITS.author} characters`,
    );
  const actor: CommentActor | undefined =
    agent !== undefined
      ? { kind: "agent", name: agent }
      : args.flags.has("--person")
        ? { kind: "person" }
        : undefined;
  const envelope = {
    v: 1 as const,
    id,
    at,
    ...(me !== undefined ? { author: me } : {}),
    ...(actor ? { actor } : {}),
  };
  const textOf = (raw: string): string | CommentRefusal => {
    const text = raw.trim().normalize("NFC");
    if (text === "")
      return refusal(
        "no_text",
        "a comment needs words",
        'dawn comments add "<text>"',
      );
    const length = [...text].length;
    if (length > COMMENT_LIMITS.text)
      return refusal(
        "too_long",
        `the text is ${length.toLocaleString("en-US")} characters; a comment holds ${COMMENT_LIMITS.text.toLocaleString("en-US")}`,
        "shorten it, or split it into a comment and replies",
      );
    return text;
  };
  const find = (word: string): Comment | CommentRefusal => {
    const found = findComment(folded, word);
    if (found.ok) return found.comment;
    return found.reason === "none"
      ? refusal(
          "no_such_comment",
          `no comment with the id ${escapeText(word, 40)}`,
          "dawn comments lists them with their ids",
        )
      : refusal(
          "ambiguous_id",
          `${escapeText(word, 40)} is the start of more than one id`,
          `write more of it: ${found.matches.join(", ")}`,
        );
  };
  const done = async (event: CommentEvent | undefined, commentId: string) => {
    try {
      const changed = event ? await appendCommentEvent(project, event) : false;
      const after = await readCommentsFile(project);
      const view = views(after.folded, score, revision, me).find(
        (item) => item.id === commentId,
      );
      if (json)
        out.write(
          `${JSON.stringify({ schema: COMMENTS_SCHEMA, ok: true, changed, revision: revision ?? null, comment: view ?? null })}\n`,
        );
      else if (!changed)
        out.write(
          `${commentId.slice(0, 8)} is already ${view?.state ?? "so"}\n`,
        );
      else if (view) out.write(textLine(view, ""));
      return 0;
    } catch (error) {
      return refuse(
        refusal(
          "write_failed",
          `${COMMENTS_FILE} could not be updated: ${escapeText((error as Error).message, 200)}`,
          "existing comments were kept; list them before retrying",
        ),
      );
    }
  };

  if (args.verb === "add" || args.verb === "reply") {
    // The same id again is the same comment: a retry writes nothing.
    if (folded.comments.some((item) => item.id === id))
      return done(undefined, id);
    const live = folded.comments.filter((item) => item.state !== "deleted");
    if (live.length >= COMMENT_LIMITS.live)
      return refuse(
        refusal(
          "too_many",
          `this project has ${COMMENT_LIMITS.live.toLocaleString("en-US")} comments, the most it holds`,
          "delete some that are resolved: dawn comments delete <id>",
        ),
      );
    const text = textOf(args.words[args.verb === "add" ? 0 : 1]!);
    if (isRefusal(text)) return refuse(text);
    if (args.verb === "reply") {
      for (const name of [
        "--track",
        "--section",
        "--bars",
        "--ticks",
        "--note",
      ])
        if (args.values.has(name))
          return usage(
            `a reply is about what its thread is about; ${name} goes on a new comment`,
          );
      const parent = find(args.words[0]!);
      if (isRefusal(parent)) return refuse(parent);
      return done(
        { ...envelope, kind: "add", thread: parent.thread ?? parent.id, text },
        id,
      );
    }
    if (!score) return refuse(doesNotEvaluate());
    const anchor = anchorFrom(args, score, revision);
    if (isRefusal(anchor)) return refuse(anchor);
    return done({ ...envelope, kind: "add", text, anchor }, id);
  }

  for (const name of ["--track", "--section", "--bars", "--ticks", "--note"])
    if (args.values.has(name))
      return usage(`${name} goes with dawn comments add`);
  const comment = find(args.words[0]!);
  if (isRefusal(comment)) return refuse(comment);
  const short = comment.id.slice(0, 8);
  if (comment.state === "deleted")
    return refuse(
      refusal(
        "deleted",
        `${short} was deleted`,
        "a deleted comment stays deleted; write a new one: dawn comments add",
      ),
    );
  if (args.verb === "edit" || args.verb === "delete") {
    if (comment.author !== me)
      return refuse(
        refusal(
          "not_yours",
          `${short} was written by ${comment.author ? escapeText(comment.author, 64) : "someone who was not logged in"}, and only its author ${args.verb}s a comment`,
          args.verb === "delete"
            ? `anyone may resolve it: dawn comments resolve ${short}`
            : `reply to it: dawn comments reply ${short} "<text>"`,
        ),
      );
    if (args.verb === "delete")
      return done({ ...envelope, kind: "delete", of: comment.id }, comment.id);
    const text = textOf(args.words[1]!);
    if (isRefusal(text)) return refuse(text);
    if (text === comment.text) return done(undefined, comment.id);
    return done(
      { ...envelope, kind: "edit", of: comment.id, text },
      comment.id,
    );
  }
  if (args.verb === "resolve")
    return comment.state === "resolved"
      ? done(undefined, comment.id)
      : done({ ...envelope, kind: "resolve", of: comment.id }, comment.id);
  return comment.state === "open"
    ? done(undefined, comment.id)
    : done({ ...envelope, kind: "reopen", of: comment.id }, comment.id);
}

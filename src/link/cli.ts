// SPDX-License-Identifier: MIT
/**
 * `dawn link [project] [--json]` writes the project's score as a link, and
 * `dawn open <link|file> [dir] [--json]` turns a link back into a project
 * folder of printed source (docs/design/project-link.md).
 *
 * A link carries the score, not the files: `dawn link` says what stays
 * behind before anyone finds out the hard way. Nothing is uploaded by either
 * command, and neither needs the sound engine.
 */
import { lstat, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  LINK_LIMITS,
  decodeLink,
  encodeLink,
  encodeScoreBytes,
  type LinkErrorCode,
} from "../../core/link/index.ts";
import { escapeText, findLinks } from "../../core/link/text.ts";
import { COMMENTS_FILE } from "../../core/comments/events.ts";
import {
  commentLinesFromLink,
  commentsForLink,
} from "../../core/comments/link.ts";
import { readCommentsFile } from "../comments/file.ts";
import { SCORE_VERSION, type TrackScore } from "../../core/score.ts";
import { evaluateProject } from "../../core/sdk/eval.ts";
import { printProject } from "../../core/sdk/print.ts";
import { tokenize } from "../migrate/lex.ts";
import { initProject, isProject, writeAtomic } from "../project/init.ts";

type Output = { write(text: string): unknown };

/** Where a link points. `dawn open` reads the part after the `#` only. */
export const LINK_BASE = "https://dawnav.com/open";

/** Past this many characters some apps cut a link short. */
export const LONG_LINK = 4000;

/** A file `dawn open` reads a link from may not be larger than this. */
const MAX_LINK_FILE_BYTES = 1024 * 1024;
/** The desktop's comment file remains separate until its migration is activated. */
const LEGACY_COMMENTS_FILE = "comments.json";

export const LINK_USAGE = `usage: dawn link [project] [--no-comments] [--json]
  prints the project's score as a link; what does not travel in it is said
  on stderr, so \`dawn link | pbcopy\` copies the link alone
  --no-comments leave the project's comments out of the link
  --json        one JSON object: the link and the notices`;

export const OPEN_USAGE = `usage: dawn open <link|file> [dir] [--json]
  reads a link (or the first one in a file) and writes it as a new project
  folder of printed source, with the comments it carries as comments.jsonl;
  never writes into a folder that has files
  --json        one JSON object: the folder and what was written`;

/** One audio file the score plays and the link does not hold. */
export type LinkAudio = Readonly<{
  src: string;
  /** A pack sound is fetched by its name; a file has to be sent. */
  kind: "pack" | "file";
  /** Size on disk, for a file that is there. */
  bytes?: number;
}>;

/** What the sender is told, in the order it is said. */
export type LinkNotice =
  | Readonly<{ kind: "own-code"; files: readonly string[]; message: string }>
  | Readonly<{ kind: "signals"; count: number; message: string }>
  | Readonly<{ kind: "audio"; files: readonly LinkAudio[]; message: string }>
  | Readonly<{
      kind: "comments";
      /** Comments in the link. */
      carried: number;
      /** Live comments left out of it. */
      left: number;
      message: string;
    }>
  | Readonly<{ kind: "legacy-comments"; file: string; message: string }>
  | Readonly<{ kind: "long"; length: number; message: string }>;

export type LinkReport =
  | Readonly<{
      schema: "dawn.link/v1";
      ok: true;
      link: string;
      /** The link's integrity check: every score byte, comments included. */
      digest: string;
      /** The score's own name: the digest of its bytes with no comments. */
      revision: string;
      codec: "c" | "d";
      /** Characters in the whole link. */
      length: number;
      scoreBytes: number;
      /** Comments in the link. */
      comments: number;
      notices: readonly LinkNotice[];
    }>
  | Readonly<{
      schema: "dawn.link/v1";
      ok: false;
      /** A codec result, or what stopped the command before it. */
      code:
        | LinkErrorCode
        | "not_a_project"
        | "does_not_evaluate"
        | "comments_unreadable";
      message: string;
      /** Characters the link would have had, when it is only too long. */
      length?: number;
    }>;

export type OpenReport =
  | Readonly<{
      schema: "dawn.open/v1";
      ok: true;
      dir: string;
      digest: string;
      /** The score's own name: the digest of its bytes with no comments. */
      revision: string;
      /** The score version the link was written at; older ones are upgraded. */
      scoreVersion: number;
      tracks: number;
      notes: number;
      /** Comments the link carried, now in comments.jsonl. */
      comments: number;
      files: readonly string[];
      /** Audio files the score plays that have to arrive some other way. */
      audio: readonly LinkAudio[];
    }>
  | Readonly<{
      schema: "dawn.open/v1";
      ok: false;
      code:
        | LinkErrorCode
        | "no_link"
        | "unreadable"
        | "would_overwrite"
        | "does_not_match";
      message: string;
    }>;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every audio file the score names, once each, in the score's order. */
export function scoreAudio(score: TrackScore): string[] {
  const data = score.toJSON() as unknown as { tracks?: unknown };
  const seen = new Set<string>();
  const take = (ref: unknown) => {
    if (!isRecord(ref) || typeof ref.src !== "string") return;
    if (ref.src.startsWith("builtin:")) return;
    seen.add(ref.src);
  };
  for (const track of Array.isArray(data.tracks) ? data.tracks : []) {
    if (!isRecord(track)) continue;
    if (isRecord(track.sampler) && isRecord(track.sampler.voices))
      Object.values(track.sampler.voices).forEach(take);
    if (isRecord(track.wavetable)) take(track.wavetable.table);
    if (isRecord(track.granular)) take(track.granular.src);
    for (const key of ["clips", "takes"])
      for (const item of Array.isArray(track[key]) ? track[key] : [])
        take(item);
  }
  return [...seen];
}

async function audioOf(score: TrackScore, project: string) {
  const files: LinkAudio[] = [];
  for (const src of scoreAudio(score)) {
    if (src.startsWith("pack:")) {
      files.push({ src, kind: "pack" });
      continue;
    }
    const path = resolve(project, src);
    let bytes: number | undefined;
    if (!relative(project, path).startsWith(".."))
      try {
        bytes = (await stat(path)).size;
      } catch {
        // Not there: still a file the receiver needs.
      }
    files.push({
      src,
      kind: "file",
      ...(bytes === undefined ? {} : { bytes }),
    });
  }
  return files;
}

/** The SDK's signal sources, as a project's source names them. */
const SIGNALS = new Set([
  "sine",
  "cosine",
  "saw",
  "isaw",
  "tri",
  "square",
  "rand",
  "perlin",
  "irand",
  "pat",
  "steady",
]);

/**
 * How many places in `source` start a signal: a signal source named in code,
 * outside strings, comments, imports and property names.
 */
export function signalsIn(source: string): number {
  const tokens = tokenize(source).filter(
    (token) => token.kind !== "ws" && token.kind !== "comment",
  );
  let count = 0;
  let importing = false;
  tokens.forEach((token, index) => {
    if (token.kind !== "ident") return;
    if (token.text === "import") importing = true;
    else if (token.text === "from") importing = false;
    if (importing || !SIGNALS.has(token.text)) return;
    const before = tokens[index - 1]?.text;
    const after = tokens[index + 1]?.text;
    if (before === "." || before === "?." || after === ":") return;
    count += 1;
  });
  return count;
}

/** The project's own `.ts` files: `song.ts` and everything under `tracks/`. */
async function sourceFiles(project: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(join(project, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < 6 && !entry.name.startsWith("."))
          await walk(path, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
    }
  };
  try {
    if ((await stat(join(project, "song.ts"))).isFile()) out.push("song.ts");
  } catch {
    // No song.ts: the evaluation has already said so.
  }
  await walk("tracks", 0);
  return out;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The four things a sender is told, each only when it applies. */
export async function linkNotices(
  score: TrackScore,
  project: string,
  length: number,
): Promise<LinkNotice[]> {
  const notices: LinkNotice[] = [];
  const printed = new Map(
    printProject(score).files.map((file) => [file.path, file.text]),
  );
  const sources = await sourceFiles(project);
  const texts = new Map<string, string>();
  for (const path of new Set([...printed.keys(), ...sources])) {
    const text = await readOptional(join(project, path));
    if (text !== undefined) texts.set(path, text);
  }

  const own = [...new Set([...printed.keys(), ...sources])]
    .filter((path) => texts.get(path) !== printed.get(path))
    .sort();
  if (own.length > 0)
    notices.push({
      kind: "own-code",
      files: own,
      message: `This link carries the song as DAWN prints it. Your own code in ${plural(own.length, "file")} becomes plain notes for whoever opens it: ${own.map((path) => escapeText(path, 120)).join(", ")}.`,
    });

  let signals = 0;
  for (const path of sources) signals += signalsIn(texts.get(path) ?? "");
  if (signals > 0)
    notices.push({
      kind: "signals",
      count: signals,
      message: `${plural(signals, "signal")} in the source ${signals === 1 ? "travels" : "travel"} as fixed points.`,
    });

  const audio = await audioOf(score, project);
  if (audio.length > 0) {
    const files = audio.filter((file) => file.kind === "file");
    const packs = audio.length - files.length;
    const bytes = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    const parts: string[] = [];
    if (packs > 0)
      parts.push(
        `${plural(packs, "is a pack sound", "are pack sounds")} DAWN fetches by name`,
      );
    if (files.length > 0)
      parts.push(
        `${plural(files.length, "has", "have")} to be sent with the link (${files.map((file) => escapeText(file.src, 120)).join(", ")})`,
      );
    notices.push({
      kind: "audio",
      files: audio,
      message: `${plural(audio.length, "audio file")}${bytes > 0 ? ` (${megabytes(bytes)})` : ""} ${audio.length === 1 ? "is" : "are"} not in the link: ${parts.join("; ")}.`,
    });
  }

  if (length > LONG_LINK)
    notices.push({
      kind: "long",
      length,
      message: `This is a long link (${length.toLocaleString("en-US")} characters); some apps cut it. A file holds it whole: dawn link > song.link.txt, then dawn open song.link.txt.`,
    });
  return notices;
}

/** What the sender is told about the comments: which travel, which do not. */
function commentNotices(
  carried: ReturnType<typeof commentsForLink> | undefined,
  unread: number,
): LinkNotice[] {
  if (!carried || (carried.live === 0 && unread === 0)) return [];
  const count = carried.live - carried.left;
  const parts: string[] = [];
  if (count > 0)
    parts.push(
      `${plural(count, "comment")} ${count === 1 ? "travels" : "travel"} in this link with ${count === 1 ? "its author's name" : "their authors' names"}; dawn link --no-comments leaves ${count === 1 ? "it" : "them"} out.`,
    );
  if (carried.left > 0)
    parts.push(
      `${plural(carried.left, "comment")} ${carried.left === 1 ? "is" : "are"} not in it: ${carried.reason ?? "a link holds only so many"}.`,
    );
  if (unread > 0)
    parts.push(
      `${plural(unread, "line")} of ${COMMENTS_FILE} could not be read and ${unread === 1 ? "is" : "are"} not in it.`,
    );
  return [
    {
      kind: "comments",
      carried: count,
      left: carried.left,
      message: parts.join(" "),
    },
  ];
}

/** Everything `dawn link` knows about the project in `project`. */
export async function linkReport(
  project: string,
  options: Readonly<{ comments?: boolean }> = {},
): Promise<LinkReport> {
  const schema = "dawn.link/v1" as const;
  if (!(await isProject(project)))
    return {
      schema,
      ok: false,
      code: "not_a_project",
      message: "not a dawn project (no dawn.json here)",
    };
  const evaluated = await evaluateProject(project);
  if (!evaluated.ok) {
    const first = evaluated.diagnostics[0];
    const where = first?.file
      ? `${first.file}${first.line === undefined ? "" : `:${first.line}`} · `
      : "";
    return {
      schema,
      ok: false,
      code: "does_not_evaluate",
      message: `${where}${first?.message ?? "song.ts did not evaluate"} · dawn check says more`,
    };
  }
  // The project's comments ride along, unless asked not to.
  let carried: ReturnType<typeof commentsForLink> | undefined;
  let unread = 0;
  let legacyComments = false;
  if (options.comments !== false) {
    // Presence alone: legacy contents are neither read nor changed here.
    legacyComments =
      (await lstat(join(project, LEGACY_COMMENTS_FILE)).catch(
        () => undefined,
      )) !== undefined;
    let disk;
    try {
      disk = await readCommentsFile(project);
    } catch (error) {
      return {
        schema,
        ok: false,
        code: "comments_unreadable",
        message: `${COMMENTS_FILE} could not be read (${escapeText((error as Error).message, 200)}) · dawn link --no-comments makes the link without the comments`,
      };
    }
    if (disk.exists) {
      const bare = await encodeLink(evaluated.score, {
        limits: { ...LINK_LIMITS, url: Infinity, fragment: Infinity },
      });
      if (bare.ok) {
        carried = commentsForLink(disk.folded, evaluated.score, bare.revision);
        unread = disk.folded.skipped.length;
      }
    }
  }
  const rows = carried?.rows ?? [];
  const document =
    rows.length > 0
      ? { score: evaluated.score, comments: rows }
      : evaluated.score;
  const made = await encodeLink(document, { base: LINK_BASE });
  if (!made.ok) {
    if (made.code !== "fragment_too_long" && made.code !== "url_too_long")
      return { schema, ok: false, code: made.code, message: made.message };
    // Only too long: say by how much, from the same link made without the bound.
    const whole = await encodeLink(document, {
      base: LINK_BASE,
      limits: { ...LINK_LIMITS, url: Infinity, fragment: Infinity },
    });
    const length = whole.ok ? whole.fragment.length - 1 : undefined;
    // The comments may be what took it over.
    if (
      rows.length > 0 &&
      (await encodeLink(evaluated.score, { base: LINK_BASE })).ok
    )
      return {
        schema,
        ok: false,
        code: made.code,
        message: `with its ${plural(rows.length, "comment")} this song is too long for a link${length === undefined ? "" : `: ${length.toLocaleString("en-US")} characters; a link holds ${LINK_LIMITS.fragment.toLocaleString("en-US")}`}. Nothing was uploaded. dawn link --no-comments leaves the comments out.`,
        ...(length === undefined ? {} : { length }),
      };
    return {
      schema,
      ok: false,
      code: made.code,
      message: `this song is too long for a link: ${length === undefined ? "more than" : `${length.toLocaleString("en-US")} characters; a link holds`} ${LINK_LIMITS.fragment.toLocaleString("en-US")}${length === undefined ? " characters" : ""}. Nothing was uploaded. Send the project folder.`,
      ...(length === undefined ? {} : { length }),
    };
  }
  return {
    schema,
    ok: true,
    link: made.link,
    digest: made.digest,
    revision: made.revision,
    codec: made.codec,
    length: made.link.length,
    scoreBytes: made.scoreBytes,
    comments: rows.length,
    notices: [
      ...commentNotices(carried, unread),
      ...(legacyComments
        ? [
            {
              kind: "legacy-comments" as const,
              file: LEGACY_COMMENTS_FILE,
              message:
                "comments.json is not read into this link. It stays in the project folder; send the folder to keep that file.",
            },
          ]
        : []),
      ...(await linkNotices(evaluated.score, project, made.link.length)),
    ],
  };
}

type Parsed =
  | { kind: "help" }
  | { kind: "error"; problem: string }
  | { kind: "run"; positionals: string[]; json: boolean; flags: Set<string> };

function parse(
  rest: readonly string[],
  most: number,
  known: readonly string[] = [],
): Parsed {
  if (rest.some((arg) => arg === "--help" || arg === "-h"))
    return { kind: "help" };
  const positionals: string[] = [];
  let json = false;
  const flags = new Set<string>();
  for (const arg of rest) {
    if (arg === "--json") json = true;
    else if (known.includes(arg)) flags.add(arg);
    // A link is not an option, though a fragment may begin with one's dash.
    else if (arg.startsWith("-") && arg.length > 1 && !arg.includes("#"))
      return {
        kind: "error",
        problem: `unknown option · ${escapeText(arg, 40)}`,
      };
    else positionals.push(arg);
  }
  if (positionals.length > most)
    return {
      kind: "error",
      problem: `unexpected argument · ${escapeText(positionals[most]!, 40)}`,
    };
  return { kind: "run", positionals, json, flags };
}

export async function runLinkCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  const parsed = parse(argv.slice(1), 1, ["--no-comments"]);
  if (parsed.kind === "help") {
    stdout.write(`${LINK_USAGE}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    stderr.write(`${parsed.problem} · ${LINK_USAGE.split("\n")[0]}\n`);
    return 2;
  }
  const report = await linkReport(resolve(cwd, parsed.positionals[0] ?? "."), {
    comments: !parsed.flags.has("--no-comments"),
  });
  if (parsed.json) stdout.write(`${JSON.stringify(report)}\n`);
  else if (report.ok) {
    for (const notice of report.notices) stderr.write(`${notice.message}\n`);
    stdout.write(`${report.link}\n`);
  } else stderr.write(`${report.message}\n`);
  return report.ok ? 0 : 1;
}

/** The text `dawn open` looks for a link in: a file's, or the word itself. */
async function linkText(
  word: string,
  cwd: string,
): Promise<
  | { ok: true; text: string }
  | { ok: false; code: "unreadable"; message: string }
> {
  // Something with a `#` and no path it could be is a link, not a file.
  let path: string | undefined;
  if (word.length <= 4096 && !word.includes("\0")) path = resolve(cwd, word);
  if (path !== undefined)
    try {
      const info = await stat(path);
      if (info.isFile()) {
        if (info.size > MAX_LINK_FILE_BYTES)
          return {
            ok: false,
            code: "unreadable",
            message: `${escapeText(word, 120)} is larger than a file with a link in it (1 MiB)`,
          };
        return { ok: true, text: await readFile(path, "utf8") };
      }
    } catch {
      // Not a file: the word is the link.
    }
  return { ok: true, text: word };
}

/** True when nothing is at `path`, or an empty folder is. */
async function free(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return false;
    return (await readdir(path)).length === 0;
  } catch {
    return true;
  }
}

/** A folder name for a link nobody named one for: its digest's first bytes. */
function folderFor(digest: string): string {
  const bytes = Buffer.from(digest, "base64url").subarray(0, 4);
  return `dawn-link-${bytes.toString("hex")}`;
}

/** Reads the link in `word` and writes it under `dir` (or a folder named for it). */
export async function openLink(
  word: string,
  dir: string | undefined,
  cwd: string,
): Promise<OpenReport> {
  const schema = "dawn.open/v1" as const;
  const source = await linkText(word, cwd);
  if (!source.ok) return { schema, ...source };
  const found = findLinks(source.text, 1)[0];
  if (!found)
    return {
      schema,
      ok: false,
      code: "no_link",
      message: "no DAWN link here: one has #d1. in it",
    };
  const read = await decodeLink(found.link);
  if (!read.ok)
    return {
      schema,
      ok: false,
      code: read.code,
      message: `this link does not open (${read.code}): ${escapeText(read.message)}`,
    };

  const target = resolve(cwd, dir ?? folderFor(read.digest));
  const shown = relative(cwd, target) || ".";
  if (!(await free(target)))
    return {
      schema,
      ok: false,
      code: "would_overwrite",
      message: `${escapeText(shown, 200)} is already there and is not empty; name another folder: dawn open <link> <dir>`,
    };
  // A link carries no note ids: the project derives its own.
  const files = printProject(read.score, { noteIds: false }).files;
  // The printer names files from track names; none may leave the folder.
  for (const file of files) {
    const path = resolve(target, file.path);
    if (path !== target && !path.startsWith(target + sep))
      return {
        schema,
        ok: false,
        code: "invalid_score",
        message:
          "this link does not open (invalid_score): a file outside the project",
      };
  }
  await mkdir(target, { recursive: true });
  for (const file of files) {
    await mkdir(dirname(join(target, file.path)), { recursive: true });
    await writeAtomic(join(target, file.path), file.text);
  }
  await initProject(target);
  // The comments the link carried, as the file a project keeps them in.
  if (read.comments.length > 0)
    await writeAtomic(
      join(target, COMMENTS_FILE),
      await commentLinesFromLink(read.comments, read.revision, read.score),
    );

  // What was written is evaluated and has to be the score the link named.
  const again = await evaluateProject(target);
  const same =
    again.ok &&
    Buffer.compare(
      encodeScoreBytes({ score: again.score }),
      encodeScoreBytes({ score: read.score }),
    ) === 0;
  if (!same)
    return {
      schema,
      ok: false,
      code: "does_not_match",
      message: `${escapeText(shown, 200)} was written, but its source does not evaluate to the score in the link${again.ok ? "" : `: ${escapeText(again.diagnostics[0]?.message ?? "", 200)}`}`,
    };
  return {
    schema,
    ok: true,
    dir: target,
    digest: read.digest,
    revision: read.revision,
    scoreVersion: read.scoreVersion,
    tracks: read.score.tracks.length,
    notes: read.score.notes.length,
    comments: read.comments.length,
    files: [
      ...files.map((file) => file.path),
      ...(read.comments.length > 0 ? [COMMENTS_FILE] : []),
    ],
    audio: await audioOf(read.score, target),
  };
}

export async function runOpenCommand(
  argv: readonly string[],
  cwd: string,
  stdout: Output,
  stderr: Output,
): Promise<number> {
  const parsed = parse(argv.slice(1), 2);
  if (parsed.kind === "help") {
    stdout.write(`${OPEN_USAGE}\n`);
    return 0;
  }
  const usage = OPEN_USAGE.split("\n")[0];
  if (parsed.kind === "error") {
    stderr.write(`${parsed.problem} · ${usage}\n`);
    return 2;
  }
  const [word, dir] = parsed.positionals;
  if (word === undefined) {
    stderr.write(`a link or a file with one in it · ${usage}\n`);
    return 2;
  }
  const report = await openLink(word, dir, cwd);
  if (parsed.json) stdout.write(`${JSON.stringify(report)}\n`);
  else if (report.ok) {
    const shown = relative(cwd, report.dir) || ".";
    stdout.write(
      `opened ${escapeText(shown, 200)} · ${plural(report.tracks, "track")}, ${plural(report.notes, "note")}, ${plural(report.files.length, "file")}${report.comments > 0 ? `, ${plural(report.comments, "comment")}` : ""}${report.scoreVersion < SCORE_VERSION ? ` · upgraded from score version ${report.scoreVersion} to ${SCORE_VERSION}` : ""}\n`,
    );
    const missing = report.audio.filter((file) => file.kind === "file");
    if (missing.length > 0)
      stderr.write(
        `${plural(missing.length, "audio file")} did not come with the link; ${missing.length === 1 ? "its track is" : "their tracks are"} silent until ${missing.length === 1 ? "it is" : "they are"} in place: ${missing.map((file) => escapeText(file.src, 120)).join(", ")}\n`,
      );
  } else stderr.write(`${report.message}\n`);
  return report.ok ? 0 : 1;
}

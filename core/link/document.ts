// SPDX-License-Identifier: MIT
/**
 * The score bytes of a link: one byte for the version of this byte format,
 * then one deterministic CBOR list of three: the length of the writer's table
 * of field names, the score's schema version, and the score as a map
 * (docs/design/project-link.md). This file turns a score into those bytes and
 * back. Nothing here knows about URLs, compression or digests.
 *
 * What the bytes hold is decided by the score's own loader, not by a second
 * schema kept beside it:
 *
 * - a field is left out when loading the score without it gives the same
 *   score (absent at default), so a field added later leaves old bytes alone;
 * - a decoded map is loaded by `scoreFromJSON`, written again, and refused
 *   unless the bytes come out the same (one spelling). That check is made
 *   at this build's score version only: an older score is upgraded by the
 *   loader (core/score-versions.ts) and has to load, no more.
 */
import {
  anchorProblem,
  commentId,
  eventLine,
  type CommentAnchor,
} from "../comments/events.ts";
import { scoreFromJSON, type TrackScore } from "../score.ts";
import {
  SCORE_VERSION,
  ScoreVersionError,
  scoreStepsFrom,
} from "../score-versions.ts";
import {
  CBOR_LIMITS,
  CborError,
  decodeCbor,
  encodeCbor,
  type CborLimits,
  type CborMap,
  type CborValue,
} from "./cbor.ts";
import { LINK_KEYS, linkKeyIndex } from "./keys.ts";

/**
 * The first byte: the version of the byte format (the list of three, the
 * rows, the tables). It is not the score's schema version, which is the
 * second element of the list and moves on its own.
 */
export const SCORE_BYTES_VERSION = 0x01;

/**
 * The shortest table of field names any writer has had. The table only grows
 * at its end (keys.ts), so a writer is known by how long its table was.
 */
export const FIRST_LINK_KEYS = 733;

/** Decoded score bytes may not be longer than this. */
export const MAX_SCORE_BYTES = 262_144;

/**
 * What one encode may spend judging defaults: values loaded, summed over
 * every load. The largest shipped demo spends about a tenth of it.
 */
export const MAX_JUDGING = 40_000_000;

const MAX_COMMENTS = 1024;
const MAX_COMMENT_TEXT = 4096;
const MAX_COMMENT_AUTHOR = 64;
const MAX_COMMENT_NOTES = 240;
const MAX_SAMPLES = 1024;
const MAX_SAMPLE_NAME = 512;

/**
 * What a comment is about, read in the revision the comment names:
 *
 * - `null`: the song;
 * - a track id: that track;
 * - `[track id, tick]`: a tick on a track;
 * - `[track id, tick, pitch]`: the note (or stack of identical notes) that
 *   starts there at that pitch;
 * - `[track id, [tick, end]]`: a range on a track, `end` past the last tick;
 * - `[null, [tick, end]]`: a range of the whole song.
 */
export type LinkTarget =
  | null
  | string
  | readonly [trackId: string, tick: number]
  | readonly [trackId: string, tick: number, pitch: number]
  | readonly [
      trackId: string | null,
      range: readonly [tick: number, end: number],
    ]
  /** Notes on a track, each `[start tick, length, pitch]`, in order. */
  | readonly [
      trackId: string,
      notes: readonly (readonly [
        tick: number,
        length: number,
        pitch: number,
      ])[],
    ];

export const LINK_COMMENT_STATES = ["open", "resolved", "deleted"] as const;
export type LinkCommentState = (typeof LINK_COMMENT_STATES)[number];

/**
 * A comment carried as data: the folded state of one comment, not the lines
 * that made it. dawn link writes rows from a project's folded comments.
 */
export type LinkComment = Readonly<{
  /** 16 bytes, made by whoever wrote the comment. */
  id: Uint8Array;
  target: LinkTarget;
  /** Empty when, and only when, the comment is deleted. */
  text: string;
  /** The writer's handle. */
  author?: string;
  /** Seconds since 1970, UTC, by the writer's clock. */
  time?: number;
  /** The id of the first comment of the thread this one replies in. */
  thread?: Uint8Array;
  /** `open` when absent. */
  state?: LinkCommentState;
  /**
   * The revision digest (32 bytes) the comment was written against, when
   * that is not the score in this link. No bytes at all: written against a
   * revision nobody recorded, so not known to be this one.
   */
  revision?: Uint8Array;
  /** Original placement when the target alone loses names, bars or retained data. */
  anchor?: Omit<CommentAnchor, "rev">;
}>;

/** One audio file the score plays, by content. Reserved: nothing writes one yet. */
export type LinkSample = Readonly<{
  /** The project path or pack name. */
  name: string;
  /** 32 bytes. */
  sha256: Uint8Array;
  /** The file's length in bytes. */
  bytes: number;
}>;

export type ScoreDocument = Readonly<{
  score: TrackScore;
  comments?: readonly LinkComment[];
  samples?: readonly LinkSample[];
}>;

/**
 * What score bytes held, how long their writer's table of field names was,
 * and the score version they were written at (the score here is current).
 */
export type ReadDocument = ScoreDocument &
  Readonly<{ keys: number; version: number }>;

export type DocumentFault =
  "unsupported_score_version" | "not_canonical" | "invalid_score";

export class DocumentError extends Error {
  readonly fault: DocumentFault;
  constructor(fault: DocumentFault, message: string) {
    super(message);
    this.name = "DocumentError";
    this.fault = fault;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** This build's table. Only `withLinkKeys` ever puts another in its place. */
let table: readonly string[] = LINK_KEYS;
let tableIndex = linkKeyIndex;

/**
 * Runs `work` as a build whose table of field names is `names` would: for
 * tests of what happens to old bytes once the table has grown. `names` must
 * begin with this build's table.
 */
export function withLinkKeys<T>(names: readonly string[], work: () => T): T {
  if (LINK_KEYS.some((name, index) => names[index] !== name))
    throw new Error("a table that does not begin with this build's");
  const index = new Map(names.map((name, at) => [name, at]));
  const before = [table, tableIndex] as const;
  table = names;
  tableIndex = (name) => index.get(name);
  try {
    return work();
  } finally {
    [table, tableIndex] = before;
  }
}

const KEY_COMMENTS = linkKeyIndex("linkComments")!;
const KEY_SAMPLES = linkKeyIndex("linkSamples")!;
const KEY_NOTES = linkKeyIndex("notes")!;
const KEY_TRACKS = linkKeyIndex("tracks")!;
const KEY_ID = linkKeyIndex("id")!;
if (KEY_COMMENTS >= FIRST_LINK_KEYS || KEY_SAMPLES >= FIRST_LINK_KEYS)
  throw new Error(
    "comments and samples have had numbers since the first table",
  );

/** The six note fields a row's first four elements and its place carry. */
const ROW_FIELDS = new Set([
  "id",
  "trackId",
  "startTick",
  "durationTicks",
  "pitch",
  "velocity",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sets an own property, whatever the name (`__proto__` included). */
function put(target: JsonObject, key: string, value: Json) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A plain copy with every text and field name in NFC. */
function plain(value: unknown): Json {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new DocumentError("invalid_score", "a number that is not finite");
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) put(out, key.normalize("NFC"), plain(item));
    return out;
  }
  throw new DocumentError("invalid_score", "a value a score cannot hold");
}

/** JSON text with every object's names in order, for comparing two scores. */
function stable(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function load(data: JsonObject): TrackScore {
  try {
    return scoreFromJSON(data);
  } catch (error) {
    throw new DocumentError(
      "invalid_score",
      error instanceof Error ? error.message : "the score did not load",
    );
  }
}

/**
 * An automation point. A list of them is taken as written: a point has a
 * tick and a value and no default for either, and a song has thousands, so
 * asking the loader about each would cost more than everything else.
 */
function isPoint(value: Json): boolean {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    typeof value.tick === "number" &&
    typeof value.value === "number"
  );
}

/**
 * Removes every field the loader would put back: each name in turn, in
 * order, a whole value before its parts. `same` says whether the score still
 * loads to what it was. Values in `done` are left as they are.
 */
function dropDefaults(
  node: Json,
  same: () => boolean,
  done?: ReadonlySet<Json>,
): void {
  if (done?.has(node)) return;
  if (Array.isArray(node)) {
    if (node.every(isPoint)) return;
    for (const item of node)
      if (typeof item === "object" && item !== null)
        dropDefaults(item, same, done);
    return;
  }
  if (!isObject(node)) return;
  for (const key of Object.keys(node).sort()) {
    const value = node[key]!;
    delete node[key];
    if (same()) continue;
    put(node, key, value);
    if (typeof value !== "object" || value === null) continue;
    dropDefaults(value, same, done);
    if (isObject(value) && Object.keys(value).length === 0) {
      delete node[key];
      if (!same()) put(node, key, value);
    }
  }
}

/** How many values `value` holds, itself included. */
function size(value: Json): number {
  if (Array.isArray(value))
    return value.reduce((sum: number, item) => sum + size(item), 1);
  if (isObject(value))
    return Object.values(value).reduce(
      (sum: number, item) => sum + size(item),
      1,
    );
  return 1;
}

/** The song's fields a track is read against when it is loaded alone. */
const TRACK_CONTEXT = [
  "tempoBpm",
  "beatsPerBar",
  "bars",
  "ticksPerBeat",
  "key",
  "time",
  "tuning",
  "patches",
];

/**
 * The score's fields with the defaults gone, notes aside. Three passes, each
 * one the same rule with a cheaper question, so a song is done in a fraction
 * of a second instead of several:
 *
 * 1. a track that loads on its own is judged on its own;
 * 2. everything else is judged against the whole score without its notes;
 * 3. the result is checked with the notes. A score that fails the check is
 *    done again against the whole score, notes and all.
 */
function withoutDefaults(
  whole: JsonObject,
  notes: Json[],
  judging: number,
): JsonObject {
  const wanted = stable(whole);
  const fresh = () => {
    const body = plain(whole) as JsonObject;
    delete body.notes;
    return body;
  };
  // Judging a field costs a load of the score or of one track. A real song
  // spends a few million of these units; a score built to spend without
  // end is refused, so reading a link is bounded in time as well as in size.
  let spent = 0;
  const spend = (units: number) => {
    spent += units;
    if (spent > judging)
      throw new DocumentError(
        "invalid_score",
        "the score has more fields to judge than a link allows",
      );
  };
  const wholeSize = size(whole);
  const loads = (body: JsonObject, withNotes: Json[]) => {
    spend(wholeSize);
    try {
      const trial = scoreFromJSON({ ...body, notes: withNotes });
      return stable(trial.toJSON() as unknown as Json);
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      return undefined;
    }
  };

  let body = fresh();
  const bare = loads(body, []);
  if (bare !== undefined) {
    const context: JsonObject = {};
    for (const key of TRACK_CONTEXT)
      if (body[key] !== undefined) put(context, key, body[key]!);
    const done = new Set<Json>();
    for (const track of (body.tracks ?? []) as Json[]) {
      const trackSize = size(track);
      const alone = () => {
        spend(trackSize);
        try {
          const trial = scoreFromJSON({ ...context, tracks: [track] });
          return stable(trial.tracks[0] as unknown as Json);
        } catch (error) {
          if (error instanceof DocumentError) throw error;
          return undefined;
        }
      };
      const was = alone();
      if (was === undefined) continue;
      dropDefaults(track, () => alone() === was);
      done.add(track);
    }
    dropDefaults(body, () => loads(body, []) === bare, done);
    if (loads(body, notes) === wanted) return body;
    body = fresh();
  }
  dropDefaults(body, () => loads(body, notes) === wanted);
  if (loads(body, notes) !== wanted)
    throw new DocumentError("invalid_score", "the score does not load back");
  return body;
}

/**
 * `keys` is the length of the writer's table: a name has a number for that
 * writer when its place in the table is below it, and is text when not.
 */
function toCbor(value: Json, keys: number): CborValue {
  if (Array.isArray(value)) return value.map((item) => toCbor(item, keys));
  if (isObject(value)) {
    const map = new Map<number | string, CborValue>();
    for (const key of Object.keys(value)) {
      const index = tableIndex(key);
      map.set(
        index !== undefined && index < keys ? index : key,
        toCbor(value[key]!, keys),
      );
    }
    return map;
  }
  return value;
}

function fromCbor(value: CborValue, keys: number): Json {
  if (value instanceof Uint8Array)
    throw new DocumentError("invalid_score", "bytes where a score has none");
  if (Array.isArray(value)) return value.map((item) => fromCbor(item, keys));
  if (value instanceof Map) {
    const out: JsonObject = {};
    for (const [key, item] of value as CborMap)
      put(out, fieldName(key, keys), fromCbor(item, keys));
    return out;
  }
  return value as Json;
}

/**
 * The name a key stands for, read as its writer wrote it. A name the writer
 * had no number for is text, and stays readable as text after the table has
 * grown to hold it; a name the writer did have a number for is never text.
 */
function fieldName(key: number | string, keys: number): string {
  if (typeof key === "number") {
    if (key >= keys)
      throw new DocumentError(
        "invalid_score",
        `field number ${key} in a table of ${keys}`,
      );
    const name = table[key];
    if (name === undefined)
      throw new DocumentError(
        "unsupported_score_version",
        `field number ${key}, from a newer DAWN than this one`,
      );
    return name;
  }
  const index = tableIndex(key);
  if (index !== undefined && index < keys)
    throw new DocumentError(
      "not_canonical",
      "a field written by name that has a number",
    );
  return key;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * A note as a row. Velocity is an integer count of thousandths when that is
 * exact, which it is for every velocity the SDK writes, and the number
 * itself, a float, when it is not, so no velocity is rounded.
 *
 * Rows stand in the score's own note order (start, then pitch, then the
 * order the notes were written in). Ids are not carried; the reader assigns
 * new ones that sort the same way, so notes that tie keep their order.
 */
function noteRow(note: JsonObject, keys: number): CborValue[] {
  const raw = note.velocity as number;
  const thousandths = Math.round(raw * 1000);
  const row: CborValue[] = [
    note.startTick as number,
    note.durationTicks as number,
    note.pitch as number,
    thousandths / 1000 === raw ? thousandths : raw,
  ];
  const rest: JsonObject = {};
  let any = false;
  for (const key of Object.keys(note))
    if (!ROW_FIELDS.has(key)) {
      put(rest, key, note[key]!);
      any = true;
    }
  if (any) row.push(toCbor(rest, keys));
  return row;
}

const hexOf = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const isTick = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The target as it is written, or a DocumentError. */
function targetCbor(
  target: LinkTarget,
  trackIds: ReadonlySet<string>,
): CborValue {
  const nowhere = () =>
    new DocumentError("invalid_score", "a comment on no place");
  const track = (id: unknown): string => {
    if (typeof id !== "string") throw nowhere();
    const nfc = id.normalize("NFC");
    if (!trackIds.has(nfc))
      throw new DocumentError("invalid_score", "a comment on a missing track");
    return nfc;
  };
  if (target === null) return null;
  if (typeof target === "string") return track(target);
  if (!Array.isArray(target)) throw nowhere();
  const [first, second, third] = target as readonly unknown[];
  if (Array.isArray(second) && Array.isArray(second[0])) {
    // Note rows, in one order so a set of notes has one spelling.
    const rows = second as readonly unknown[];
    if (target.length !== 2 || rows.length > MAX_COMMENT_NOTES) throw nowhere();
    let last: readonly number[] | undefined;
    const out: CborValue[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 3) throw nowhere();
      const [tick, length, pitch] = row as readonly unknown[];
      if (!isTick(tick) || !isTick(length) || !isTick(pitch) || pitch > 127)
        throw nowhere();
      const here = [tick, pitch, length];
      if (last) {
        const order =
          here[0]! - last[0]! || here[1]! - last[1]! || here[2]! - last[2]!;
        if (order <= 0)
          throw new DocumentError(
            "invalid_score",
            "a comment's notes are in order, each once",
          );
      }
      last = here;
      out.push([tick, length, pitch]);
    }
    return [track(first), out];
  }
  if (Array.isArray(second)) {
    const [tick, end] = second as readonly unknown[];
    if (
      target.length !== 2 ||
      second.length !== 2 ||
      !isTick(tick) ||
      !isTick(end) ||
      end <= tick
    )
      throw nowhere();
    return [first === null ? null : track(first), [tick, end]];
  }
  if (!isTick(second)) throw nowhere();
  if (target.length === 2) return [track(first), second];
  if (
    target.length !== 3 ||
    typeof third !== "number" ||
    !Number.isInteger(third) ||
    third < 0 ||
    third > 127
  )
    throw nowhere();
  return [track(first), second, third];
}

/**
 * Comment rows: `[id, target, text, author, time, thread, state, revision, anchor]`
 * with every element at its default dropped from the end (no revision, state
 * open, no thread, no time, no author), so a plain comment is three long.
 */
function commentsCbor(
  comments: readonly LinkComment[],
  trackIds: ReadonlySet<string>,
  keys: number,
): CborValue[] {
  if (comments.length > MAX_COMMENTS)
    throw new DocumentError("invalid_score", "more comments than a link holds");
  const bad = (message: string) => new DocumentError("invalid_score", message);
  const ids = new Set<string>();
  const firsts = new Set<string>();
  for (const comment of comments) {
    if (!(comment.id instanceof Uint8Array) || comment.id.length !== 16)
      throw bad("a comment id is 16 bytes");
    const id = hexOf(comment.id);
    if (ids.has(id)) throw bad("a comment listed twice");
    ids.add(id);
    if (comment.thread === undefined) firsts.add(id);
  }
  return comments.map((comment) => {
    const { text, author, time, thread, revision } = comment;
    const state = comment.state ?? "open";
    const stateIndex = LINK_COMMENT_STATES.indexOf(state);
    if (stateIndex < 0) throw bad("a comment in no known state");
    if (typeof text !== "string") throw bad("a comment with no text");
    if ((text.length === 0) !== (state === "deleted"))
      throw bad(
        state === "deleted"
          ? "a deleted comment keeps no text"
          : "a comment with no text",
      );
    // Counted in characters (code points), as comments.jsonl counts them.
    if (text.length > MAX_COMMENT_TEXT && [...text].length > MAX_COMMENT_TEXT)
      throw bad("a comment that is too long");
    if (
      author !== undefined &&
      (typeof author !== "string" ||
        author.length === 0 ||
        author.length > MAX_COMMENT_AUTHOR)
    )
      throw bad("a comment's author is a handle");
    if (time !== undefined && (!isTick(time) || time > 253_402_300_799))
      throw bad("a comment's time is a count of seconds");
    if (thread !== undefined) {
      if (!(thread instanceof Uint8Array) || thread.length !== 16)
        throw bad("a comment's thread is a comment id");
      if (!firsts.has(hexOf(thread)))
        throw bad("a reply to no first comment in this link");
    }
    if (
      revision !== undefined &&
      (!(revision instanceof Uint8Array) ||
        (revision.length !== 32 && revision.length !== 0))
    )
      throw bad("a comment's revision is 32 bytes, or none");
    if (comment.anchor !== undefined) {
      const problem = anchorProblem(comment.anchor);
      if (problem || "rev" in comment.anchor)
        throw bad(
          `a comment's retained anchor is invalid${problem ? `: ${problem}` : ""}`,
        );
      try {
        eventLine({
          v: 1,
          id: commentId(comment.id),
          kind: "add",
          at: new Date((time ?? 0) * 1000).toISOString(),
          text,
          author,
          anchor: { ...comment.anchor, rev: "A".repeat(43) },
        });
      } catch {
        throw bad("a comment's retained anchor is too long for a comment line");
      }
    }
    const row: CborValue[] = [
      comment.id.slice(),
      targetCbor(comment.target, trackIds),
      text.normalize("NFC"),
      author === undefined ? null : author.normalize("NFC"),
      time ?? null,
      thread === undefined ? null : thread.slice(),
      stateIndex,
      revision === undefined ? null : revision.slice(),
      comment.anchor === undefined
        ? null
        : toCbor(comment.anchor as JsonObject, keys),
    ];
    while (row.length > 3) {
      const last = row[row.length - 1];
      if (last !== null && !(row.length === 7 && last === 0)) break;
      row.pop();
    }
    return row;
  });
}

function samplesCbor(samples: readonly LinkSample[]): CborValue[] {
  if (samples.length > MAX_SAMPLES)
    throw new DocumentError("invalid_score", "more samples than a link holds");
  const utf8 = new TextEncoder();
  const rows = samples.map(({ name, sha256, bytes }) => {
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > MAX_SAMPLE_NAME
    )
      throw new DocumentError("invalid_score", "a sample with no usable name");
    if (!(sha256 instanceof Uint8Array) || sha256.length !== 32)
      throw new DocumentError("invalid_score", "a sample hash is 32 bytes");
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0)
      throw new DocumentError("invalid_score", "a sample length is a count");
    const nfc = name.normalize("NFC");
    return { key: utf8.encode(nfc), cbor: [nfc, sha256.slice(), bytes] };
  });
  rows.sort((a, b) => compareBytes(a.key, b.key));
  for (let i = 1; i < rows.length; i += 1)
    if (compareBytes(rows[i - 1]!.key, rows[i]!.key) === 0)
      throw new DocumentError("invalid_score", "a sample listed twice");
  return rows.map((row) => row.cbor);
}

/**
 * The score bytes of `document`: the version byte and the one CBOR spelling.
 * Throws a DocumentError (`invalid_score`) for a score that cannot be
 * written; never anything else. `judging` is the work it may spend finding
 * the defaults (MAX_JUDGING). `keys` is the length of the table of field
 * names to write with: this build's own, unless the bytes of an earlier or
 * later writer are being written again.
 */
export function encodeScoreBytes(
  document: ScoreDocument,
  limits: CborLimits = CBOR_LIMITS,
  judging: number = MAX_JUDGING,
  keys: number = table.length,
): Uint8Array {
  try {
    if (!Number.isSafeInteger(keys) || keys < FIRST_LINK_KEYS)
      throw new DocumentError("invalid_score", "no table was that short");
    return encode(document, limits, judging, keys);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if (error instanceof CborError)
      throw new DocumentError("invalid_score", error.message);
    throw new DocumentError(
      "invalid_score",
      error instanceof Error ? error.message : "the score could not be written",
    );
  }
}

function encode(
  document: ScoreDocument,
  limits: CborLimits,
  judging: number,
  keys: number,
): Uint8Array {
  // NFC first, then through the loader, so what is measured below is the
  // score the receiver will hold.
  const score = load(plain(document.score.toJSON()) as JsonObject);
  const whole = plain(score.toJSON()) as JsonObject;
  const notes = (whole.notes ?? []) as JsonObject[];
  const body = withoutDefaults(whole, notes, judging);

  const rows = new Map<string, CborValue[][]>();
  for (const note of notes) {
    const trackId = note.trackId as string;
    let list = rows.get(trackId);
    if (!list) rows.set(trackId, (list = []));
    list.push(noteRow(note, keys));
  }
  // The version is the list's second element and nowhere in the map.
  delete body.version;
  const top = toCbor(body, keys) as Map<number | string, CborValue>;
  const tracks = (top.get(KEY_TRACKS) ?? []) as Map<
    number | string,
    CborValue
  >[];
  const trackIds = new Set<string>();
  score.tracks.forEach((track, index) => {
    trackIds.add(track.id);
    const list = rows.get(track.id);
    if (!list) return;
    tracks[index]!.set(KEY_NOTES, list);
  });
  if (document.comments && document.comments.length > 0)
    top.set(KEY_COMMENTS, commentsCbor(document.comments, trackIds, keys));
  if (document.samples && document.samples.length > 0)
    top.set(KEY_SAMPLES, samplesCbor(document.samples));

  const cbor = encodeCbor([keys, SCORE_VERSION, top], limits);
  const out = new Uint8Array(cbor.length + 1);
  out[0] = SCORE_BYTES_VERSION;
  out.set(cbor, 1);
  return out;
}

function readTarget(where: CborValue): LinkTarget {
  if (where === null || typeof where === "string") return where;
  if (Array.isArray(where)) {
    const [first, second, third] = where as CborValue[];
    if (
      where.length === 2 &&
      typeof first === "string" &&
      Array.isArray(second) &&
      second.length > 0 &&
      second.every(
        (row) =>
          Array.isArray(row) &&
          row.length === 3 &&
          row.every((item) => typeof item === "number"),
      )
    )
      return Object.freeze([
        first,
        Object.freeze(
          (second as number[][]).map((row) =>
            Object.freeze([row[0]!, row[1]!, row[2]!] as const),
          ),
        ),
      ] as const);
    if (
      where.length === 2 &&
      (first === null || typeof first === "string") &&
      Array.isArray(second) &&
      second.length === 2 &&
      typeof second[0] === "number" &&
      typeof second[1] === "number"
    )
      return Object.freeze([
        first,
        Object.freeze([second[0], second[1]] as const),
      ] as const);
    if (typeof first === "string" && typeof second === "number") {
      if (where.length === 2) return Object.freeze([first, second] as const);
      if (where.length === 3 && typeof third === "number")
        return Object.freeze([first, second, third] as const);
    }
  }
  throw new DocumentError("invalid_score", "a comment on no place");
}

/** The rows as comments. What they may hold is judged by `commentsCbor`. */
function readComments(value: CborValue, keys: number): LinkComment[] {
  if (!Array.isArray(value))
    throw new DocumentError("invalid_score", "comments are a list");
  const bad = (message: string) => new DocumentError("invalid_score", message);
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 3 || entry.length > 9)
      throw bad("a comment is an id, a place and text");
    const [id, where, text, author, time, thread, state, revision, retained] =
      entry as (CborValue | undefined)[];
    if (!(id instanceof Uint8Array)) throw bad("a comment id is 16 bytes");
    if (typeof text !== "string") throw bad("a comment's text is text");
    if (author != null && typeof author !== "string")
      throw bad("a comment's author is a handle");
    if (time != null && typeof time !== "number")
      throw bad("a comment's time is a count of seconds");
    if (thread != null && !(thread instanceof Uint8Array))
      throw bad("a comment's thread is a comment id");
    if (state !== undefined && typeof state !== "number")
      throw bad("a comment in no known state");
    const named = LINK_COMMENT_STATES[state ?? 0];
    if (named === undefined) throw bad("a comment in no known state");
    if (revision != null && !(revision instanceof Uint8Array))
      throw bad("a comment's revision is 32 bytes");
    const anchor = retained == null ? undefined : fromCbor(retained, keys);
    if (
      anchor !== undefined &&
      (!isObject(anchor) || anchorProblem(anchor) || "rev" in anchor)
    )
      throw bad("a comment's retained anchor is invalid");
    return Object.freeze({
      id,
      target: readTarget(where!),
      text,
      ...(author != null ? { author } : {}),
      ...(time != null ? { time } : {}),
      ...(thread != null ? { thread } : {}),
      ...(named !== "open" ? { state: named } : {}),
      ...(revision != null ? { revision } : {}),
      ...(anchor !== undefined
        ? { anchor: anchor as Omit<CommentAnchor, "rev"> }
        : {}),
    });
  });
}

function readSamples(value: CborValue): LinkSample[] {
  if (!Array.isArray(value))
    throw new DocumentError("invalid_score", "samples are a list");
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 3)
      throw new DocumentError(
        "invalid_score",
        "a sample is a name, a hash and a length",
      );
    const [name, sha256, bytes] = entry as [CborValue, CborValue, CborValue];
    if (
      typeof name !== "string" ||
      !(sha256 instanceof Uint8Array) ||
      typeof bytes !== "number"
    )
      throw new DocumentError(
        "invalid_score",
        "a sample is a name, a hash and a length",
      );
    return Object.freeze({ name, sha256, bytes });
  });
}

/** The notes of one track's rows, with ids assigned in row order. */
function readRows(
  trackId: string,
  value: CborValue,
  out: JsonObject[],
  keys: number,
) {
  if (!Array.isArray(value))
    throw new DocumentError("invalid_score", "a track's notes are rows");
  const width = String(value.length).length;
  value.forEach((row, index) => {
    if (!Array.isArray(row) || (row.length !== 4 && row.length !== 5))
      throw new DocumentError("invalid_score", "a note row has four numbers");
    const [start, length, pitch, velocity, extras] = row as CborValue[];
    if (
      typeof start !== "number" ||
      typeof length !== "number" ||
      typeof pitch !== "number" ||
      typeof velocity !== "number"
    )
      throw new DocumentError("invalid_score", "a note row has four numbers");
    const note: JsonObject = {};
    if (extras !== undefined) {
      if (!(extras instanceof Map) || extras.size === 0)
        throw new DocumentError(
          "not_canonical",
          "a note row's fifth element is a map with something in it",
        );
      for (const [key, item] of extras as CborMap) {
        const name = fieldName(key, keys);
        if (ROW_FIELDS.has(name))
          throw new DocumentError(
            "not_canonical",
            "a note field written twice",
          );
        put(note, name, fromCbor(item, keys));
      }
    }
    note.id = `${trackId}:${String(index).padStart(width, "0")}`;
    note.trackId = trackId;
    note.startTick = start;
    note.durationTicks = length;
    note.pitch = pitch;
    note.velocity = Number.isInteger(velocity) ? velocity / 1000 : velocity;
    out.push(note);
  });
}

/**
 * The score in `bytes`. Throws a DocumentError; never anything else.
 * `bytes` are the score bytes whole: the version byte first.
 */
export function decodeScoreBytes(
  bytes: Uint8Array,
  limits: CborLimits = CBOR_LIMITS,
): ReadDocument {
  try {
    return decode(bytes, limits);
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    if (error instanceof CborError)
      throw new DocumentError(
        error.fault === "not_canonical" ? "not_canonical" : "invalid_score",
        error.message,
      );
    throw new DocumentError(
      "invalid_score",
      error instanceof Error ? error.message : "the score did not load",
    );
  }
}

function decode(bytes: Uint8Array, limits: CborLimits): ReadDocument {
  if (bytes.length > MAX_SCORE_BYTES)
    throw new DocumentError("invalid_score", "more score bytes than the bound");
  if (bytes.length === 0)
    throw new DocumentError("invalid_score", "no score bytes");
  if (bytes[0] !== SCORE_BYTES_VERSION)
    throw new DocumentError(
      "unsupported_score_version",
      `score bytes version ${bytes[0]}`,
    );
  const list = decodeCbor(bytes.subarray(1), limits);
  if (!Array.isArray(list) || list.length !== 3)
    throw new DocumentError(
      "invalid_score",
      "not a table length, a score version and a score",
    );
  const [keys, version, top] = list as [CborValue, CborValue, CborValue];
  if (
    typeof keys !== "number" ||
    !Number.isSafeInteger(keys) ||
    keys < FIRST_LINK_KEYS
  )
    throw new DocumentError("invalid_score", "no table was that short");
  try {
    scoreStepsFrom(version);
  } catch (error) {
    if (!(error instanceof ScoreVersionError)) throw error;
    // Newer than this build knows is its own answer; anything else is
    // not a version any DAWN wrote.
    throw new DocumentError(
      error.fault === "newer" ? "unsupported_score_version" : "invalid_score",
      error.fault === "newer"
        ? `score version ${String(version)}, from a newer DAWN than this one`
        : "no score version was that",
    );
  }
  if (!(top instanceof Map))
    throw new DocumentError("invalid_score", "the score is not a map");
  const map = new Map(top as CborMap);
  const comments = map.has(KEY_COMMENTS)
    ? readComments(map.get(KEY_COMMENTS)!, keys)
    : [];
  const samples = map.has(KEY_SAMPLES)
    ? readSamples(map.get(KEY_SAMPLES)!)
    : [];
  map.delete(KEY_COMMENTS);
  map.delete(KEY_SAMPLES);
  if (map.has(KEY_NOTES))
    throw new DocumentError("not_canonical", "notes outside their tracks");

  const notes: JsonObject[] = [];
  const tracks = map.get(KEY_TRACKS);
  if (tracks !== undefined) {
    if (!Array.isArray(tracks))
      throw new DocumentError("invalid_score", "tracks are a list");
    map.set(
      KEY_TRACKS,
      tracks.map((track) => {
        if (!(track instanceof Map)) return track;
        const rows = track.get(KEY_NOTES);
        if (rows === undefined) return track;
        const id = track.get(KEY_ID);
        if (typeof id !== "string")
          throw new DocumentError("invalid_score", "a track with no id");
        readRows(id, rows, notes, keys);
        const rest = new Map(track as CborMap);
        rest.delete(KEY_NOTES);
        return rest;
      }),
    );
  }
  const data = fromCbor(map, keys) as JsonObject;
  if (Object.hasOwn(data, "version"))
    throw new DocumentError(
      "not_canonical",
      "the score version written a second time",
    );
  put(data, "notes", notes);
  // The loader runs the steps an older score needs before it validates.
  put(data, "version", version as number);
  const score = load(data);
  // Comments belong to the byte format, not to a score version: they are
  // judged whatever version the score was written at.
  commentsCbor(comments, new Set(score.tracks.map((track) => track.id)), keys);
  const document: ReadDocument = Object.freeze({
    score,
    comments: Object.freeze(comments),
    samples: Object.freeze(samples),
    keys,
    version: version as number,
  });
  // An older score was written the one way its own version had, which this
  // build no longer knows how to write: it has loaded, and that is the test.
  if (version !== SCORE_VERSION) return document;
  // One spelling: what was read is written again and must be the same bytes.
  const again = encodeScoreBytes(document, limits, MAX_JUDGING, keys);
  if (compareBytes(again, bytes) !== 0)
    throw new DocumentError(
      "not_canonical",
      "the score is not written the one way it can be",
    );
  return document;
}

/**
 * The score bytes with the comments left out and everything else, the
 * samples table included, as it was: the bytes a revision digest is taken
 * over. `bytes` themselves when they hold no comments. `bytes` must be score
 * bytes that `decodeScoreBytes` accepts.
 */
export function revisionBytes(
  bytes: Uint8Array,
  limits: CborLimits = CBOR_LIMITS,
): Uint8Array {
  const list = decodeCbor(bytes.subarray(1), limits) as CborValue[];
  const top = list[2] as CborMap;
  if (!top.has(KEY_COMMENTS)) return bytes;
  const rest = new Map(top);
  rest.delete(KEY_COMMENTS);
  const cbor = encodeCbor([list[0]!, list[1]!, rest], limits);
  const out = new Uint8Array(cbor.length + 1);
  out[0] = bytes[0]!;
  out.set(cbor, 1);
  return out;
}

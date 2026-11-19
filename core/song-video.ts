// SPDX-License-Identifier: MIT
/**
 * A song's authored music video (`video()` in song.ts, SDK 1.52.0), stored
 * as the optional `video` field of the score. Shape checks only, as for
 * `style`: names are checked against the video catalog when the score is
 * rendered (src/video/resolve.ts), so a project naming a model this build's
 * catalog lacks still loads and plays.
 */

export type SongVideo = Readonly<{ schema: "dawn.video/v1" }> &
  Readonly<Record<string, unknown>>;

/** Largest `video` record, in bytes of JSON (the SDK's `VIDEO_MAX_BYTES`). */
export const MAX_VIDEO_BYTES = 4096;

const KEYS = new Set([
  "schema",
  "palette",
  "time",
  "weather",
  "ground",
  "fog",
  "seed",
  "motif",
  "money",
  "title",
  "moments",
  "cast",
  "sections",
  "props",
  "archive",
  "story",
  "dialect",
  "type",
  "looks",
  "roles",
  "crowd",
  "setPiece",
  "talk",
]);

/** Thrown for a malformed `video`; the score turns it into a validation error. */
export class SongVideoError extends Error {
  override name = "SongVideoError";
}

function freeze(value: unknown, depth: number): unknown {
  if (depth > 6) throw new SongVideoError("video is nested too deeply");
  if (Array.isArray(value))
    return Object.freeze(value.map((v) => freeze(v, depth + 1)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      if (v !== undefined) out[k] = freeze(v, depth + 1);
    return Object.freeze(out);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new SongVideoError("video holds a value that is not JSON");
}

/** A frozen, checked video record; `null`/`undefined` is none. */
export function normalizeSongVideo(value: unknown): SongVideo | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new SongVideoError("video must come from video({ ... })");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!KEYS.has(key))
      throw new SongVideoError(`video has no field ${JSON.stringify(key)}`);
  const video = freeze({ ...record, schema: "dawn.video/v1" }, 0) as SongVideo;
  const bytes = JSON.stringify(video).length;
  if (bytes > MAX_VIDEO_BYTES)
    throw new SongVideoError(
      `video is ${bytes} bytes of JSON; at most ${MAX_VIDEO_BYTES}`,
    );
  return video;
}
